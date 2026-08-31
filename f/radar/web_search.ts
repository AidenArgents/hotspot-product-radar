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

// ── Google CSE dual-engine domain routing ───────────────────────────

/** Compute parent domain for CSE site-config purposes.
 *  e.g. help.shopee.vn → shopee.vn, seller-vn.tiktok.com → tiktok.com */
function cseDomainParent(domain: string): string {
  if (domain.startsWith("help.")) return domain.slice(5);
  if (domain.startsWith("sellercenter.")) return domain.slice(13);
  if (/^seller-[a-z]{2}\./.test(domain)) return domain.split(".").slice(1).join(".");
  if (domain.startsWith("vendedores.")) return domain.slice(11);
  if (domain.startsWith("world.")) return domain.slice(6);
  if (domain.startsWith("g1.")) return domain.slice(3);
  if (domain.startsWith("folha.")) return domain.slice(6);
  return domain;
}

/** Build a deterministic mapping of original-domain → "a" | "b". */
let _domainGroupCache: Map<string, "a" | "b"> | null = null;

function domainGroupMap(): Map<string, "a" | "b"> {
  if (_domainGroupCache) return _domainGroupCache;

  const allDomains = new Set<string>();

  const targetRegions = new Set(["东南亚", "拉美"]);
  const targetCountries = new Set<string>();
  for (const [region, list] of Object.entries((SOURCE_CATALOG as any).regions ?? {})) {
    if (targetRegions.has(region)) (list as string[]).forEach(c => targetCountries.add(c));
  }

  // product intelligence — country media
  const countries = (SOURCE_CATALOG as any).countries ?? {};
  for (const [name, c] of Object.entries(countries) as [string, any][]) {
    if (targetCountries.has(name) && c.media) {
      for (const [domain] of c.media) allDomains.add(domain);
    }
  }
  // operations intelligence
  for (const key of ["platform_official_sources", "platform_industry_media_sources", "operations_official_sources"]) {
    for (const item of (SOURCE_CATALOG as any)[key] ?? []) {
      if (item.domain) allDomains.add(item.domain);
    }
  }

  // compute unique CSE parent domains and sort
  const parentToDomains = new Map<string, string[]>();
  for (const d of allDomains) {
    const parent = cseDomainParent(d);
    if (!parentToDomains.has(parent)) parentToDomains.set(parent, []);
    parentToDomains.get(parent)!.push(d);
  }

  const sortedParents = [...parentToDomains.keys()].sort();
  const groupA = new Set(sortedParents.slice(0, 50));

  const mapping = new Map<string, "a" | "b">();
  for (const [parent, originals] of parentToDomains) {
    const group = groupA.has(parent) ? "a" : "b";
    for (const orig of originals) mapping.set(orig, group);
  }

  _domainGroupCache = mapping;
  return mapping;
}

function googleCxForDomain(config: RadarConfig, domain: string): string {
  const group = domainGroupMap().get(domain) ?? "a";
  return group === "a" ? config.google_search_cx_a : config.google_search_cx_b;
}

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

async function googleSearch(
  config: RadarConfig,
  input: SearchInput,
): Promise<SearchResponse> {
  const cx = googleCxForDomain(config, input.domain);
  if (!cx) throw new Error(`Google CSE: 找不到域名 ${input.domain} 对应的引擎 CX`);

  const url = new URL("https://customsearch.googleapis.com/customsearch/v1");
  url.searchParams.set("key", config.google_search_api_key);
  url.searchParams.set("cx", cx);
  url.searchParams.set("num", String(Math.min(input.maxResults, 10)));

  let q = input.query;
  if (!q.includes(`site:${input.domain}`)) {
    q = `${q} site:${input.domain}`;
  }
  url.searchParams.set("q", q);

  if (input.mode === "news" || input.startDate) {
    if (input.startDate) {
      const today = new Date();
      const start = new Date(input.startDate);
      const days = Math.max(1, Math.ceil((today.getTime() - start.getTime()) / (1000 * 3600 * 24)));
      url.searchParams.set("dateRestrict", `d${days}`);
    } else {
      url.searchParams.set("dateRestrict", "d30");
    }
  }

  const res = await fetchJson<any>(url.toString(), {
    method: "GET",
    timeoutMs: config.request_timeout_ms,
    retries: 1,
  });

  const results: SearchResult[] = (res.items || []).map((item: any) => ({
    title: item.title,
    content: item.snippet,
    url: item.link,
    published_date: input.startDate ? new Date().toISOString() : undefined,
  }));

  // extract dates from snippets
  for (const r of results) {
    if (r.content) {
      const dateMatch = r.content.match(/^([A-Z][a-z]{2} \d{1,2}, \d{4}) \.\.\. /);
      if (dateMatch) {
        try {
          const d = new Date(dateMatch[1]);
          if (!isNaN(d.getTime())) {
            r.published_date = d.toISOString();
            r.content = r.content.slice(dateMatch[0].length);
          }
        } catch {}
      }
    }
  }

  return { results };
}

// ── unified dispatcher ──────────────────────────────────────────────

export async function searchWeb(
  config: RadarConfig,
  input: SearchInput,
): Promise<SearchResponse> {
  if (config.search_engine === "google") {
    if (!config.google_search_api_key) {
      throw new Error("Google 搜索需要配置 API Key");
    }
    if (!config.google_search_cx_a && !config.google_search_cx_b) {
      throw new Error("Google 搜索需要至少配置一个引擎 CX ID");
    }
    return googleSearch(config, input);
  }
  return tavilySearch(config, input);
}

// ── export domain split for CLI/diagnostics ─────────────────────────

export function googleCxDomainSplit(): { a: string[]; b: string[] } {
  const map = domainGroupMap();
  const a: string[] = [];
  const b: string[] = [];
  const seenParents = { a: new Set<string>(), b: new Set<string>() };
  for (const [domain, group] of map) {
    const parent = cseDomainParent(domain);
    if (!seenParents[group].has(parent)) {
      seenParents[group].add(parent);
      (group === "a" ? a : b).push(parent);
    }
  }
  return { a: a.sort(), b: b.sort() };
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
