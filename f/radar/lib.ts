import type {
  DataLines,
  RadarEvent,
  SourceLine,
  TargetRegion,
  TimeRange,
} from "./types.ts";
import { SOURCE_CATALOG } from "./source_catalog.ts";

export const TARGET_COUNTRIES = Object.freeze(
  Object.values(SOURCE_CATALOG.regions as Record<string, readonly string[]>)
    .flatMap((items) => [...items]),
);

export function todayIso(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function makeRunId(now = new Date()): string {
  return `${now.toISOString().replace(/[-:.TZ]/g, "")}-${crypto.randomUUID()}`;
}

export function isLineSelected(dataLines: DataLines, line: SourceLine): boolean {
  return dataLines === "全部" || dataLines.includes(line);
}

export function countriesForTarget(
  target: TargetRegion,
  enabledCountries: readonly string[] = TARGET_COUNTRIES,
): string[] {
  const regions = SOURCE_CATALOG.regions as Record<string, readonly string[]>;
  const enabled = new Set(enabledCountries);
  const selected = target === "全部"
    ? TARGET_COUNTRIES
    : regions[target]
      ? [...regions[target]]
      : [target];
  return selected.filter((country) => enabled.has(country));
}

export function timeWindow(
  currentDate: string,
  range: TimeRange,
): { start: Date; end: Date } {
  const start = new Date(`${currentDate}T00:00:00Z`);
  const end = new Date(start);
  if (range === "今天") end.setUTCDate(end.getUTCDate() + 1);
  else if (range === "近3天") end.setUTCDate(end.getUTCDate() + 3);
  else if (range === "本周") end.setUTCDate(end.getUTCDate() + 7);
  else if (range === "本月") end.setUTCMonth(end.getUTCMonth() + 1);
  else end.setUTCMonth(end.getUTCMonth() + 3);
  return { start, end };
}

export async function mapLimit<T, R>(
  values: readonly T[],
  limit: number,
  work: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (values.length === 0) return [];
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, values.length)) },
    async () => {
      while (true) {
        const index = cursor++;
        if (index >= values.length) return;
        results[index] = await work(values[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export function dedupeEvents(
  events: RadarEvent[],
  historyIds: Iterable<string>,
): RadarEvent[] {
  const history = new Set(historyIds);
  const seen = new Set<string>();
  const output: RadarEvent[] = [];
  for (const event of [...events].sort(
    (a, b) => (b.ecommerce_score ?? 0) - (a.ecommerce_score ?? 0),
  )) {
    const key = `${event.event_name ?? ""}|${event.country ?? ""}|${event.stage ?? ""}`;
    if (!seen.has(key) && !history.has(event.event_id ?? "")) {
      seen.add(key);
      output.push(event);
    }
  }
  return output;
}

export function normalizeDate(value: unknown): string | undefined {
  const date = String(value ?? "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const match = date.match(/(\d{4})[^\d]*(\d{1,2})[^\d]*(\d{1,2})/);
  if (!match) return undefined;
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

const TARGET_COUNTRY_ALIASES: Record<string, string> = {
  "越南": "越南", vietnam: "越南",
  "泰国": "泰国", thailand: "泰国",
  "印尼": "印尼", "印度尼西亚": "印尼", indonesia: "印尼",
  "菲律宾": "菲律宾", philippines: "菲律宾", "the philippines": "菲律宾",
  "马来西亚": "马来西亚", malaysia: "马来西亚",
  "新加坡": "新加坡", singapore: "新加坡",
  "巴西": "巴西", brazil: "巴西", brasil: "巴西",
  "墨西哥": "墨西哥", mexico: "墨西哥", méxico: "墨西哥",
};

export function normalizeTargetCountry(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  return TARGET_COUNTRY_ALIASES[text] ?? TARGET_COUNTRY_ALIASES[text.toLowerCase()];
}
