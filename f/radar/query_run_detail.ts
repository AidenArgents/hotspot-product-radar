import type { RadarConfig } from "./types.ts";
import { connectDatabase, ensureSchema } from "./database.ts";

function parse(value: unknown, fallback: unknown) {
  try { return JSON.parse(String(value ?? "")); } catch { return fallback; }
}

export async function main(config: RadarConfig, run_id: string) {
  if (!run_id) throw new Error("run_id 不能为空");
  const database = connectDatabase(config);
  try {
    await ensureSchema(database);
    const run = database.prepare("SELECT * FROM scan_runs WHERE id = ?").get(run_id) ?? null;
    const sources = database.prepare(`
      SELECT source_line, source_kind, country, source_name, request_key,
             status, item_count, started_at, finished_at, error
      FROM source_executions WHERE run_id = ?
      ORDER BY source_line, source_kind, country, source_name
    `).all(run_id);
    const sports = database.prepare(`
      SELECT source_name, query, answer, results, created_at
      FROM sports_results WHERE run_id = ? ORDER BY id
    `).all(run_id).map((row) => ({ ...row, results: parse(row.results, []) }));
    const notifications = database.prepare(`
      SELECT source_line, robot_index, status, error, created_at
      FROM notifications WHERE run_id = ? ORDER BY id
    `).all(run_id);
    const events = database.prepare(`
      SELECT e.event_id, e.event_name, e.country, e.region, e.event_date AS date,
             e.stage, e.source_line, e.ecommerce_score, e.products, e.why_sellable
      FROM run_events re JOIN events e ON e.event_id = re.event_id
      WHERE re.run_id = ? ORDER BY e.ecommerce_score DESC, e.event_date DESC
    `).all(run_id).map((row) => ({ ...row, products: parse(row.products, []) }));
    return {
      run: run ? { ...run, summary: parse(run.summary, {}) } : null,
      sources,
      sports,
      notifications,
      events,
    };
  } finally {
    database.close();
  }
}
