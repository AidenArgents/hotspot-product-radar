import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  BranchResult,
  RadarConfig,
  RadarEvent,
  RuntimeContext,
  ScanInput,
  SourceExecutionRecord,
} from "./types.ts";

export type RadarDatabase = DatabaseSync;

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS scan_runs (
  id TEXT PRIMARY KEY, trigger_type TEXT NOT NULL, target_region TEXT NOT NULL,
  time_range TEXT NOT NULL, data_lines TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running', started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT, event_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0, summary TEXT NOT NULL DEFAULT '{}', error TEXT
);
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY, event_name TEXT NOT NULL, event_type TEXT,
  country TEXT, region TEXT, currency TEXT, event_date TEXT, stage TEXT,
  source TEXT, source_line TEXT NOT NULL, ecommerce_score INTEGER NOT NULL DEFAULT 0,
  products TEXT NOT NULL DEFAULT '[]', best_listing_time TEXT, why_sellable TEXT,
  first_run_id TEXT NOT NULL REFERENCES scan_runs(id),
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')), sheet_synced_at TEXT,
  raw_event TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS run_events (
  run_id TEXT NOT NULL REFERENCES scan_runs(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
  source_line TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (run_id, event_id, source_line)
);
CREATE TABLE IF NOT EXISTS source_executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES scan_runs(id) ON DELETE CASCADE,
  source_line TEXT NOT NULL, source_kind TEXT NOT NULL, country TEXT, source_name TEXT,
  request_key TEXT NOT NULL, status TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')), finished_at TEXT,
  item_count INTEGER NOT NULL DEFAULT 0, request_payload TEXT, response_payload TEXT, error TEXT
);
CREATE TABLE IF NOT EXISTS sports_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES scan_runs(id) ON DELETE CASCADE,
  source_name TEXT NOT NULL, query TEXT NOT NULL, answer TEXT,
  results TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES scan_runs(id) ON DELETE CASCADE,
  source_line TEXT NOT NULL, robot_index INTEGER NOT NULL, status TEXT NOT NULL,
  response TEXT, error TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS events_filter_idx ON events (region, country, event_date DESC, ecommerce_score DESC);
CREATE INDEX IF NOT EXISTS events_source_idx ON events (source_line, source, first_seen_at DESC);
CREATE INDEX IF NOT EXISTS runs_started_idx ON scan_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS source_run_idx ON source_executions (run_id, source_line, status);
`;

function databasePath(config: RadarConfig): string {
  return path.isAbsolute(config.database_file)
    ? config.database_file
    : path.resolve(process.cwd(), config.database_file);
}

export function connectDatabase(config: RadarConfig): RadarDatabase {
  const file = databasePath(config);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const database = new DatabaseSync(file, { timeout: 15000 });
  database.exec("PRAGMA busy_timeout = 15000; PRAGMA foreign_keys = ON;");
  return database;
}

export async function ensureSchema(database: RadarDatabase): Promise<void> {
  database.exec(SCHEMA_SQL);
}

export async function startRun(
  database: RadarDatabase,
  runId: string,
  input: ScanInput,
): Promise<void> {
  database.prepare(`
    INSERT INTO scan_runs (id, trigger_type, target_region, time_range, data_lines)
    VALUES (?, ?, ?, ?, ?)
  `).run(runId, input.trigger_type, input.target_region, input.time_range, input.data_lines);
}

export async function finishRun(
  database: RadarDatabase,
  runId: string,
  status: "success" | "partial" | "failed",
  branches: BranchResult[],
  error?: string,
): Promise<void> {
  const eventCount = branches.reduce((sum, branch) => sum + branch.events.length, 0);
  const errorCount = branches.reduce(
    (sum, branch) => sum + branch.executions.filter((item) => item.status === "failed").length,
    0,
  );
  const summary = Object.fromEntries(
    branches.map((branch) => [branch.line, { events: branch.events.length, analysis: branch.analysis }]),
  );
  database.prepare(`
    UPDATE scan_runs
    SET status = ?, finished_at = datetime('now'), event_count = ?, error_count = ?, summary = ?, error = ?
    WHERE id = ?
  `).run(status, eventCount, errorCount, JSON.stringify(summary), error ?? null, runId);
}

export async function loadHistoryIds(database: RadarDatabase): Promise<string[]> {
  return database.prepare("SELECT event_id FROM events").all()
    .map((row) => String(row.event_id));
}

function validDate(value: unknown): string | null {
  const text = String(value ?? "");
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

export async function insertNewEvents(
  database: RadarDatabase,
  context: RuntimeContext,
  branch: BranchResult,
): Promise<RadarEvent[]> {
  const insertEvent = database.prepare(`
    INSERT INTO events (
      event_id, event_name, event_type, country, region, currency, event_date,
      stage, source, source_line, ecommerce_score, products, best_listing_time,
      why_sellable, first_run_id, raw_event
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(event_id) DO NOTHING
  `);
  const linkEvent = database.prepare(`
    INSERT INTO run_events (run_id, event_id, source_line) VALUES (?, ?, ?)
    ON CONFLICT DO NOTHING
  `);
  const inserted: RadarEvent[] = [];
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const event of branch.events) {
      if (!event.event_id || !event.event_name) continue;
      const result = insertEvent.run(
        event.event_id,
        event.event_name,
        String(event.event_type ?? "") || null,
        String(event.country ?? "") || null,
        String(event.region ?? "") || null,
        String(event.currency ?? "") || null,
        validDate(event.date),
        String(event.stage ?? "") || null,
        String(event.source ?? branch.data_source),
        branch.line,
        Number(event.ecommerce_score ?? 0),
        JSON.stringify(event.products ?? []),
        String(event.best_listing_time ?? "") || null,
        String(event.why_sellable ?? "") || null,
        context.run_id,
        JSON.stringify(event),
      );
      if (result.changes > 0) {
        inserted.push(event);
        linkEvent.run(context.run_id, event.event_id, branch.line);
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return inserted;
}

export async function recordExecutions(
  database: RadarDatabase,
  runId: string,
  executions: SourceExecutionRecord[],
): Promise<void> {
  const statement = database.prepare(`
    INSERT INTO source_executions (
      run_id, source_line, source_kind, country, source_name, request_key,
      status, finished_at, item_count, request_payload, response_payload, error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?)
  `);
  for (const item of executions) {
    statement.run(
      runId,
      item.source_line,
      item.source_kind,
      item.country ?? null,
      item.source_name ?? null,
      item.request_key,
      item.status,
      item.item_count ?? 0,
      item.request_payload === undefined ? null : JSON.stringify(item.request_payload),
      item.response_payload === undefined ? null : JSON.stringify(item.response_payload),
      item.error ?? null,
    );
  }
}

export async function recordSports(
  database: RadarDatabase,
  runId: string,
  branch: BranchResult,
): Promise<void> {
  const statement = database.prepare(`
    INSERT INTO sports_results (run_id, source_name, query, answer, results)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const item of branch.sports_results ?? []) {
    statement.run(runId, item.source_name, item.query, item.answer ?? null, JSON.stringify(item.results));
  }
}

export async function recordNotification(
  database: RadarDatabase,
  runId: string,
  sourceLine: string,
  robotIndex: number,
  status: "success" | "failed" | "skipped",
  response?: unknown,
  error?: string,
): Promise<void> {
  database.prepare(`
    INSERT INTO notifications (run_id, source_line, robot_index, status, response, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    runId,
    sourceLine,
    robotIndex,
    status,
    response === undefined ? null : JSON.stringify(response),
    error ?? null,
  );
}

export async function markSheetSynced(
  database: RadarDatabase,
  eventIds: string[],
): Promise<void> {
  if (!eventIds.length) return;
  const placeholders = eventIds.map(() => "?").join(",");
  database.prepare(`UPDATE events SET sheet_synced_at = datetime('now') WHERE event_id IN (${placeholders})`)
    .run(...eventIds);
}
