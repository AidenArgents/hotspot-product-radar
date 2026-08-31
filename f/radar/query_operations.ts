import { connectDatabase, ensureSchema } from "./database.ts";
import type { RadarConfig } from "./types.ts";

function parse(value: unknown, fallback: unknown) {
  try { return JSON.parse(String(value ?? "")); } catch { return fallback; }
}

export async function queryOperations(
  config: RadarConfig,
  query: {
    region?: string;
    country?: string;
    category?: string;
    direction?: string;
    urgency?: string;
    min_score?: number;
    date_from?: string;
    search?: string;
    sort_by?: "first_seen_at" | "impact_score" | "effective_date";
    sort_order?: "asc" | "desc";
    limit?: number;
    offset?: number;
  } = {},
) {
  const database = connectDatabase(config);
  const clauses = ["impact_score >= ?"];
  const values: Array<string | number> = [Math.max(0, Math.min(100, Number(query.min_score ?? 0)))];
  for (const [column, raw] of [
    ["region", query.region], ["country", query.country], ["category", query.category],
    ["direction", query.direction], ["urgency", query.urgency],
  ] as const) {
    const value = raw?.trim();
    if (value) { clauses.push(`${column} = ?`); values.push(value); }
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(query.date_from ?? "")) {
    clauses.push("date(first_seen_at) >= ?");
    values.push(query.date_from!);
  }
  const search = query.search?.trim();
  if (search) {
    clauses.push("(title LIKE ? OR business_impact LIKE ? OR recommended_actions LIKE ?)");
    values.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  const where = clauses.join(" AND ");
  const sortColumns = new Set(["first_seen_at", "impact_score", "effective_date"]);
  const sortBy = sortColumns.has(query.sort_by ?? "") ? query.sort_by! : "first_seen_at";
  const sortOrder = query.sort_order === "asc" ? "ASC" : "DESC";
  const limit = Math.max(1, Math.min(500, Number(query.limit ?? 100)));
  const offset = Math.max(0, Number(query.offset ?? 0));
  try {
    await ensureSchema(database);
    const rows: Array<Record<string, unknown>> = (database.prepare(`
      SELECT intelligence_id, title, country, region, category, direction, impact_score,
             urgency, effective_date, impact_scope, affected_dimensions, affected_categories,
             business_impact, recommended_actions, source_name, source_url, source_date,
             authority, confidence, evidence_count, first_seen_at, sheet_synced_at, raw_item
      FROM operation_intelligence WHERE ${where}
      ORDER BY ${sortBy} ${sortOrder}, impact_score DESC, first_seen_at DESC
      LIMIT ? OFFSET ?
    `).all(...values, limit, offset) as unknown as Array<Record<string, unknown>>).map((row): Record<string, unknown> => {
      const raw = parse(row.raw_item, {}) as Record<string, unknown>;
      const { raw_item: _rawItem, ...columns } = row;
      return {
        ...raw,
        ...columns,
        affected_dimensions: parse(row.affected_dimensions, []),
        affected_categories: parse(row.affected_categories, []),
        recommended_actions: parse(row.recommended_actions, []),
      };
    });
    const total = Number(database.prepare(`SELECT count(*) total FROM operation_intelligence WHERE ${where}`)
      .get(...values)?.total ?? 0);
    const stat = database.prepare(`
      SELECT SUM(CASE WHEN impact_score >= 80 THEN 1 ELSE 0 END) high,
             SUM(CASE WHEN direction = '利空' AND urgency = '立即处理' THEN 1 ELSE 0 END) urgent_risk,
             COUNT(DISTINCT country) countries
      FROM operation_intelligence WHERE ${where}
    `).get(...values) ?? {};
    const facets = database.prepare(`
      SELECT DISTINCT region, country, category, direction, urgency FROM operation_intelligence
    `).all();
    const unique = (key: string) => [...new Set(facets.map((row) => String(row[key] ?? "")).filter(Boolean))].sort();
    return {
      items: rows,
      total,
      stats: { high: Number(stat.high ?? 0), urgent_risk: Number(stat.urgent_risk ?? 0), countries: Number(stat.countries ?? 0) },
      facets: {
        regions: unique("region"), countries: unique("country"), categories: unique("category"),
        directions: unique("direction"), urgencies: unique("urgency"),
      },
      limit,
      offset,
    };
  } finally {
    database.close();
  }
}
