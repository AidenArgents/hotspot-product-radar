import { SOURCE_CATALOG } from "./source_catalog.ts";
import { fetchText } from "./http.ts";
import { timeWindow } from "./lib.ts";
import type {
  CountryConfig,
  RadarConfig,
  RuntimeContext,
  SourceExecutionRecord,
  SourceLine,
} from "./types.ts";

export interface HolidayRecord {
  date: string;
  localName: string;
  name: string;
}

type FallbackConfig = {
  source_name: string;
  source_url: string;
  years: Record<string, HolidayRecord[]>;
};

function yearsForWindow(context: RuntimeContext) {
  const { start, end } = timeWindow(context.current_date, context.time_range);
  const years: number[] = [];
  for (let year = start.getUTCFullYear(); year <= end.getUTCFullYear(); year += 1) years.push(year);
  return years;
}

function validHoliday(value: unknown): value is HolidayRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return /^\d{4}-\d{2}-\d{2}$/.test(String(item.date ?? ""))
    && Boolean(String(item.name ?? item.localName ?? "").trim());
}

export async function fetchCountryHolidays(
  config: RadarConfig,
  context: RuntimeContext,
  countryName: string,
  country: CountryConfig,
  sourceLine: SourceLine,
) {
  const executions: SourceExecutionRecord[] = [];
  const holidays: HolidayRecord[] = [];
  const fallbacks = SOURCE_CATALOG.holiday_fallbacks as unknown as Record<string, FallbackConfig>;
  const fallback = fallbacks[countryName];

  for (const year of yearsForWindow(context)) {
    const requestKey = `${sourceLine}:nager:${year}:${country.code}`;
    let nagerRecords: HolidayRecord[] = [];
    try {
      const text = await fetchText(
        `https://date.nager.at/api/v3/PublicHolidays/${year}/${country.code}`,
        { timeoutMs: Math.min(config.request_timeout_ms, 15000), retries: 1 },
      );
      const parsed = text.trim() ? JSON.parse(text) : [];
      nagerRecords = Array.isArray(parsed) ? parsed.filter(validHoliday) : [];
      holidays.push(...nagerRecords);
      executions.push({
        source_line: sourceLine,
        source_kind: "nager",
        country: countryName,
        source_name: "Nager.Date",
        request_key: requestKey,
        status: nagerRecords.length ? "success" : "partial",
        item_count: nagerRecords.length,
        response_payload: nagerRecords,
        error: nagerRecords.length ? undefined : "该国家/年份无 Nager.Date 数据，尝试官方兜底表",
      });
    } catch (error) {
      executions.push({
        source_line: sourceLine,
        source_kind: "nager",
        country: countryName,
        source_name: "Nager.Date",
        request_key: requestKey,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (nagerRecords.length > 0 || !fallback) continue;
    const officialRecords = (fallback.years[String(year)] ?? []).filter(validHoliday);
    holidays.push(...officialRecords);
    executions.push({
      source_line: sourceLine,
      source_kind: "official-holiday-fallback",
      country: countryName,
      source_name: fallback.source_name,
      request_key: `${sourceLine}:official-holiday:${year}:${country.code}`,
      status: officialRecords.length ? "success" : "partial",
      item_count: officialRecords.length,
      request_payload: { source_url: fallback.source_url, year },
      response_payload: officialRecords,
      error: officialRecords.length ? undefined : `官方兜底配置尚未维护 ${year} 年数据`,
    });
  }

  const seen = new Set<string>();
  return {
    holidays: holidays.filter((holiday) => {
      const key = `${holiday.date}|${holiday.localName}|${holiday.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
    executions,
  };
}
