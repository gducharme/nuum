-- Add FTS5 full-text search indexes for temporal messages and LTM entries
-- These enable the reflection agent to search conversation history

-- FTS5 virtual table for full-text search on temporal messages
CREATE VIRTUAL TABLE IF NOT EXISTS temporal_messages_fts USING fts5(
  id UNINDEXED,
  type UNINDEXED,
  content,
  content=temporal_messages,
  content_rowid=rowid
);

-- Triggers to keep FTS index in sync with temporal_messages
CREATE TRIGGER IF NOT EXISTS temporal_messages_ai AFTER INSERT ON temporal_messages BEGIN
  INSERT INTO temporal_messages_fts(rowid, id, type, content)
  VALUES (NEW.rowid, NEW.id, NEW.type, NEW.content);
END;

CREATE TRIGGER IF NOT EXISTS temporal_messages_ad AFTER DELETE ON temporal_messages BEGIN
  INSERT INTO temporal_messages_fts(temporal_messages_fts, rowid, id, type, content)
  VALUES ('delete', OLD.rowid, OLD.id, OLD.type, OLD.content);
END;

-- FTS5 virtual table for full-text search on LTM entries
CREATE VIRTUAL TABLE IF NOT EXISTS ltm_entries_fts USING fts5(
  slug UNINDEXED,
  title,
  body,
  content=ltm_entries,
  content_rowid=rowid
);

-- Triggers to keep FTS index in sync with ltm_entries
CREATE TRIGGER IF NOT EXISTS ltm_entries_ai AFTER INSERT ON ltm_entries BEGIN
  INSERT INTO ltm_entries_fts(rowid, slug, title, body)
  VALUES (NEW.rowid, NEW.slug, NEW.title, NEW.body);
END;

CREATE TRIGGER IF NOT EXISTS ltm_entries_au AFTER UPDATE ON ltm_entries BEGIN
  INSERT INTO ltm_entries_fts(ltm_entries_fts, rowid, slug, title, body)
  VALUES ('delete', OLD.rowid, OLD.slug, OLD.title, OLD.body);
  INSERT INTO ltm_entries_fts(rowid, slug, title, body)
  VALUES (NEW.rowid, NEW.slug, NEW.title, NEW.body);
END;

CREATE TRIGGER IF NOT EXISTS ltm_entries_ad AFTER DELETE ON ltm_entries BEGIN
  INSERT INTO ltm_entries_fts(ltm_entries_fts, rowid, slug, title, body)
  VALUES ('delete', OLD.rowid, OLD.slug, OLD.title, OLD.body);
END;

-- Rebuild FTS indexes to ensure they're in sync with base tables
-- This is idempotent - safe to run on existing databases
-- The 'rebuild' command repopulates the FTS index from the content table
INSERT INTO temporal_messages_fts(temporal_messages_fts) VALUES('rebuild');
INSERT INTO ltm_entries_fts(ltm_entries_fts) VALUES('rebuild');
