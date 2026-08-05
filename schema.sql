CREATE TABLE IF NOT EXISTS app_state (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_html_versions (
  id TEXT PRIMARY KEY, file_name TEXT NOT NULL, byte_size INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL, created_at TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS app_html_chunks (
  version_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, content TEXT NOT NULL,
  PRIMARY KEY(version_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_app_html_active ON app_html_versions(is_active, created_at);
