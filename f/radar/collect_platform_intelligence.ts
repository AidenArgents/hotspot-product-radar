import crypto from "node:crypto";
import { SOURCE_CATALOG } from "./source_catalog.ts";
import { mapLimit } from "./lib.ts";
import { mediaPublicationWindow, searchWeb, validateSearchResults } from "./web_search.ts";
import type { EvidenceItem, RadarConfig, SourceExecutionRecord, TimeRange } from "./types.ts";

type PlatformOfficialSource = {
  country: string;
  platform: string;
  name: string;
  domain: string;
  url?: string;
  query: string;
};

type PlatformMediaSource = {
  name: string;
  domain: string;
  regions?: string[];
  countries?: string[];
  tier: "A" | "B";
  search_mode?: "general" | "news";
  query: string;
  queries_by_region?: Record<string, string>;
};

const countryAliases: Record<string, string[]> = {
  美国: ["美国", "美國", "united states", "usa", "u.s."],
  越南: ["越南", "vietnam", "vietnamese", "viet nam"],
  泰国: ["泰国", "泰國", "thailand", "thai"],
  印尼: ["印尼", "印度尼西亚", "印度尼西亞", "indonesia", "indonesian"],
  菲律宾: ["菲律宾", "菲律賓", "philippines", "philippine"],
  马来西亚: ["马来西亚", "馬來西亞", "malaysia", "malaysian"],
  新加坡: ["新加坡", "singapore"],
  巴西: ["巴西", "brazil", "brasil", "brazilian"],
  墨西哥: ["墨西哥", "mexico", "méxico", "mexican"],
};

function searchableText(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

export function inferPlatformCountries(text: string, allowedCountries: string[]): string[] {
  const normalized = searchableText(text);
  return allowedCountries.filter((country) =>
    (countryAliases[country] ?? [country]).some((alias) => normalized.includes(searchableText(alias))));
}

function inferPlatform(text: string) {
  const normalized = searchableText(text);
  if (normalized.includes("shopee") || normalized.includes("虾皮") || normalized.includes("蝦皮")) return "Shopee";
  if (normalized.includes("lazada")) return "Lazada";
  if (normalized.includes("tiktok shop") || normalized.includes("tiktokshop")) return "TikTok Shop";
  if (normalized.includes("walmart") || normalized.includes("沃尔玛") || normalized.includes("沃爾瑪")) return "Walmart";
  if (normalized.includes("amazon") || normalized.includes("亚马逊") || normalized.includes("亞馬遜")) return "Amazon";
  if (normalized.includes("ebay")) return "eBay";
  if (normalized.includes("mercado libre") || normalized.includes("mercado livre")) return "Mercado Libre";
  return "其他平台";
}

function evidenceId(country: string, url: string, title: string) {
  return crypto.createHash("sha256")
    .update(`${country}|${url.toLowerCase()}|${title.toLowerCase()}`)
    .digest("hex");
}

function renderQuery(template: string, currentDate: string, scopeTerms = "") {
  return template
    .replaceAll("${current_year}", currentDate.slice(0, 4))
    .replaceAll("${scope_terms}", scopeTerms);
}

function activePolicyResults<T extends { title?: string; content?: string; url?: string; published_date?: string }>(
  items: T[],
  currentDate: string,
  requireDateEvidence: boolean,
) {
  const currentYear = currentDate.slice(0, 4);
  return items.filter((item) => {
    const text = `${item.title ?? ""} ${item.content ?? ""}`;
    if (/\bdeprecated\b|\bobsolete\b|\barchived\b|已失效|已废止|已下线/i.test(text)) return false;
    if (!requireDateEvidence || item.published_date) return true;
    const urlYear = String(item.url ?? "").match(/(?:^|\D)(20\d{2})(?:\d{4})?(?:\D|$)/)?.[1];
    if (urlYear && urlYear !== currentYear) return false;
    return `${item.title ?? ""} ${String(item.content ?? "").slice(0, 900)}`.includes(currentYear);
  });
}

function isPlatformChangeCandidate(title: string, summary: string) {
  const text = searchableText(`${title} ${summary.slice(0, 900)}`);
  const titleText = searchableText(title);
  const hasPlatform = /shopee|虾皮|蝦皮|lazada|tiktok\s*shop|mercado\s*(?:libre|livre)|walmart|沃尔玛|沃爾瑪|amazon|亚马逊|亞馬遜|ebay/i.test(text);
  const platformInTitle = /shopee|虾皮|蝦皮|lazada|tiktok\s*shop|mercado\s*(?:libre|livre)|walmart|沃尔玛|沃爾瑪|amazon|亚马逊|亞馬遜|ebay/i.test(titleText);
  const isDigest = /周报|週報|汇总|彙總|盘点|盤點|综述|綜述|平台动态|平台動態|东南亚电商|東南亞電商|latin america ecommerce/i.test(titleText);
  const hasChange = /佣金|费率|費率|手续费|手續費|交易费|交易費|支付|钱包|錢包|物流|履约|履約|退货|退貨|退款|规则|規則|政策|禁售|处罚|處罰|接入|整合|上线|上線|调整|調整|流量|访问量|訪問量|市场份额|市場份額|commission|fee|payment|wallet|logistics|fulfilment|fulfillment|return|refund|policy|rule|prohibited|penalty|integration|launch|increase|decrease|update|traffic|market\s*share|gmv/i.test(text);
  const placeholder = /\{.+标题.+\}|^shopee\s*(?:虾皮|蝦皮)?$|官网入口|官網入口|卖家注册$|賣家註冊$|\/news$/i.test(titleText);
  return hasPlatform && (platformInTitle || isDigest) && hasChange && !placeholder;
}

export async function collectPlatformIntelligence(
  config: RadarConfig,
  input: {
    countries: string[];
    currentDate: string;
    timeRange: TimeRange;
    onProgress?: (text: string) => void;
  },
) {
  const countryConfigs = SOURCE_CATALOG.countries as unknown as Record<string, { region: string }>;
  const window = mediaPublicationWindow(input.currentDate, input.timeRange);
  const officialSources = (SOURCE_CATALOG.platform_official_sources as PlatformOfficialSource[])
    .filter((source) => input.countries.includes(source.country));

  const officialRuns = await mapLimit(officialSources, config.site_concurrency, async (source) => {
    input.onProgress?.(`正在收集平台官方公告：${source.country} · ${source.platform}`);
    const query = renderQuery(source.query, input.currentDate);
    try {
      const response = await searchWeb(config, {
        query,
        domain: source.domain,
        maxResults: 6,
        mode: "news",
        startDate: window.start_date,
        endDate: window.end_date,
      });
      const checked = validateSearchResults(response, source.domain, {
        mode: "news",
        startDate: window.start_date,
        endDate: window.end_date,
      });
      const valid = activePolicyResults(checked.valid, input.currentDate, false);
      const evidence = valid.map((item) => {
        const title = String(item.title ?? "");
        const url = String(item.url ?? "");
        return {
          evidence_id: evidenceId(source.country, url, title),
          country: source.country,
          region: countryConfigs[source.country]?.region ?? "",
          publisher: source.name,
          acquisition_method: "Tavily Search API · 平台官方域名限定",
          source_kind: "platform-official",
          title,
          summary: String(item.content ?? ""),
          url,
          published_at: item.published_date,
          authority: "平台官方公告",
          raw: { ...item, platform: source.platform, source_tier: "official" },
        } satisfies EvidenceItem;
      });
      return {
        evidence,
        execution: {
          source_line: "运营",
          source_kind: "platform-official",
          country: source.country,
          source_name: source.name,
          request_key: `operations:platform-official:${source.country}:${source.domain}`,
          status: evidence.length ? "success" : "partial",
          item_count: evidence.length,
          request_payload: {
            platform: source.platform,
            query,
            include_domains: [source.domain],
            start_date: window.start_date,
            end_date: window.end_date,
          },
          response_payload: { ...checked, valid, inactive_or_undated: checked.valid.length - valid.length },
          error: evidence.length ? undefined
            : checked.received === 0
              ? "搜索引擎在该平台官方域名和日期窗口内没有返回公告"
              : `搜索引擎返回${checked.received}条，其中${checked.rejected}条未通过域名、日期、正文或页面有效性校验`,
        } satisfies SourceExecutionRecord,
      };
    } catch (error) {
      return {
        evidence: [] as EvidenceItem[],
        execution: {
          source_line: "运营",
          source_kind: "platform-official",
          country: source.country,
          source_name: source.name,
          request_key: `operations:platform-official:${source.country}:${source.domain}`,
          status: "failed",
          item_count: 0,
          request_payload: { platform: source.platform, query, include_domains: [source.domain] },
          error: error instanceof Error ? error.message : String(error),
        } satisfies SourceExecutionRecord,
      };
    }
  });

  const mediaSources = SOURCE_CATALOG.platform_industry_media_sources as PlatformMediaSource[];
  const mediaTasks = mediaSources.flatMap((source) => {
    if (source.countries?.length) {
      const countries = source.countries.filter((country) => input.countries.includes(country));
      return countries.length ? [{ source, scopeName: countries.join("、"), countries, fixedCountryScope: true }] : [];
    }
    return (source.regions ?? []).flatMap((region) => {
      const countries = input.countries.filter((country) => countryConfigs[country]?.region === region);
      return countries.length ? [{ source, scopeName: region, countries, fixedCountryScope: region === "北美" && countries.length === 1 }] : [];
    });
  });

  const mediaRuns = await mapLimit(mediaTasks, config.site_concurrency, async ({ source, scopeName, countries, fixedCountryScope }) => {
    input.onProgress?.(`正在收集跨境行业媒体：${source.name} · ${scopeName}`);
    const queryTemplate = source.queries_by_region?.[scopeName] ?? source.query;
    const query = renderQuery(queryTemplate, input.currentDate, countries.join(" "));
    const executionName = `${source.name}·${scopeName}`;
    try {
      const response = await searchWeb(config, {
        query,
        domain: source.domain,
        maxResults: 8,
        mode: source.search_mode ?? "news",
        startDate: window.start_date,
        endDate: window.end_date,
      });
      const checked = validateSearchResults(response, source.domain, {
        mode: source.search_mode ?? "news",
        startDate: window.start_date,
        endDate: window.end_date,
      });
      const valid = activePolicyResults(checked.valid, input.currentDate, true);
      const evidence = valid.flatMap((item) => {
        const title = String(item.title ?? "");
        const summary = String(item.content ?? "");
        const url = String(item.url ?? "");
        if (!isPlatformChangeCandidate(title, summary)) return [];
        const allKnownCountries = Object.keys(countryAliases);
        const titleCountriesAll = inferPlatformCountries(title, allKnownCountries);
        const titleCountries = titleCountriesAll.filter((country) => countries.includes(country));
        if (titleCountriesAll.length && !titleCountries.length) return [];
        const titleHasDifferentMarket = /美国|美國|英国|英國|欧洲|歐洲|欧盟|歐盟|日本|韩国|韓國|加拿大|澳大利亚|澳大利亞|德国|德國|法国|法國|意大利|西班牙|中东|中東|united states|\busa\b|united kingdom|\buk\b|europe|japan|korea|canada|australia/i.test(title)
          || (!countries.includes("美国") && /amazon/i.test(title));
        if (!titleCountries.length && titleHasDifferentMarket) return [];
        const text = `${title} ${summary.slice(0, 400)} ${url}`;
        const textCountriesAll = inferPlatformCountries(text, allKnownCountries);
        let matchedCountries = titleCountries.length
          ? titleCountries
          : textCountriesAll.filter((country) => countries.includes(country));
        if (!matchedCountries.length && textCountriesAll.length) return [];
        const normalized = searchableText(text);
        if (!matchedCountries.length && fixedCountryScope && countries.length === 1) matchedCountries = countries;
        if (!matchedCountries.length && (
          (scopeName === "东南亚" && (normalized.includes("东南亚") || normalized.includes("southeast asia")))
          || (scopeName === "拉美" && (normalized.includes("拉美") || normalized.includes("latin america")))
        )) matchedCountries = countries;
        return matchedCountries.map((country) => ({
          evidence_id: evidenceId(country, url, title),
          country,
          region: countryConfigs[country]?.region ?? "",
          publisher: source.name,
          acquisition_method: "Tavily Search API · 跨境行业媒体单站搜索",
          source_kind: "platform-media",
          title,
          summary,
          url,
          published_at: item.published_date,
          authority: source.tier === "A"
            ? "跨境行业专业/垂直媒体·一级线索"
            : "跨境行业聚合媒体·二级线索",
          raw: {
            ...item,
            platform: inferPlatform(text),
            source_tier: source.tier,
            scope: scopeName,
          },
        } satisfies EvidenceItem));
      });
      return {
        evidence,
        execution: {
          source_line: "运营",
          source_kind: "platform-media",
          country: countries.length === 1 ? countries[0] : undefined,
          source_name: executionName,
          request_key: `operations:platform-media:${scopeName}:${source.domain}`,
          status: evidence.length ? "success" : "partial",
          item_count: evidence.length,
          request_payload: {
            tier: source.tier,
            scope: scopeName,
            query,
            include_domains: [source.domain],
            start_date: window.start_date,
            end_date: window.end_date,
          },
          response_payload: {
            ...checked,
            valid,
            inactive_or_undated: checked.valid.length - valid.length,
            routed_evidence_count: evidence.length,
          },
          error: evidence.length ? undefined
            : checked.valid.length
              ? "搜索取得了页面，但正文没有明确标出目标国家或区域"
              : `搜索引擎返回${checked.received}条，但没有通过日期、域名和正文校验的有效平台新闻`,
        } satisfies SourceExecutionRecord,
      };
    } catch (error) {
      return {
        evidence: [] as EvidenceItem[],
        execution: {
          source_line: "运营",
          source_kind: "platform-media",
          country: countries.length === 1 ? countries[0] : undefined,
          source_name: executionName,
          request_key: `operations:platform-media:${scopeName}:${source.domain}`,
          status: "failed",
          item_count: 0,
          request_payload: { tier: source.tier, scope: scopeName, query, include_domains: [source.domain] },
          error: error instanceof Error ? error.message : String(error),
        } satisfies SourceExecutionRecord,
      };
    }
  });

  return {
    evidence: [...officialRuns.flatMap((run) => run.evidence), ...mediaRuns.flatMap((run) => run.evidence)],
    executions: [...officialRuns.map((run) => run.execution), ...mediaRuns.map((run) => run.execution)],
  };
}
