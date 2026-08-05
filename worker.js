const HTML_CHUNK_SIZE = 90000;
const MAX_HTML_SIZE = 30 * 1024 * 1024;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env, url);
    }

    if (
      request.method === 'GET' &&
      (url.pathname === '/' || url.pathname === '/index.html')
    ) {
      const stored = await getActiveHtml(env);
      if (stored) {
        return new Response(stored.html, {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store, no-cache, must-revalidate',
            'x-app-version': stored.version,
          },
        });
      }
    }

    return env.ASSETS.fetch(request);
  },
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });

async function ensureTables(env) {
  await env.DB.batch([
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS app_state (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS app_html_versions (
        id TEXT PRIMARY KEY,
        file_name TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        chunk_count INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 0
      )
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS app_html_chunks (
        version_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        PRIMARY KEY(version_id, chunk_index)
      )
    `),
    env.DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_app_html_active
      ON app_html_versions(is_active, created_at)
    `),
  ]);
}

async function getActiveHtml(env) {
  try {
    await ensureTables(env);

    const version = await env.DB.prepare(`
      SELECT id, file_name, created_at
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
      ORDER BY chunk_index
    `).bind(version.id).all();

    const html = (rows.results || [])
      .map((row) => row.content || '')
      .join('');

    return html ? { html, version: version.id } : null;
  } catch (error) {
    console.error('getActiveHtml:', error);
    return null;
  }
}

function getAdminSecret(env) {
  return String(env.ADMIN_PASSWORD || env.UPDATE_PASSWORD || '');
}

function isAuthorized(request, env, password = '') {
  const expected = getAdminSecret(env);
  const supplied = String(
    password ||
      request.headers.get('x-admin-password') ||
      request.headers.get('x-update-password') ||
      ''
  );

  return expected.length >= 8 && supplied === expected;
}

async function saveHtmlVersion(env, html, fileName) {
  await ensureTables(env);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const chunks = [];

  for (let i = 0; i < html.length; i += HTML_CHUNK_SIZE) {
    chunks.push(html.slice(i, i + HTML_CHUNK_SIZE));
  }

  await env.DB.prepare(`
    INSERT INTO app_html_versions(
      id, file_name, byte_size, chunk_count, created_at, is_active
    )
    VALUES(?, ?, ?, ?, ?, 0)
  `)
    .bind(
      id,
      fileName,
      new TextEncoder().encode(html).byteLength,
      chunks.length,
      now
    )
    .run();

  for (let offset = 0; offset < chunks.length; offset += 40) {
    const batch = chunks.slice(offset, offset + 40).map((content, index) =>
      env.DB.prepare(`
        INSERT INTO app_html_chunks(version_id, chunk_index, content)
        VALUES(?, ?, ?)
      `).bind(id, offset + index, content)
    );

    await env.DB.batch(batch);
  }

  await env.DB.batch([
    env.DB.prepare(`
      UPDATE app_html_versions
      SET is_active = 0
      WHERE is_active = 1
    `),
    env.DB.prepare(`
      UPDATE app_html_versions
      SET is_active = 1
      WHERE id = ?
    `).bind(id),
  ]);

  // Conserve les 3 versions les plus récentes.
  const oldVersions = await env.DB.prepare(`
    SELECT id
    FROM app_html_versions
    ORDER BY created_at DESC
    LIMIT -1 OFFSET 3
  `).all();

  for (const row of oldVersions.results || []) {
    await env.DB.batch([
      env.DB.prepare(`
        DELETE FROM app_html_chunks
        WHERE version_id = ?
      `).bind(row.id),
      env.DB.prepare(`
        DELETE FROM app_html_versions
        WHERE id = ?
      `).bind(row.id),
    ]);
  }

  return { id, createdAt: now };
}

async function handleApi(request, env, url) {
  try {
    await ensureTables(env);

    if (url.pathname === '/api/health' && request.method === 'GET') {
      const result = await env.DB.prepare('SELECT 1 AS ok').first();
      return json({ ok: result?.ok === 1 });
    }

    if (url.pathname === '/api/state' && request.method === 'GET') {
      const row = await env.DB.prepare(`
        SELECT state_json, updated_at
        FROM app_state
        WHERE id = 1
      `).first();

      if (!row) {
        return json({
          state: null,
          data: null,
          updatedAt: null,
        });
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

    if (url.pathname === '/api/state' && request.method === 'PUT') {
      const body = await request.json();

      // Accepte les deux formats : {state: ...} et {data: ...}
      const state = body.state || body.data;

      if (!state || typeof state !== 'object') {
        return json({ error: 'État invalide.' }, 400);
      }

      const raw = JSON.stringify(state);

      if (new TextEncoder().encode(raw).byteLength > 20 * 1024 * 1024) {
        return json(
          {
            error:
              'Les données dépassent 20 Mo. Réduisez notamment les images intégrées.',
          },
          413
        );
      }

      const now = new Date().toISOString();

      await env.DB.prepare(`
        INSERT INTO app_state(id, state_json, updated_at)
        VALUES(1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          state_json = excluded.state_json,
          updated_at = excluded.updated_at
      `)
        .bind(raw, now)
        .run();

      return json({ ok: true, savedAt: now });
    }

    if (url.pathname === '/api/app-version' && request.method === 'GET') {
      const current = await env.DB.prepare(`
        SELECT id, file_name, byte_size, created_at
        FROM app_html_versions
        WHERE is_active = 1
        ORDER BY created_at DESC
        LIMIT 1
      `).first();

      return json({
        current: current || null,
        mode: current ? 'd1-html' : 'static-asset',
      });
    }

    // Route utilisée par CENTRE-RÉGULATION V1.
    if (url.pathname === '/api/app/update' && request.method === 'POST') {
      if (!isAuthorized(request, env)) {
        return json(
          { error: 'Mot de passe administrateur incorrect.' },
          401
        );
      }

      const contentType = request.headers.get('content-type') || '';
      if (!contentType.toLowerCase().includes('text/html')) {
        return json({ error: 'Le contenu doit être un fichier HTML.' }, 415);
      }

      const html = await request.text();
      const byteSize = new TextEncoder().encode(html).byteLength;

      if (byteSize > MAX_HTML_SIZE) {
        return json({ error: 'Le fichier HTML dépasse 30 Mo.' }, 413);
      }

      const normalized = html.trim().toLowerCase();

      if (
        !normalized.includes('<html') ||
        !normalized.includes('<body') ||
        !normalized.includes('</html>')
      ) {
        return json(
          { error: 'Le fichier ne semble pas être un HTML complet.' },
          400
        );
      }

      let fileName = 'index.html';
      const encodedName = request.headers.get('x-file-name');

      if (encodedName) {
        try {
          fileName = decodeURIComponent(encodedName);
        } catch (_) {
          fileName = encodedName;
        }
      }

      const result = await saveHtmlVersion(env, html, fileName);

      return json({
        ok: true,
        ...result,
      });
    }

    // Compatibilité avec l'ancienne route multipart.
    if (
      url.pathname === '/api/admin/update-html' &&
      request.method === 'POST'
    ) {
      const form = await request.formData();
      const password = String(form.get('password') || '');

      if (!isAuthorized(request, env, password)) {
        return json(
          { error: 'Mot de passe administrateur incorrect.' },
          401
        );
      }

      const file = form.get('file');

      if (!(file instanceof File)) {
        return json({ error: 'Fichier HTML manquant.' }, 400);
      }

      if (file.size > MAX_HTML_SIZE) {
        return json({ error: 'Le fichier HTML dépasse 30 Mo.' }, 413);
      }

      const html = await file.text();
      const normalized = html.trim().toLowerCase();

      if (
        !normalized.includes('<html') ||
        !normalized.includes('<body') ||
        !normalized.includes('</html>')
      ) {
        return json(
          { error: 'Le fichier ne semble pas être un HTML complet.' },
          400
        );
      }

      return json({
        ok: true,
        ...(await saveHtmlVersion(env, html, file.name || 'index.html')),
      });
    }

    if (
      url.pathname === '/api/admin/rollback-html' &&
      request.method === 'POST'
    ) {
      const body = await request.json().catch(() => ({}));

      if (!isAuthorized(request, env, body.password)) {
        return json(
          { error: 'Mot de passe administrateur incorrect.' },
          401
        );
      }

      const versions = await env.DB.prepare(`
        SELECT id
        FROM app_html_versions
        ORDER BY created_at DESC
        LIMIT 2
      `).all();

      if ((versions.results || []).length < 2) {
        return json(
          { error: 'Aucune version précédente disponible.' },
          404
        );
      }

      const id = versions.results[1].id;

      await env.DB.batch([
        env.DB.prepare(`
          UPDATE app_html_versions
          SET is_active = 0
          WHERE is_active = 1
        `),
        env.DB.prepare(`
          UPDATE app_html_versions
          SET is_active = 1
          WHERE id = ?
        `).bind(id),
      ]);

      return json({ ok: true, id });
    }

    return json({ error: 'Route API inconnue.' }, 404);
  } catch (error) {
    console.error(error);
    return json(
      { error: error?.message || 'Erreur serveur.' },
      500
    );
  }
}
