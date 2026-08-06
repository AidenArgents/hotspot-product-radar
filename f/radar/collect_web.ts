import { SOURCE_CATALOG } from "./source_catalog.ts";
import { callGemini } from "./gemini.ts";
import { fetchText } from "./http.ts";
import { isLineSelected, mapLimit } from "./lib.ts";
import type {
  BranchResult,
  RadarConfig,
  RuntimeContext,
  SourceExecutionRecord,
} from "./types.ts";

function parseRss(
  xml: string,
  sourceName: string,
  seenTitles: Set<string>,
): string[] {
  const articles: string[] = [];
  for (const item of xml.split("<item>").slice(1)) {
    const titleMatch = item.match(
      /<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/,
    );
    const descriptionMatch = item.match(
      /<description><!\[CDATA\[(.*?)\]\]><\/description>|<description>(.*?)<\/description>/s,
    );
    const title = (titleMatch?.[1] || titleMatch?.[2] || "").trim();
    const description = (descriptionMatch?.[1] || descriptionMatch?.[2] || "")
      .trim()
      .replace(/<[^>]+>/g, "")
      .slice(0, 300);
    if (title.length <= 5) continue;
    const shortTitle = title.slice(0, 20);
    if (seenTitles.has(shortTitle)) continue;
    seenTitles.add(shortTitle);
    articles.push(`[${sourceName}] ${title}${description ? ` - ${description}` : ""}`);
  }
  return articles;
}

export async function collectWeb(
  config: RadarConfig,
  context: RuntimeContext,
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

  const seenTitles = new Set<string>();
  const feedRuns = await mapLimit(
    SOURCE_CATALOG.rss_feeds,
    config.site_concurrency,
    async (feed) => {
      try {
        const xml = await fetchText(feed.url, {
          headers: {
            "User-Agent": "Mozilla/5.0 RSS Reader",
            Accept: "application/rss+xml, application/xml, text/xml",
          },
          timeoutMs: 3600000,
          retries: 1,
        });
        const articles = parseRss(xml, feed.name, seenTitles);
        return {
          articles,
          execution: {
            source_line: "网页",
            source_kind: "rss",
            source_name: feed.name,
            request_key: `web:rss:${feed.name}`,
            status: "success",
            item_count: articles.length,
            request_payload: { url: feed.url },
            response_payload: { articles },
          } satisfies SourceExecutionRecord,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          articles: [`[${feed.name}] RSS失败: ${message}`],
          execution: {
            source_line: "网页",
            source_kind: "rss",
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

  const googleNewsQueries = SOURCE_CATALOG.google_news_queries as readonly {
    name: string;
    query: string;
  }[];
  const googleNewsRuns = await mapLimit(
    googleNewsQueries,
    config.site_concurrency,
    async (item) => {
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(item.query)}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`;
      try {
        const xml = await fetchText(url, {
          headers: { "User-Agent": "Mozilla/5.0 RSS Reader" },
          timeoutMs: 3600000,
          retries: 1,
        });
        const articles = parseRss(xml, `GoogleNews-${item.name}`, seenTitles);
        return {
          articles,
          execution: {
            source_line: "网页",
            source_kind: "google-news-rss",
            source_name: item.name,
            request_key: `web:google-news:${item.name}`,
            status: "success",
            item_count: articles.length,
            request_payload: { query: item.query, url },
            response_payload: { articles },
          } satisfies SourceExecutionRecord,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          articles: [`[GoogleNews-${item.name}] 失败: ${message}`],
          execution: {
            source_line: "网页",
            source_kind: "google-news-rss",
            source_name: item.name,
            request_key: `web:google-news:${item.name}`,
            status: "failed",
            request_payload: { query: item.query, url },
            error: message,
          } satisfies SourceExecutionRecord,
        };
      }
    },
  );

  const allArticles = [...feedRuns, ...googleNewsRuns].flatMap(
    (run) => run.articles,
  );
  const executions: SourceExecutionRecord[] = [...feedRuns, ...googleNewsRuns].map(
    (run) => run.execution,
  );
  const validArticles = allArticles.filter((article) => !article.includes("失败"));
  if (validArticles.length === 0) {
    const errors = allArticles.filter((article) => article.includes("失败")).join(" | ");
    return {
      line: "网页",
      data_source: "RSS/新闻",
      events: [],
      top10_events: [],
      analysis: `RSS全部拉取失败: ${errors}`,
      executions,
    };
  }

  // 与原流程保持一致：网页线路固定筛选全部 8 个目标国家。
  const targetCountries = "越南、泰国、印尼、菲律宾、马来西亚、新加坡、巴西、墨西哥";
  const prompt = `你是跨境电商选品专家。今天：${context.current_date}，时间范围：${context.time_range}

数据来源：RSS新闻订阅 + Google新闻
目标国家：${targetCountries}（只分析与这8个国家相关的新闻）
规则：不卖服装鞋类！所有内容用中文。

从以下新闻中，筛选与上述8个国家相关的热点，找出有跨境电商选品价值的事件。
对每个事件输出：event_id, event_name(中文), event_type, country(中文), region(东南亚或拉美), currency, date(YYYY-MM-DD), stage(预告期/进行中/已过/节后余温), source("RSS/新闻"), ecommerce_score(0-100), products(3个,含name中文/category/price_range当地货币/keywords_en[]/keywords_local[]), best_listing_time(中文), why_sellable(中文)

如果没有与这8个国家相关的新闻，输出 {"events": []}
只输出纯JSON，直接以 {"events":[ 开头。最多10个事件。

新闻数据(RSS ${SOURCE_CATALOG.rss_feeds.length}源 + GoogleNews ${SOURCE_CATALOG.google_news_queries.length}源, 共${validArticles.length}条)：
${allArticles.join("\n").slice(0, 15000)}`;

  try {
    const response = await callGemini(config, prompt);
    const history = new Set(context.history_ids);
    const events = response.events
      .filter((event) => !history.has(event.event_id ?? ""))
      .map((event) => ({
        ...event,
        data_source: "RSS/新闻",
      }));
    executions.push({
      source_line: "网页",
      source_kind: "gemini",
      source_name: config.gemini_model,
      request_key: "web:gemini:all-target-countries",
      status: response.events.length ? "success" : "partial",
      item_count: response.events.length,
      request_payload: { prompt },
      response_payload: { text: response.rawText },
    });
    return {
      line: "网页",
      data_source: "RSS/新闻",
      events,
      top10_events: events.slice(0, 10),
      analysis:
        `RSS ${SOURCE_CATALOG.rss_feeds.length}源+GNews ${SOURCE_CATALOG.google_news_queries.length}源` +
        ` → ${validArticles.length}条 → ${events.length}个新事件`,
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
