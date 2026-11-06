import crypto from "node:crypto";
import { SOURCE_CATALOG } from "./source_catalog.ts";
import { mapLimit, normalizeDate, timeWindow } from "./lib.ts";
import { searchWeb, validateSearchResults, type SearchResult } from "./web_search.ts";
import type { CountryConfig, RadarConfig, RadarEvent, RuntimeContext, SourceExecutionRecord, SportsResult } from "./types.ts";

export interface ProductSearchRun {
  source_name: string;
  source_kind: "sports" | "official-event-calendar" | "tavily";
  country?: string;
  query: string;
  results: SearchResult[];
  execution: SourceExecutionRecord;
}

type EventSource = {
  country: string;
  name: string;
  domain: string;
  query: string;
  allowed_path_fragments: string[];
};

export function productSearchQuery(template: string, context: RuntimeContext) {
  const { start, end } = timeWindow(context.current_date, context.time_range);
  return template
    .replaceAll("${current_year}", context.current_date.slice(0, 4))
    .replaceAll("${config.time_range}", context.time_range)
    .replaceAll("${start_date}", start.toISOString().slice(0, 10))
    .replaceAll("${end_date}", end.toISOString().slice(0, 10));
}

async function collectProductSearch(
  config: RadarConfig,
  context: RuntimeContext,
  source: { domain: string; query: string; name?: string; country?: string; allowed_path_fragments?: string[] },
  kind: "sports" | "official-event-calendar",
): Promise<ProductSearchRun> {
  const query = productSearchQuery(source.query, context);
  const sourceName = source.name ?? source.domain;
  const scope = source.country ?? "全球共享";
  const execution: SourceExecutionRecord = {
    source_line: "媒体", source_kind: kind, country: source.country,
    source_name: sourceName,
    request_key: `media:${kind}:${source.country ?? "global"}:${source.domain}`,
    status: "running",
    request_payload: { query, include_domains: [source.domain], max_results: 4, scope },
  };
  context.onProgress?.(`正在收集${kind === "sports" ? "体育赛事" : "官方活动"}：${scope} · ${sourceName}`);
  try {
    // 赛历以活动日期为准；常驻赛历的发布日期可能早于活动，不能套新闻发布日期过滤。
    const response = await searchWeb(config, { query, domain: source.domain, maxResults: 4, mode: "general" });
    const checked = validateSearchResults(response, source.domain, {
      mode: "event", allowedPathFragments: source.allowed_path_fragments,
    });
    return {
      source_name: sourceName, source_kind: kind, country: source.country, query,
      results: checked.valid,
      execution: {
        ...execution, status: checked.valid.length ? "success" : "partial", item_count: checked.valid.length,
        response_payload: checked,
        error: checked.valid.length ? undefined : `搜索返回${checked.received}条，没有通过域名、正文、URL及去重校验的活动页面`,
      },
    };
  } catch (error) {
    return {
      source_name: sourceName, source_kind: kind, country: source.country, query, results: [],
      execution: { ...execution, status: "failed", item_count: 0, error: error instanceof Error ? error.message : String(error) },
    };
  }
}

export async function collectSports(config: RadarConfig, context: RuntimeContext, country?: string) {
  const countrySources = SOURCE_CATALOG.country_sports_searches as Record<string, string[][]>;
  const searches = country ? countrySources[country] ?? [] : SOURCE_CATALOG.sports_searches;
  return mapLimit(searches, config.site_concurrency, ([domain, query]) =>
    collectProductSearch(config, context, { domain, query, country }, "sports"));
}

export async function collectOfficialEvents(config: RadarConfig, context: RuntimeContext, country: string) {
  const sources = (SOURCE_CATALOG.official_event_sources as EventSource[]).filter((source) => source.country === country);
  return mapLimit(sources, config.site_concurrency, (source) =>
    collectProductSearch(config, context, source, "official-event-calendar"));
}

export function sportsRecords(runs: ProductSearchRun[]): SportsResult[] {
  return runs.filter((run) => run.source_kind === "sports").map((run) => ({
    country: run.country, scope: run.country ? "country" : "global",
    source_name: run.source_name, query: run.query, results: run.results,
  }));
}

export function productSourceLines(runs: ProductSearchRun[], maxCharacters: number) {
  const rows = runs.flatMap((run) => run.results.map((result) => ({
    source_kind: run.source_kind, source_name: run.source_name, market_scope: run.country ?? "全球共享（需本国证据佐证）",
    title: result.title, content: result.content ?? "", url: result.url,
    published_date: result.published_date,
  })));
  const metadataLength = rows.reduce((length, row) => length + JSON.stringify({ ...row, content: "" }).length + 1, 0);
  const contentLength = Math.max(0, Math.floor((maxCharacters - metadataLength) / Math.max(rows.length, 1)));
  // 为每个来源均匀保留摘要，不能从总字符串末尾切掉后面站点的URL或整条材料。
  return rows.map((row) => JSON.stringify({ ...row, content: row.content.slice(0, Math.min(1000, contentLength)) })).join("\n");
}

const monthNames = ["Jan(?:uary)?", "Feb(?:ruary)?", "Mar(?:ch)?", "Apr(?:il)?", "May", "Jun(?:e)?", "Jul(?:y)?", "Aug(?:ust)?", "Sep(?:t(?:ember)?)?", "Oct(?:ober)?", "Nov(?:ember)?", "Dec(?:ember)?"];

// 日期必须出现在来源摘要中；不能把网页发布日期当成赛事日期或让模型自行推测。
export function hasEventDateEvidence(result: SearchResult, date: string) {
  const [year, month, day] = date.split("-").map(Number);
  const text = `${result.title ?? ""} ${result.content ?? ""}`;
  if (!year || month < 1 || month > 12 || !day) return false;
  const monthName = monthNames[month - 1];
  return [
    new RegExp(`(?<!\\d)${year}[-/.年]0?${month}[-/.月]0?${day}(?:日|\\b)`),
    new RegExp(`\\b${monthName}\\.?\\s+${day}(?:st|nd|rd|th)?(?:\\s*[-–—]\\s*\\d{1,2})?,?\\s+${year}\\b`, "i"),
    new RegExp(`\\b${day}(?:st|nd|rd|th)?\\s+${monthName}\\.?,?\\s+${year}\\b`, "i"),
  ].some((pattern) => pattern.test(text));
}

export function routeProductEvents(
  candidates: RadarEvent[], countryName: string, country: CountryConfig,
  context: RuntimeContext, sources: ProductSearchRun[], holidayDates: Set<string>,
) {
  const events: RadarEvent[] = [];
  let rejected = 0;
  const { start, end } = timeWindow(context.current_date, context.time_range);
  const evidence = sources.flatMap((source) => source.results.map((result) => ({ source, result })));
  const localUrls = new Set(evidence.filter(({ source }) => source.country === countryName).map(({ result }) => result.url));
  for (const candidate of candidates) {
    const date = normalizeDate(candidate.date);
    const parsedDate = date ? new Date(`${date}T00:00:00Z`) : new Date(NaN);
    const sourceUrl = String(candidate.source_url ?? "");
    const matching = evidence.find(({ result }) => result.url === sourceUrl);
    const holiday = candidate.source_kind === "nager" && date && holidayDates.has(date);
    if ((candidate.country && candidate.country !== countryName) || !date || !Number.isFinite(parsedDate.getTime())
      || parsedDate.toISOString().slice(0, 10) !== date || (!matching && !holiday)) {
      rejected += 1;
      continue;
    }
    const isEvent = matching && matching.source.source_kind !== "tavily";
    if (isEvent) {
      if (parsedDate < start || parsedDate > end || !hasEventDateEvidence(matching.result, date)) {
        rejected += 1;
        continue;
      }
      // 全球赛事不能自动复制给每个国家，必须引用该国采集到的关联材料并说明关系。
      const sourceUrls = Array.isArray(candidate.source_urls) ? candidate.source_urls.map(String) : [];
      if (!matching.source.country && (!String(candidate.market_relevance ?? "").trim()
        || !sourceUrls.some((url) => localUrls.has(url)))) {
        rejected += 1;
        continue;
      }
    }
    const sourceKind = matching?.source.source_kind ?? "nager";
    const event: RadarEvent = { ...candidate, country: countryName, region: country.region, currency: country.currency, date,
      source_kind: sourceKind, data_source: "Tavily媒体搜索" };
    if (isEvent) {
      const fingerprint = crypto.createHash("sha256").update(`${sourceUrl}|${candidate.event_name}`).digest("hex").slice(0, 12);
      event.event_id = `${country.code}_${sourceKind === "sports" ? "SPORT" : "EVENT"}_${fingerprint}_${date.replaceAll("-", "")}_${candidate.stage ?? "预告期"}`;
      event.source = `${matching.source.source_name} ${sourceUrl}`;
      event.source_urls = [...new Set([sourceUrl, ...(Array.isArray(candidate.source_urls) ? candidate.source_urls.map(String).filter((url) => evidence.some(({ result }) => result.url === url)) : [])])];
    }
    events.push(event);
  }
  return { events, rejected };
}
