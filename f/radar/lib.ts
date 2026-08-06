import type {
  DataLines,
  RadarEvent,
  SourceLine,
  TargetRegion,
  TimeRange,
} from "./types.ts";
import { SOURCE_CATALOG } from "./source_catalog.ts";

export function todayIso(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function makeRunId(now = new Date()): string {
  return `${now.toISOString().replace(/[-:.TZ]/g, "")}-${crypto.randomUUID()}`;
}

export function isLineSelected(dataLines: DataLines, line: SourceLine): boolean {
  return dataLines === "全部" || dataLines.includes(line);
}

export function countriesForTarget(target: TargetRegion): string[] {
  const regions = SOURCE_CATALOG.regions as Record<string, readonly string[]>;
  if (target === "全部") return Object.values(regions).flatMap((items) => [...items]);
  if (regions[target]) return [...regions[target]];
  return [target];
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

