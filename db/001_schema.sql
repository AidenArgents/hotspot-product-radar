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

CREATE TABLE IF NOT EXISTS operation_runs (
  id TEXT PRIMARY KEY, trigger_type TEXT NOT NULL, target_region TEXT NOT NULL,
  time_range TEXT NOT NULL, evidence_mode TEXT NOT NULL DEFAULT 'fresh',
  status TEXT NOT NULL DEFAULT 'running', started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT, intelligence_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0, summary TEXT NOT NULL DEFAULT '{}', error TEXT
);

CREATE TABLE IF NOT EXISTS operation_intelligence (
  intelligence_id TEXT PRIMARY KEY, title TEXT NOT NULL, country TEXT NOT NULL,
  region TEXT NOT NULL, category TEXT NOT NULL, direction TEXT NOT NULL,
  impact_score INTEGER NOT NULL DEFAULT 0, urgency TEXT NOT NULL, effective_date TEXT,
  impact_scope TEXT, affected_dimensions TEXT NOT NULL DEFAULT '[]',
  affected_categories TEXT NOT NULL DEFAULT '[]', business_impact TEXT NOT NULL,
  recommended_actions TEXT NOT NULL DEFAULT '[]', source_name TEXT NOT NULL,
  source_url TEXT, source_date TEXT, authority TEXT, confidence INTEGER NOT NULL DEFAULT 0,
  evidence_count INTEGER NOT NULL DEFAULT 1,
  first_run_id TEXT NOT NULL REFERENCES operation_runs(id),
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')), sheet_synced_at TEXT,
  raw_item TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS operation_run_items (
  run_id TEXT NOT NULL REFERENCES operation_runs(id) ON DELETE CASCADE,
  intelligence_id TEXT NOT NULL REFERENCES operation_intelligence(intelligence_id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (run_id, intelligence_id)
);

CREATE TABLE IF NOT EXISTS operation_source_executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES operation_runs(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL, country TEXT, source_name TEXT, request_key TEXT NOT NULL,
  status TEXT NOT NULL, started_at TEXT NOT NULL DEFAULT (datetime('now')), finished_at TEXT,
  item_count INTEGER NOT NULL DEFAULT 0, request_payload TEXT, response_payload TEXT, error TEXT
);

CREATE TABLE IF NOT EXISTS operation_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES operation_runs(id) ON DELETE CASCADE,
  robot_index INTEGER NOT NULL, status TEXT NOT NULL, response TEXT, error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS evidence_items (
  evidence_id TEXT PRIMARY KEY, country TEXT NOT NULL, region TEXT NOT NULL,
  publisher TEXT NOT NULL, acquisition_method TEXT NOT NULL, source_kind TEXT NOT NULL,
  title TEXT NOT NULL, summary TEXT, url TEXT NOT NULL, published_at TEXT,
  authority TEXT NOT NULL, first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')), raw_item TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS operations_filter_idx ON operation_intelligence
  (region, country, category, direction, impact_score DESC, first_seen_at DESC);
CREATE INDEX IF NOT EXISTS operation_runs_started_idx ON operation_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS operation_source_run_idx ON operation_source_executions (run_id, status);
CREATE INDEX IF NOT EXISTS evidence_country_seen_idx ON evidence_items (country, last_seen_at DESC);
