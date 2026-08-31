import { connectDatabase, ensureSchema } from "./database.ts";
import type { RadarConfig } from "./types.ts";

export async function queryOperationRuns(config: RadarConfig, limit = 30) {
  const database = connectDatabase(config);
  try {
    await ensureSchema(database);
    return database.prepare(`
      SELECT id, trigger_type, target_region, time_range, evidence_mode, status,
             started_at, finished_at, intelligence_count, error_count, summary, error
      FROM operation_runs ORDER BY started_at DESC LIMIT ?
    `).all(Math.max(1, Math.min(200, Number(limit)))).map((row) => ({
      ...row,
      summary: (() => { try { return JSON.parse(String(row.summary ?? "{}")); } catch { return {}; } })(),
    }));
  } finally {
    database.close();
  }
}
