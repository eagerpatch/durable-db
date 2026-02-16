CREATE TABLE products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  price_in_cents INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
