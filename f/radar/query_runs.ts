import type { RadarConfig } from "./types.ts";
import { connectDatabase, ensureSchema } from "./database.ts";

export async function main(config: RadarConfig, limit = 30) {
  const database = connectDatabase(config);
  try {
    await ensureSchema(database);
    return database.prepare(`
      SELECT id, trigger_type, target_region, time_range, data_lines, status,
             started_at, finished_at, event_count, error_count, summary, error
      FROM scan_runs ORDER BY started_at DESC LIMIT ?
    `).all(Math.max(1, Math.min(200, Number(limit)))).map((row) => ({
      ...row,
      summary: JSON.parse(String(row.summary ?? "{}")),
    }));
  } finally {
    database.close();
  }
}
