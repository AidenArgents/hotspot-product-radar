import crypto from "node:crypto";
import { JWT } from "google-auth-library";
import type { RadarConfig, RadarEvent } from "./types.ts";
import { fetchJson } from "./http.ts";

export const PRODUCT_SHEET_HEADERS = [
  "事件ID", "事件名称", "地区-国家", "事件日期", "阶段", "电商机会分",
  "推荐产品", "英文关键词", "当地关键词", "最佳上架时间", "来源", "采集日期", "数据线路",
];

export const OPERATIONS_SHEET_HEADERS = [
  "情报ID", "标题", "国家", "地区", "类型", "影响方向", "运营影响分", "紧急程度",
  "生效日期", "影响范围", "影响维度", "受影响类目", "业务影响", "建议行动",
  "来源名称", "原文链接", "来源日期", "权威度", "可信度", "证据数", "采集日期",
];

let tokenCache: { credentialId: string; token: string; expiresAt: number } | undefined;

async function accessToken(config: RadarConfig): Promise<string> {
  const key = config.google_private_key.replace(/\\n/g, "\n");
  const credentialId = crypto.createHash("sha256")
    .update(`${config.google_service_account_email}\n${key}`)
    .digest("hex");
  if (tokenCache?.credentialId === credentialId && tokenCache.expiresAt > Date.now() + 60_000) {
    return tokenCache.token;
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const client = new JWT({
        email: config.google_service_account_email,
        key,
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
      });
      const response = await client.getAccessToken();
      if (!response.token) throw new Error("Google Service Account 未返回 access token");
      tokenCache = {
        credentialId,
        token: response.token,
        expiresAt: client.credentials.expiry_date ?? Date.now() + 50 * 60_000,
      };
      return response.token;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 1_000 * 2 ** attempt));
      }
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Google Service Account 鉴权连续4次失败：${detail}`);
}

function sheetRange(sheetName: string, range: string) {
  return `'${sheetName.replaceAll("'", "''")}'!${range}`;
}

export async function ensureSheet(
  config: RadarConfig,
  sheetName: string,
  headers: string[],
): Promise<void> {
  if (!config.spreadsheet_id) return;
  const token = await accessToken(config);
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.spreadsheet_id)}`;
  const metadata = await fetchJson<{ sheets?: Array<{ properties?: { title?: string } }> }>(
    `${base}?fields=sheets.properties.title`,
    { headers: { Authorization: `Bearer ${token}` }, timeoutMs: config.request_timeout_ms, retries: 3, retryDelayMs: 1_000 },
  );
  const exists = (metadata.sheets ?? []).some((sheet) => sheet.properties?.title === sheetName);
  if (!exists) {
    await fetchJson(`${base}:batchUpdate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: sheetName } } }] }),
      timeoutMs: 30000,
      retries: 3,
      retryDelayMs: 1_000,
    });
  }
  const firstCell = encodeURIComponent(sheetRange(sheetName, "A1:A1"));
  const current = await fetchJson<{ values?: unknown[][] }>(`${base}/values/${firstCell}`, {
    headers: { Authorization: `Bearer ${token}` },
    timeoutMs: config.request_timeout_ms,
    retries: 3,
    retryDelayMs: 1_000,
  });
  if (!current.values?.[0]?.[0]) {
    const headerRange = encodeURIComponent(sheetRange(sheetName, "A1"));
    await fetchJson(`${base}/values/${headerRange}?valueInputOption=RAW`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [headers] }),
      timeoutMs: 30000,
      retries: 3,
      retryDelayMs: 1_000,
    });
  }
}

export async function readSheetHistory(
  config: RadarConfig,
  sheetName = config.google_sheet_name,
  headers = PRODUCT_SHEET_HEADERS,
): Promise<string[]> {
  if (!config.spreadsheet_id) return [];
  await ensureSheet(config, sheetName, headers);
  const token = await accessToken(config);
  const range = encodeURIComponent(sheetRange(sheetName, "A:A"));
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.spreadsheet_id)}/values/${range}`;
  const response = await fetchJson<{ values?: unknown[][] }>(url, {
    headers: { Authorization: `Bearer ${token}` },
    timeoutMs: config.request_timeout_ms,
    retries: 3,
    retryDelayMs: 1_000,
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
  return appendSheetRows(config, config.google_sheet_name, PRODUCT_SHEET_HEADERS, values);
}

export async function appendSheetRows(
  config: RadarConfig,
  sheetName: string,
  headers: string[],
  values: unknown[][],
): Promise<number> {
  if (!config.spreadsheet_id || values.length === 0) return 0;
  await ensureSheet(config, sheetName, headers);
  const token = await accessToken(config);
  const range = encodeURIComponent(sheetRange(sheetName, "A1"));
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.spreadsheet_id)}` +
    `/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  await fetchJson(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values }),
    timeoutMs: 30000,
    retries: 3,
    retryDelayMs: 1_000,
  });
  return values.length;
}
