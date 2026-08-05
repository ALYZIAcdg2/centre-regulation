const HTML_CHUNK_SIZE = 80000;
const MAX_HTML_SIZE = 15 * 1024 * 1024;
const MAX_STATE_SIZE = 15 * 1024 * 1024;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url);
    }

    if (
      request.method === "GET" &&
      (url.pathname === "/" || url.pathname === "/index.html")
    ) {
      const active = await getActiveHtml(env);
      if (active) {
        return new Response(active.html, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store, no-cache, must-revalidate",
            "x-app-version": active.version,
          },
        });
      }
    }

    return env.ASSETS.fetch(request);
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function ensureTables(env) {
  if (!env.DB) {
    throw new Error("Le binding D1 DB est absent du Worker.");
  }

  // Exécution séquentielle : plus fiable lors de la première création D1.
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS app_state (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS app_html_versions (
      id TEXT PRIMARY KEY,
      file_name TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      chunk_count INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 0
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS app_html_chunks (
      version_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      PRIMARY KEY(version_id, chunk_index)
    )
  `).run();

  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_app_html_active
    ON app_html_versions(is_active, created_at)
  `).run();
}

function getAdminSecret(env) {
  return String(env.ADMIN_PASSWORD || env.UPDATE_PASSWORD || "");
}

function isAuthorized(request, env, password = "") {
  const expected = getAdminSecret(env);
  const supplied = String(
    password ||
      request.headers.get("x-admin-password") ||
      request.headers.get("x-update-password") ||
      ""
  );

  return expected.length >= 8 && supplied === expected;
}

async function getActiveHtml(env) {
  try {
    await ensureTables(env);

    const version = await env.DB.prepare(`
      SELECT id
      FROM app_html_versions
      WHERE is_active = 1
      ORDER BY created_at DESC
      LIMIT 1
    `).first();

    if (!version) return null;

    const rows = await env.DB.prepare(`
      SELECT content
      FROM app_html_chunks
      WHERE version_id = ?
      ORDER BY chunk_index ASC
    `).bind(version.id).all();

    const html = (rows.results || []).map((row) => row.content || "").join("");
    return html ? { html, version: version.id } : null;
  } catch (error) {
    console.error("getActiveHtml", error);
    return null;
  }
}

async function saveHtmlVersion(env, html, fileName) {
  await ensureTables(env);

  const versionId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const chunks = [];

  for (let index = 0; index < html.length; index += HTML_CHUNK_SIZE) {
    chunks.push(html.slice(index, index + HTML_CHUNK_SIZE));
  }

  try {
    await env.DB.prepare(`
      INSERT INTO app_html_versions (
        id, file_name, byte_size, chunk_count, created_at, is_active
      ) VALUES (?, ?, ?, ?, ?, 0)
    `).bind(
      versionId,
      fileName || "index.html",
      new TextEncoder().encode(html).byteLength,
      chunks.length,
      createdAt
    ).run();
  } catch (error) {
    throw new Error("Création de la version impossible : " + error.message);
  }

  try {
    // Petits lots afin d'éviter les limites D1.
    for (let offset = 0; offset < chunks.length; offset += 10) {
      const statements = chunks.slice(offset, offset + 10).map((content, i) =>
        env.DB.prepare(`
          INSERT INTO app_html_chunks(version_id, chunk_index, content)
          VALUES (?, ?, ?)
        `).bind(versionId, offset + i, content)
      );
      await env.DB.batch(statements);
    }
  } catch (error) {
    await env.DB.prepare(
      "DELETE FROM app_html_chunks WHERE version_id = ?"
    ).bind(versionId).run().catch(() => {});
    await env.DB.prepare(
      "DELETE FROM app_html_versions WHERE id = ?"
    ).bind(versionId).run().catch(() => {});
    throw new Error("Enregistrement du contenu HTML impossible : " + error.message);
  }

  try {
    await env.DB.prepare(
      "UPDATE app_html_versions SET is_active = 0"
    ).run();

    await env.DB.prepare(
      "UPDATE app_html_versions SET is_active = 1 WHERE id = ?"
    ).bind(versionId).run();
  } catch (error) {
    throw new Error("Activation de la nouvelle version impossible : " + error.message);
  }

  // Nettoyage non bloquant : conserve les trois versions les plus récentes.
  try {
    const old = await env.DB.prepare(`
      SELECT id
      FROM app_html_versions
      WHERE id NOT IN (
        SELECT id
        FROM app_html_versions
        ORDER BY created_at DESC
        LIMIT 3
      )
    `).all();

    for (const row of old.results || []) {
      await env.DB.prepare(
        "DELETE FROM app_html_chunks WHERE version_id = ?"
      ).bind(row.id).run();

      await env.DB.prepare(
        "DELETE FROM app_html_versions WHERE id = ?"
      ).bind(row.id).run();
    }
  } catch (error) {
    console.error("Nettoyage des anciennes versions ignoré :", error);
  }

  return { id: versionId, createdAt };
}

async function handleApi(request, env, url) {
  try {
    await ensureTables(env);

    if (url.pathname === "/api/health" && request.method === "GET") {
      const result = await env.DB.prepare("SELECT 1 AS ok").first();
      return json({
        ok: result?.ok === 1,
        database: Boolean(env.DB),
        adminSecretConfigured: getAdminSecret(env).length >= 8,
      });
    }

    if (url.pathname === "/api/state" && request.method === "GET") {
      const row = await env.DB.prepare(`
        SELECT state_json, updated_at
        FROM app_state
        WHERE id = 1
      `).first();

      if (!row) {
        return json({ state: null, data: null, updatedAt: null });
      }

      let state = null;
      try {
        state = JSON.parse(row.state_json);
      } catch (_) {}

      return json({
        state,
        data: state,
        updatedAt: row.updated_at,
      });
    }

    if (url.pathname === "/api/state" && request.method === "PUT") {
      const body = await request.json();
      const state = body.state || body.data;

      if (!state || typeof state !== "object") {
        return json({ error: "État invalide." }, 400);
      }

      const raw = JSON.stringify(state);
      const size = new TextEncoder().encode(raw).byteLength;

      if (size > MAX_STATE_SIZE) {
        return json({ error: "La sauvegarde dépasse 15 Mo." }, 413);
      }

      const now = new Date().toISOString();

      await env.DB.prepare(`
        INSERT INTO app_state(id, state_json, updated_at)
        VALUES(1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          state_json = excluded.state_json,
          updated_at = excluded.updated_at
      `).bind(raw, now).run();

      return json({ ok: true, savedAt: now });
    }

    if (url.pathname === "/api/app-version" && request.method === "GET") {
      const current = await env.DB.prepare(`
        SELECT id, file_name, byte_size, chunk_count, created_at
        FROM app_html_versions
        WHERE is_active = 1
        ORDER BY created_at DESC
        LIMIT 1
      `).first();

      return json({
        current: current || null,
        mode: current ? "d1-html" : "static-asset",
      });
    }

    if (url.pathname === "/api/app/update" && request.method === "POST") {
      if (!isAuthorized(request, env)) {
        return json({ error: "Mot de passe administrateur incorrect." }, 401);
      }

      const contentType = request.headers.get("content-type") || "";
      if (!contentType.toLowerCase().includes("text/html")) {
        return json({ error: "Le contenu reçu n'est pas de type HTML." }, 415);
      }

      const html = await request.text();
      const byteSize = new TextEncoder().encode(html).byteLength;

      if (!html.trim()) {
        return json({ error: "Le fichier HTML est vide." }, 400);
      }

      if (byteSize > MAX_HTML_SIZE) {
        return json({ error: "Le fichier HTML dépasse 15 Mo." }, 413);
      }

      const normalized = html.toLowerCase();
      if (
        !normalized.includes("<html") ||
        !normalized.includes("<body") ||
        !normalized.includes("</html>")
      ) {
        return json({ error: "Le fichier HTML n'est pas complet." }, 400);
      }

      let fileName = "index.html";
      const encodedName = request.headers.get("x-file-name");

      if (encodedName) {
        try {
          fileName = decodeURIComponent(encodedName);
        } catch (_) {
          fileName = encodedName;
        }
      }

      const saved = await saveHtmlVersion(env, html, fileName);
      return json({ ok: true, ...saved });
    }

    if (
      url.pathname === "/api/admin/rollback-html" &&
      request.method === "POST"
    ) {
      const body = await request.json().catch(() => ({}));

      if (!isAuthorized(request, env, body.password)) {
        return json({ error: "Mot de passe administrateur incorrect." }, 401);
      }

      const versions = await env.DB.prepare(`
        SELECT id
        FROM app_html_versions
        ORDER BY created_at DESC
        LIMIT 2
      `).all();

      if ((versions.results || []).length < 2) {
        return json({ error: "Aucune version précédente disponible." }, 404);
      }

      const previousId = versions.results[1].id;

      await env.DB.prepare(
        "UPDATE app_html_versions SET is_active = 0"
      ).run();

      await env.DB.prepare(
        "UPDATE app_html_versions SET is_active = 1 WHERE id = ?"
      ).bind(previousId).run();

      return json({ ok: true, id: previousId });
    }

    return json({ error: "Route API inconnue." }, 404);
  } catch (error) {
    console.error("API ERROR", error);
    return json(
      {
        error: error?.message || "Erreur interne du Worker.",
        route: url.pathname,
      },
      500
    );
  }
}
