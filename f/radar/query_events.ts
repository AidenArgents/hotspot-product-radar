import type { RadarConfig, SourceLine } from "./types.ts";
import { connectDatabase, ensureSchema } from "./database.ts";

export interface EventQuery {
  region?: string;
  country?: string;
  source_line?: SourceLine | "";
  stage?: string;
  min_score?: number;
  date_from?: string;
  date_to?: string;
  search?: string;
  sort_by?: "event_date" | "ecommerce_score" | "first_seen_at";
  sort_order?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export interface QueriedEvent {
  event_id: string;
  event_name: string;
  country?: string;
  region?: string;
  source_line: string;
  ecommerce_score: number;
  products: unknown[];
  [key: string]: unknown;
}

function parseJson(value: unknown, fallback: unknown) {
  try { return JSON.parse(String(value ?? "")); } catch { return fallback; }
}

function normalizeProducts(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((product): product is Record<string, unknown> =>
      Boolean(product) && typeof product === "object" && !Array.isArray(product))
    .map((product) => ({
      ...product,
      name: String(product.name ?? product["name_中文"] ?? product.product_name ?? "").trim(),
      price_range: String(
        product.price_range ?? product["price_range_当地货币"] ?? product.price ?? "",
      ).trim(),
    }))
    .filter((product) => Boolean(product.name));
}

export async function queryEvents(config: RadarConfig, query: EventQuery = {}) {
  const database = connectDatabase(config);
  const clauses: string[] = ["ecommerce_score >= ?"];
  const values: Array<string | number | null> = [
    Math.max(0, Math.min(100, Number(query.min_score ?? 0))),
  ];
  const exactFilters = [
    ["region", query.region],
    ["country", query.country],
    ["source_line", query.source_line],
    ["stage", query.stage],
  ] as const;
  for (const [column, raw] of exactFilters) {
    const value = raw?.trim();
    if (!value) continue;
    clauses.push(`${column} = ?`);
    values.push(value);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(query.date_from ?? "")) {
    clauses.push("event_date >= ?");
    values.push(query.date_from!);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(query.date_to ?? "")) {
    clauses.push("event_date <= ?");
    values.push(query.date_to!);
  }
  const search = query.search?.trim();
  if (search) {
    clauses.push("(event_name LIKE ? OR why_sellable LIKE ?)");
    values.push(`%${search}%`, `%${search}%`);
  }
  const where = clauses.join(" AND ");
  const limit = Math.max(1, Math.min(500, Number(query.limit ?? 100)));
  const offset = Math.max(0, Number(query.offset ?? 0));

  try {
    await ensureSchema(database);
    const allowedSortColumns = ["event_date", "ecommerce_score", "first_seen_at"] as const;
    const sortBy = allowedSortColumns.includes(query.sort_by as any) ? query.sort_by! : "event_date";
    const sortOrder = query.sort_order === "asc" ? "ASC" : "DESC";
    const secondarySortMap: Record<string, string> = {
      event_date: "ecommerce_score DESC, first_seen_at DESC",
      ecommerce_score: "event_date DESC, first_seen_at DESC",
      first_seen_at: "event_date DESC, ecommerce_score DESC",
    };
    const secondarySort = secondarySortMap[sortBy];
    const rows = database.prepare(`
      SELECT event_id, event_name, event_type, country, region, currency,
             event_date AS date, stage, source, source_line, ecommerce_score,
             products, best_listing_time, why_sellable,
             first_seen_at, last_seen_at, sheet_synced_at
      FROM events WHERE ${where}
      ORDER BY ${sortBy} ${sortOrder}, ${secondarySort}
      LIMIT ? OFFSET ?
    `).all(...values, limit, offset) as unknown as Array<Record<string, unknown>>;
    const items: QueriedEvent[] = rows.map((row) => ({
      ...row,
      event_id: String(row.event_id),
      event_name: String(row.event_name),
      source_line: String(row.source_line),
      ecommerce_score: Number(row.ecommerce_score ?? 0),
      // Older Gemini responses sometimes used Chinese field names. Normalize on
      // read as well so existing rows remain usable after the parser is fixed.
      products: normalizeProducts(parseJson(row.products, [])),
    }));
    const total = Number(database.prepare(`SELECT count(*) AS total FROM events WHERE ${where}`)
      .get(...values)?.total ?? 0);
    const stat = database.prepare(`
      SELECT SUM(CASE WHEN ecommerce_score >= 80 THEN 1 ELSE 0 END) AS high,
             COUNT(DISTINCT country) AS countries
      FROM events WHERE ${where}
    `).get(...values) ?? {};
    const facetRows = database.prepare("SELECT DISTINCT region, country, stage FROM events").all();
    const unique = (key: "region" | "country" | "stage") =>
      [...new Set(facetRows.map((row) => String(row[key] ?? "")).filter(Boolean))].sort();
    return {
      items,
      total,
      stats: { high: Number(stat.high ?? 0), countries: Number(stat.countries ?? 0) },
      facets: { regions: unique("region"), countries: unique("country"), stages: unique("stage") },
      limit,
      offset,
    };
  } finally {
    database.close();
  }
}

export async function main(
  config: RadarConfig,
  region = "",
  country = "",
  source_line: SourceLine | "" = "",
  stage = "",
  min_score = 0,
  date_from = "",
  date_to = "",
  search = "",
  limit = 100,
  offset = 0,
) {
  return queryEvents(config, { region, country, source_line, stage, min_score, date_from, date_to, search, limit, offset });
}
