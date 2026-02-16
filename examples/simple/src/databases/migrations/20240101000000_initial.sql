-- Initial schema migration
-- Creates users and posts tables

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

--> breakpoint

CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT,
  author_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
