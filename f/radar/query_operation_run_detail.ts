import { connectDatabase, ensureSchema } from "./database.ts";
import type { RadarConfig } from "./types.ts";

function parse(value: unknown, fallback: unknown) {
  try { return JSON.parse(String(value ?? "")); } catch { return fallback; }
}

export async function queryOperationRunDetail(config: RadarConfig, runId: string) {
  if (!runId) throw new Error("run_id 不能为空");
  const database = connectDatabase(config);
  try {
    await ensureSchema(database);
    const run = database.prepare("SELECT * FROM operation_runs WHERE id = ?").get(runId) ?? null;
    const sources = database.prepare(`
      SELECT source_kind, country, source_name, request_key, status, item_count,
             started_at, finished_at, error
      FROM operation_source_executions WHERE run_id = ? ORDER BY source_kind, country, source_name
    `).all(runId);
    const notifications = database.prepare(`
      SELECT robot_index, status, error, created_at FROM operation_notifications
      WHERE run_id = ? ORDER BY id
    `).all(runId);
    const items = database.prepare(`
      SELECT oi.intelligence_id, oi.title, oi.country, oi.category, oi.direction,
             oi.impact_score, oi.urgency, oi.business_impact, oi.source_name, oi.source_url
      FROM operation_run_items ri JOIN operation_intelligence oi
        ON oi.intelligence_id = ri.intelligence_id
      WHERE ri.run_id = ? ORDER BY oi.impact_score DESC
    `).all(runId);
    return { run: run ? { ...run, summary: parse(run.summary, {}) } : null, sources, notifications, items };
  } finally {
    database.close();
  }
}
