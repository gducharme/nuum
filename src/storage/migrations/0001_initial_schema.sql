-- Initial schema for miriad-code
-- Creates all core tables for temporal, present, LTM, and worker tracking

CREATE TABLE IF NOT EXISTS temporal_messages (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  token_estimate INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_temporal_messages_created
ON temporal_messages(id);

CREATE TABLE IF NOT EXISTS temporal_summaries (
  id TEXT PRIMARY KEY,
  order_num INTEGER NOT NULL,
  start_id TEXT NOT NULL,
  end_id TEXT NOT NULL,
  narrative TEXT NOT NULL,
  key_observations TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  token_estimate INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_temporal_summaries_order
ON temporal_summaries(order_num, id);

CREATE INDEX IF NOT EXISTS idx_temporal_summaries_range
ON temporal_summaries(start_id, end_id);

CREATE TABLE IF NOT EXISTS present_state (
  id INTEGER PRIMARY KEY DEFAULT 1,
  mission TEXT,
  status TEXT,
  tasks TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS ltm_entries (
  slug TEXT PRIMARY KEY,
  parent_slug TEXT,
  path TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  links TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ltm_entries_path
ON ltm_entries(path);

CREATE INDEX IF NOT EXISTS idx_ltm_entries_parent
ON ltm_entries(parent_slug);

CREATE TABLE IF NOT EXISTS workers (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS session_config (
  key TEXT PRIMARY KEY,
  value TEXT
);
