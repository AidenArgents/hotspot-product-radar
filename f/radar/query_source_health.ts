import type { RadarConfig } from "./types.ts";
import { connectDatabase, ensureSchema } from "./database.ts";

export async function main(config: RadarConfig) {
  const database = connectDatabase(config);
  try {
    await ensureSchema(database);
    const productRows = database.prepare(`
      SELECT se.source_line, se.source_kind, se.country, se.source_name,
             CASE
               WHEN se.status = 'success' AND se.item_count = 0 THEN 'partial'
               ELSE se.status
             END AS status,
             se.item_count, se.finished_at,
             CASE
               WHEN se.status = 'success' AND se.item_count = 0
                 THEN COALESCE(se.error, '历史请求未报错，但没有取得有效内容')
               ELSE se.error
             END AS error,
             sr.id AS run_id, sr.started_at AS run_started_at
      FROM source_executions se
      JOIN scan_runs sr ON sr.id = se.run_id
      WHERE se.id = (
        SELECT MAX(latest.id)
        FROM source_executions latest
        WHERE latest.source_kind = se.source_kind
          AND COALESCE(latest.country, '') = COALESCE(se.country, '')
          AND COALESCE(latest.source_name, '') = COALESCE(se.source_name, '')
      )
        AND se.source_kind NOT IN ('branch', 'gemini')
      ORDER BY se.source_line, se.source_kind, se.country, se.source_name
    `).all();
    const operationRows = database.prepare(`
      SELECT '运营' AS source_line, ose.source_kind, ose.country, ose.source_name,
             CASE WHEN ose.status = 'success' AND ose.item_count = 0 THEN 'partial' ELSE ose.status END AS status,
             ose.item_count, ose.finished_at,
             CASE WHEN ose.status = 'success' AND ose.item_count = 0
               THEN COALESCE(ose.error, '历史请求未报错，但没有取得有效内容') ELSE ose.error END AS error,
             obr.id AS run_id, obr.started_at AS run_started_at
      FROM operation_source_executions ose
      JOIN operation_runs obr ON obr.id = ose.run_id
      WHERE ose.id = (
        SELECT MAX(latest.id) FROM operation_source_executions latest
        WHERE latest.source_kind = ose.source_kind
          AND COALESCE(latest.country, '') = COALESCE(ose.country, '')
          AND COALESCE(latest.source_name, '') = COALESCE(ose.source_name, '')
      )
      ORDER BY ose.source_kind, ose.country, ose.source_name
    `).all();
    return [...productRows, ...operationRows];
  } finally {
    database.close();
  }
}
