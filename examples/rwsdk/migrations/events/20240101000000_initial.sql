CREATE TABLE events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload TEXT,
  session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
