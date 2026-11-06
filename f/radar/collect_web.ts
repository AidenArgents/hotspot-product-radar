import { SOURCE_CATALOG } from "./source_catalog.ts";
import { callGemini, geminiFailurePayload } from "./gemini.ts";
import { parseGdacs } from "./gdacs.ts";
import { fetchText } from "./http.ts";
import { countriesForTarget, dedupeEvents, isLineSelected, mapLimit, normalizeDate, normalizeTargetCountry } from "./lib.ts";
import { parseRss } from "./rss.ts";
import type {
  BranchResult,
  RadarConfig,
  RuntimeContext,
  SourceExecutionRecord,
} from "./types.ts";

type RssFeedConfig = {
  name: string;
  url: string;
  country?: string;
  max_age_days?: number;
  official?: boolean;
};

const GDACS_ISO3_BY_COUNTRY: Record<string, string> = {
  美国: "USA",
  越南: "VNM", 泰国: "THA", 印尼: "IDN", 菲律宾: "PHL",
  马来西亚: "MYS", 新加坡: "SGP", 巴西: "BRA", 墨西哥: "MEX",
};

export async function collectWeb(
  config: RadarConfig,
  context: RuntimeContext,
  analyzeProducts = true,
): Promise<BranchResult> {
  if (!isLineSelected(context.data_lines, "网页")) {
    return {
      line: "网页",
      data_source: "RSS/新闻",
      events: [],
      top10_events: [],
      analysis: "RSS/新闻: 跳过",
      executions: [
        {
          source_line: "网页",
          source_kind: "branch",
          request_key: "web:branch",
          status: "skipped",
        },
      ],
    };
  }

  const enabledCountries = countriesForTarget(context.target_region, config.enabled_countries);
  const enabledCountrySet = new Set(enabledCountries);
  const seenTitles = new Set<string>();
  context.onProgress?.('正在收集网页 RSS 资讯...');
  const gdacsConfig = SOURCE_CATALOG.gdacs;
  const gdacsPromise = (async () => {
    context.onProgress?.("正在收集 GDACS 灾害预警...");
    try {
      const xml = await fetchText(gdacsConfig.url, {
        headers: {
          "User-Agent": "HotspotProductRadar/8.0 RSS Reader",
          Accept: "application/rss+xml, application/xml, text/xml",
        },
        timeoutMs: Math.max(config.request_timeout_ms, 30000),
        retries: 1,
      });
      const parsedAll = parseGdacs(xml, {
        currentDate: context.current_date,
        maxAgeDays: gdacsConfig.max_age_days,
        maxItems: gdacsConfig.max_items,
      });
      const parsed = {
        ...parsedAll,
        alerts: parsedAll.alerts.filter((alert) => enabledCountrySet.has(alert.country)),
      };
      return {
        articles: parsed.alerts.map((alert) => alert.line),
        execution: {
          source_line: "网页",
          source_kind: "gdacs",
          source_name: gdacsConfig.name,
          request_key: "web:gdacs:target-countries",
          status: parsed.alerts.length ? "success" : "partial",
          item_count: parsed.alerts.length,
          request_payload: {
            url: gdacsConfig.url,
            target_countries: enabledCountries.map((country) => GDACS_ISO3_BY_COUNTRY[country]),
            max_age_days: gdacsConfig.max_age_days,
          },
          response_payload: parsed,
          error: parsed.alerts.length ? undefined : "GDACS当前没有启用国家的近期有效预警",
        } satisfies SourceExecutionRecord,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        articles: [],
        execution: {
          source_line: "网页",
          source_kind: "gdacs",
          source_name: gdacsConfig.name,
          request_key: "web:gdacs:target-countries",
          status: "failed",
          request_payload: { url: gdacsConfig.url },
          error: message,
        } satisfies SourceExecutionRecord,
      };
    }
  })();
  const feedRuns = await mapLimit(
    (SOURCE_CATALOG.rss_feeds as RssFeedConfig[])
      .filter((feed) => !feed.country || enabledCountrySet.has(feed.country)),
    config.site_concurrency,
    async (feed) => {
      try {
        const xml = await fetchText(feed.url, {
          headers: {
            "User-Agent": "Mozilla/5.0 RSS Reader",
            Accept: "application/rss+xml, application/xml, text/xml",
          },
          timeoutMs: Math.max(config.request_timeout_ms, 30000),
          retries: 1,
        });
        const parsed = parseRss(xml, {
          sourceName: feed.name,
          country: feed.country,
          currentDate: context.current_date,
          maxAgeDays: feed.max_age_days ?? 14,
          seenTitles,
          maxItems: 30,
        });
        const articles = parsed.articles.map((article) => article.line);
        return {
          articles,
          official: Boolean(feed.official),
          execution: {
            source_line: "网页",
            source_kind: "rss",
            country: feed.country,
            source_name: feed.name,
            request_key: `web:rss:${feed.name}`,
            status: articles.length ? "success" : "partial",
            item_count: articles.length,
            request_payload: { url: feed.url },
            response_payload: parsed,
            error: articles.length
              ? undefined
              : `RSS共${parsed.total}条，但没有通过${feed.max_age_days ?? 14}天新鲜度和重复校验的内容`,
          } satisfies SourceExecutionRecord,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          articles: [],
          official: Boolean(feed.official),
          execution: {
            source_line: "网页",
            source_kind: "rss",
            country: feed.country,
            source_name: feed.name,
            request_key: `web:rss:${feed.name}`,
            status: "failed",
            request_payload: { url: feed.url },
            error: message,
          } satisfies SourceExecutionRecord,
        };
      }
    },
  );
  const gdacsRun = await gdacsPromise;

  const allArticles = [gdacsRun, ...feedRuns].flatMap(
    (run) => run.articles,
  );
  const executions: SourceExecutionRecord[] = [gdacsRun, ...feedRuns].map(
    (run) => run.execution,
  );
  const validArticles = allArticles;
  if (validArticles.length === 0) {
    const errors = executions.map((execution) => execution.error).filter(Boolean).join(" | ");
    return {
      line: "网页",
      data_source: "RSS/新闻",
      events: [],
      top10_events: [],
      analysis: `RSS全部拉取失败: ${errors}`,
      executions,
    };
  }

  // 网页线路仍一次分析全部目标国家，但只保留设置中启用的国家。
  const targetCountries = enabledCountries.join("、");
  // 各来源限额，避免任一大 RSS 或 GDACS 吞掉 Gemini 的字符预算。
  const promptLines = [
    ...gdacsRun.articles.slice(0, 8),
    ...feedRuns.filter((run) => run.official).flatMap((run) => run.articles.slice(0, 4)),
    ...feedRuns.filter((run) => !run.official).flatMap((run) => run.articles.slice(0, 2)),
  ];
  if (!analyzeProducts) {
    return {
      line: "网页",
      data_source: "RSS/新闻/GDACS",
      events: [],
      top10_events: [],
      analysis: `共享证据：RSS ${SOURCE_CATALOG.rss_feeds.length}源+GDACS，共${validArticles.length}条`,
      executions,
    };
  }
  const prompt = `你是跨境电商选品专家。今天：${context.current_date}，时间范围：${context.time_range}

数据来源：官方通讯社RSS + 现有RSS新闻订阅 + GDACS结构化灾害预警
目标国家：${targetCountries}（只分析与这${enabledCountries.length}个已启用国家相关的新闻）
规则：不卖服装鞋类！所有内容用中文。

从以下新闻中，筛选与上述已启用国家相关的热点，找出有跨境电商选品价值的事件。
对每个事件输出：event_id, event_name(中文), event_type, country(中文，仅限${enabledCountries.join("、")}), region(北美、东南亚或拉美，按国家填写), currency, date(YYYY-MM-DD), stage(预告期/进行中/已过/节后余温), source("RSS/新闻"), ecommerce_score(0-100), products(3个,含name中文/category/price_range当地货币/keywords_en[]/keywords_local[]), best_listing_time(中文), why_sellable(中文)

如果没有与这些已启用国家相关的新闻，输出 {"events": []}
只输出纯JSON，直接以 {"events":[ 开头。最多10个事件。

新闻与预警数据(RSS ${SOURCE_CATALOG.rss_feeds.length}源 + GDACS, 有效${validArticles.length}条，本次均衡送入${promptLines.length}条)：
${promptLines.join("\n").slice(0, 15000)}`;

  context.onProgress?.('正在通过 Gemini 分析全局新闻热点...');

  try {
    const response = await callGemini(config, prompt, context.onProgress);
    const countryConfigs = SOURCE_CATALOG.countries as unknown as Record<
      string,
      { region: string; currency: string }
    >;
    const normalizedEvents = response.events.flatMap((event) => {
      const country = normalizeTargetCountry(event.country);
      const countryConfig = country ? countryConfigs[country] : undefined;
      if (!country || !countryConfig || !enabledCountrySet.has(country)) return [];
      return [{
        ...event,
        country,
        region: countryConfig.region,
        currency: countryConfig.currency,
        date: normalizeDate(event.date),
        data_source: "RSS/新闻/GDACS",
      }];
    });
    const events = dedupeEvents(normalizedEvents, context.history_ids);
    executions.push({
      source_line: "网页",
      source_kind: "gemini",
      source_name: config.gemini_model,
      request_key: "web:gemini:all-target-countries",
      status: response.events.length ? "success" : "partial",
      item_count: response.events.length,
      request_payload: { prompt },
      response_payload: { text: response.rawText, metadata: response.metadata },
    });
    return {
      line: "网页",
      data_source: "RSS/新闻",
      events,
      top10_events: events.slice(0, 10),
      analysis:
        `RSS ${SOURCE_CATALOG.rss_feeds.length}源+GDACS` +
        ` → ${validArticles.length}条有效证据 → ${events.length}个新事件`,
      executions,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    executions.push({
      source_line: "网页",
      source_kind: "gemini",
      source_name: config.gemini_model,
      request_key: "web:gemini:all-target-countries",
      status: "failed",
      request_payload: { prompt },
      response_payload: geminiFailurePayload(error),
      error: message,
    });
    return {
      line: "网页",
      data_source: "RSS/新闻",
      events: [],
      top10_events: [],
      analysis: `RSS/新闻: Gemini错误 ${message}`,
      executions,
    };
  }
}

export async function main(config: RadarConfig, context: RuntimeContext) {
  return collectWeb(config, context);
}
