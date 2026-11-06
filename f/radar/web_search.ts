import { fetchJson } from "./http.ts";
import type { RadarConfig, TimeRange } from "./types.ts";
import SOURCE_CATALOG from "../../config/source_catalog.json" with { type: "json" };

export interface SearchResult {
  title?: string;
  content?: string;
  url?: string;
  score?: number;
  published_date?: string;
}

export interface SearchResponse {
  answer?: string;
  results?: SearchResult[];
}

export type SearchMode = "news" | "event" | "general";

// ── publication window ──────────────────────────────────────────────

export function mediaPublicationWindow(currentDate: string, range: TimeRange) {
  const end = new Date(`${currentDate}T00:00:00Z`);
  const start = new Date(end);
  const lookbackDays = range === "今天" ? 2
    : range === "近3天" ? 2
    : range === "本周" ? 8
    : range === "本月" ? 35
    : 90;
  start.setUTCDate(start.getUTCDate() - lookbackDays);
  return {
    start_date: start.toISOString().slice(0, 10),
    end_date: end.toISOString().slice(0, 10),
  };
}

export function isConcreteArticleUrl(value: string) {
  try {
    const parsed = new URL(value);
    const pathname = parsed.pathname.replace(/\/+$/, "").toLowerCase();
    if (!pathname || pathname === "/") return false;
    const segments = pathname.split("/").filter(Boolean);
    const lastSegment = segments.at(-1) ?? "";
    const genericPages = new Set([
      "news", "search", "search-results", "category", "categories", "tag", "tags",
      "topic", "topics", "faq", "help", "helpcenter", "help-centre",
    ]);
    if (genericPages.has(lastSegment)) return false;
    if (/\/(?:search|search-results)(?:\/|$)/.test(pathname)) return false;
    return true;
  } catch {
    return false;
  }
}

// ── search backends ─────────────────────────────────────────────────

interface SearchInput {
  query: string;
  domain: string;
  maxResults: number;
  mode: SearchMode;
  startDate?: string;
  endDate?: string;
}

async function tavilySearch(
  config: RadarConfig,
  input: SearchInput,
): Promise<SearchResponse> {
  const body: Record<string, unknown> = {
    api_key: config.tavily_api_key,
    query: input.query,
    search_depth: input.mode === "event" ? "advanced" : "basic",
    max_results: input.maxResults,
    include_answer: false,
    include_domains: [input.domain],
  };
  if (input.mode === "news") {
    body.topic = "news";
    if (input.startDate) body.start_date = input.startDate;
    if (input.endDate) body.end_date = input.endDate;
  }
  return fetchJson<SearchResponse>("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs: config.request_timeout_ms,
    retries: 1,
  });
}

// ── Tavily dispatcher ───────────────────────────────────────────────

export async function searchWeb(
  config: RadarConfig,
  input: SearchInput,
): Promise<SearchResponse> {
  if (!config.tavily_api_key) throw new Error("Tavily 搜索需要配置 API Key");
  return tavilySearch(config, input);
}

// ── validation utilities ────────────────────────────────────────────

function normalizedHost(value: string) {
  return value.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
}

function isExpectedDomain(urlValue: string, domainValue: string) {
  try {
    const host = normalizedHost(new URL(urlValue).hostname);
    const domain = normalizedHost(domainValue);
    return host === domain || host.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

function normalizedTitle(value: string) {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function validateSearchResults(
  response: SearchResponse,
  domain: string,
  options: {
    mode: SearchMode;
    startDate?: string;
    endDate?: string;
    allowedPathFragments?: string[];
  },
) {
  const valid: SearchResult[] = [];
  const seenUrls = new Set<string>();
  const seenTitles = new Set<string>();
  let rejected = 0;
  for (const result of response.results ?? []) {
    const title = String(result.title ?? "").trim();
    const content = String(result.content ?? "").trim();
    const url = String(result.url ?? "").trim();
    const titleKey = normalizedTitle(title);
    const blockedText = `${title} ${content}`.toLowerCase();
    if (title.length < 6 || !url || !isExpectedDomain(url, domain)) {
      rejected += 1;
      continue;
    }
    if (/privacy error|connection is not private|err_cert|access denied|captcha/.test(blockedText)) {
      rejected += 1;
      continue;
    }
    if (content.length < 20) {
      rejected += 1;
      continue;
    }
    try {
      const pathname = new URL(url).pathname.replace(/\/+$/, "");
      if (!pathname || pathname === "/") {
        rejected += 1;
        continue;
      }
      if (options.allowedPathFragments?.length
        && !options.allowedPathFragments.some((fragment) =>
          pathname.toLowerCase().includes(fragment.toLowerCase()))) {
        rejected += 1;
        continue;
      }
    } catch {
      rejected += 1;
      continue;
    }
    if (options.mode === "news" && options.startDate && options.endDate) {
      if (!result.published_date) {
        rejected += 1;
        continue;
      }
      const published = new Date(result.published_date);
      const start = new Date(`${options.startDate}T00:00:00Z`);
      const end = new Date(`${options.endDate}T23:59:59.999Z`);
      if (!Number.isFinite(published.getTime()) || published < start || published > end) {
        rejected += 1;
        continue;
      }
    }
    if (seenUrls.has(url) || (titleKey && seenTitles.has(titleKey))) {
      rejected += 1;
      continue;
    }
    seenUrls.add(url);
    if (titleKey) seenTitles.add(titleKey);
    valid.push({ ...result, title, content, url });
  }
  return { valid, rejected, received: response.results?.length ?? 0 };
}

export function searchResultLines(results: SearchResult[], sourceName: string) {
  return results.map((result) => {
    const date = result.published_date ? ` ${result.published_date}` : "";
    const content = String(result.content ?? "").replace(/\s+/g, " ").slice(0, 320);
    return `[${sourceName}]${date} ${result.title}${content ? ` - ${content}` : ""} | ${result.url}`;
  });
}
