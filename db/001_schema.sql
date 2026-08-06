PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS scan_runs (
  id TEXT PRIMARY KEY,
  trigger_type TEXT NOT NULL,
  target_region TEXT NOT NULL,
  time_range TEXT NOT NULL,
  data_lines TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  event_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL DEFAULT '{}',
  error TEXT
);

CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  event_type TEXT,
  country TEXT,
  region TEXT,
  currency TEXT,
  event_date TEXT,
  stage TEXT,
  source TEXT,
  source_line TEXT NOT NULL,
  ecommerce_score INTEGER NOT NULL DEFAULT 0,
  products TEXT NOT NULL DEFAULT '[]',
  best_listing_time TEXT,
  why_sellable TEXT,
  first_run_id TEXT NOT NULL REFERENCES scan_runs(id),
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  sheet_synced_at TEXT,
  raw_event TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run_events (
  run_id TEXT NOT NULL REFERENCES scan_runs(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
  source_line TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (run_id, event_id, source_line)
);

CREATE TABLE IF NOT EXISTS source_executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES scan_runs(id) ON DELETE CASCADE,
  source_line TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  country TEXT,
  source_name TEXT,
  request_key TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  item_count INTEGER NOT NULL DEFAULT 0,
  request_payload TEXT,
  response_payload TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS sports_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES scan_runs(id) ON DELETE CASCADE,
  source_name TEXT NOT NULL,
  query TEXT NOT NULL,
  answer TEXT,
  results TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES scan_runs(id) ON DELETE CASCADE,
  source_line TEXT NOT NULL,
  robot_index INTEGER NOT NULL,
  status TEXT NOT NULL,
  response TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS events_filter_idx ON events (region, country, event_date DESC, ecommerce_score DESC);
CREATE INDEX IF NOT EXISTS events_source_idx ON events (source_line, source, first_seen_at DESC);
CREATE INDEX IF NOT EXISTS runs_started_idx ON scan_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS source_run_idx ON source_executions (run_id, source_line, status);
