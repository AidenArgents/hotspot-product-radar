import { JWT } from "google-auth-library";
import type { RadarConfig, RadarEvent } from "./types.ts";
import { fetchJson } from "./http.ts";

async function accessToken(config: RadarConfig): Promise<string> {
  const client = new JWT({
    email: config.google_service_account_email,
    key: config.google_private_key.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const token = await client.getAccessToken();
  if (!token.token) throw new Error("Google Service Account 未返回 access token");
  return token.token;
}

export async function readSheetHistory(config: RadarConfig): Promise<string[]> {
  if (!config.spreadsheet_id) return [];
  const token = await accessToken(config);
  const range = encodeURIComponent(`${config.google_sheet_name}!A:G`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.spreadsheet_id)}/values/${range}`;
  const response = await fetchJson<{ values?: unknown[][] }>(url, {
    headers: { Authorization: `Bearer ${token}` },
    timeoutMs: config.request_timeout_ms,
    retries: 1,
  });
  return (response.values ?? [])
    .slice(1)
    .map((row) => String(row?.[0] ?? ""))
    .filter(Boolean);
}

export async function appendSheetEvents(
  config: RadarConfig,
  events: RadarEvent[],
  dataSource: string,
  scanDate: string,
): Promise<number> {
  if (!config.spreadsheet_id || events.length === 0) return 0;
  const token = await accessToken(config);
  const values = events.map((event) => {
    const products = (event.products ?? [])
      .map((product) =>
        `${product.name ?? ""}(${product.category ?? ""}) ${product.price_range ?? ""}`.trim(),
      )
      .join(" | ");
    const keywordsEn = (event.products ?? [])
      .flatMap((product) => product.keywords_en ?? [])
      .slice(0, 5)
      .join(", ");
    const keywordsLocal = (event.products ?? [])
      .flatMap((product) => product.keywords_local ?? [])
      .slice(0, 5)
      .join(", ");
    return [
      event.event_id ?? "",
      event.event_name ?? "",
      `${event.region ?? ""}-${event.country ?? ""}`,
      event.date ?? "",
      event.stage ?? "",
      String(event.ecommerce_score ?? 0),
      products,
      keywordsEn,
      keywordsLocal,
      event.best_listing_time ?? "",
      event.source ?? dataSource,
      scanDate,
      dataSource,
    ];
  });
  const range = encodeURIComponent(`${config.google_sheet_name}!A1`);
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.spreadsheet_id)}` +
    `/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  await fetchJson(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values }),
    timeoutMs: 30000,
    retries: 1,
  });
  return values.length;
}

