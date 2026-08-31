import { SOURCE_CATALOG } from "./source_catalog.ts";
import { callGemini } from "./gemini.ts";
import { fetchJson } from "./http.ts";
import {
  countriesForTarget,
  dedupeEvents,
  isLineSelected,
  mapLimit,
  normalizeDate,
} from "./lib.ts";
import type {
  BranchResult,
  CountryConfig,
  RadarConfig,
  RadarEvent,
  RuntimeContext,
  SourceExecutionRecord,
  SportsResult,
} from "./types.ts";

interface HolidayRecord {
  date: string;
  localName: string;
  name: string;
}

import { searchWeb, SearchResponse } from "./web_search.ts";


export async function collectMedia(
  config: RadarConfig,
  context: RuntimeContext,
): Promise<BranchResult> {
  if (!isLineSelected(context.data_lines, "媒体")) {
    return {
      line: "媒体",
      data_source: "Tavily媒体搜索",
      events: [],
      top10_events: [],
      analysis: "Tavily: 跳过",
      executions: [
        {
          source_line: "媒体",
          source_kind: "branch",
          request_key: "media:branch",
          status: "skipped",
        },
      ],
      sports_results: [],
    };
  }

  const countryConfigs = SOURCE_CATALOG.countries as unknown as Record<
    string,
    CountryConfig
  >;
  const countries = countriesForTarget(context.target_region);
  const countryRuns = await mapLimit(
    countries,
    config.country_concurrency,
    async (countryName) => {
      const country = countryConfigs[countryName];
      const executions: SourceExecutionRecord[] = [];
      const events: RadarEvent[] = [];
      if (!country) return { events, executions, status: `${countryName}: 0` };

      const holidayLines: string[] = [];
      try {
        const holidays = await fetchJson<HolidayRecord[]>(
          `https://date.nager.at/api/v3/PublicHolidays/2026/${country.code}`,
          { timeoutMs: 10000, retries: 1 },
        );
        holidayLines.push(
          ...holidays.map(
            (holiday) =>
              `[${countryName}假日] ${holiday.date} - ${holiday.localName} (${holiday.name})`,
          ),
        );
        executions.push({
          source_line: "媒体",
          source_kind: "nager",
          country: countryName,
          source_name: "Nager.Date",
          request_key: `media:nager:2026:${country.code}`,
          status: "success",
          item_count: holidays.length,
          response_payload: holidays,
        });
      } catch (error) {
        executions.push({
          source_line: "媒体",
          source_kind: "nager",
          country: countryName,
          source_name: "Nager.Date",
          request_key: `media:nager:2026:${country.code}`,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // 请求仍按单一站点拆开；仅让彼此独立的请求并发执行。
      const mediaRuns = await mapLimit(
        country.media,
        config.site_concurrency,
        async ([domain, queryTemplate]) => {
          const query = queryTemplate.replace(
            "${config.time_range}",
            context.time_range || "本周",
          );
          try {
            const response = await searchWeb(config, { query, domain, maxResults: 5, mode: "general" });
            const lines: string[] = [];
            if (response.answer) lines.push(response.answer);
            for (const result of response.results ?? []) {
              if (result.title || result.content) {
                lines.push(
                  `${result.title ?? ""}: ${(result.content ?? "").slice(0, 300)}`,
                );
              }
            }
            return {
              lines,
              execution: {
                source_line: "媒体",
                source_kind: "tavily",
                country: countryName,
                source_name: domain,
                request_key: `media:tavily:${country.code}:${domain}`,
                status: "success",
                item_count: response.results?.length ?? 0,
                request_payload: {
                  query,
                  search_depth: "basic",
                  max_results: 5,
                  include_domains: [domain],
                },
                response_payload: response,
              } satisfies SourceExecutionRecord,
            };
          } catch (error) {
            return {
              lines: [],
              execution: {
                source_line: "媒体",
                source_kind: "tavily",
                country: countryName,
                source_name: domain,
                request_key: `media:tavily:${country.code}:${domain}`,
                status: "failed",
                request_payload: { query, include_domains: [domain] },
                error: error instanceof Error ? error.message : String(error),
              } satisfies SourceExecutionRecord,
            };
          }
        },
      );
      executions.push(...mediaRuns.map((run) => run.execution));
      const regionText = [
        ...holidayLines,
        ...mediaRuns.flatMap((run) => run.lines),
      ].join("\n");
      if (regionText.length < 20) {
        return { events, executions, status: `${countryName}: 0` };
      }

      const prompt = `你是跨境电商选品专家。今天：${context.current_date}，时间范围：${context.time_range}
国家：${countryName}  货币：${country.currency}  地区：${country.region}

规则：不卖服装鞋类！所有内容用中文。已记录ID(去重): ${context.history_ids.join(",").substring(0, 1000)}

对每个有电商价值的事件输出：event_id, event_name(中文), event_type, country, region, currency, date, stage(预告期/进行中/已过/节后余温), source, ecommerce_score(0-100), products(3个,含name中文/category/price_range当地货币/keywords_en[]/keywords_local[]), best_listing_time(中文), why_sellable(中文)

严格格式要求：
- country必须是："${countryName}"
- region必须是："${country.region}"
- date格式必须是YYYY-MM-DD
- event_id格式：国家代码_事件缩写_YYYYMMDD_STAGE(如VN_TET_20260217_POST)
- stage只能是：预告期、进行中、已过、节后余温

只输出纯JSON，不要前言解释或markdown。直接以 {"events":[ 开头。最多10个事件。

搜索数据：
${regionText.slice(0, 15000)}`;

      try {
        const response = await callGemini(config, prompt);
        for (const event of response.events) {
          event.country = countryName;
          event.region = country.region;
          event.date = normalizeDate(event.date);
          event.data_source = "Tavily媒体搜索";
          events.push(event);
        }
        executions.push({
          source_line: "媒体",
          source_kind: "gemini",
          country: countryName,
          source_name: config.gemini_model,
          request_key: `media:gemini:${country.code}`,
          status: response.events.length ? "success" : "partial",
          item_count: response.events.length,
          request_payload: { prompt },
          response_payload: { text: response.rawText },
        });
        return {
          events,
          executions,
          status: `${countryName}: ${response.events.length}`,
        };
      } catch (error) {
        executions.push({
          source_line: "媒体",
          source_kind: "gemini",
          country: countryName,
          source_name: config.gemini_model,
          request_key: `media:gemini:${country.code}`,
          status: "failed",
          request_payload: { prompt },
          error: error instanceof Error ? error.message : String(error),
        });
        return { events, executions, status: `${countryName}: Gemini错误` };
      }
    },
  );

  const sportsRuns = await mapLimit(
    SOURCE_CATALOG.sports_searches,
    config.site_concurrency,
    async ([domain, queryTemplate]) => {
      const query = queryTemplate.replace(
        "${config.time_range}",
        context.time_range || "本周",
      );
      try {
        const response = await searchWeb(config, { query, domain, maxResults: 3, mode: "general" });
        return {
          result: {
            source_name: domain,
            query,
            answer: response.answer,
            results: response.results ?? [],
          } satisfies SportsResult,
          execution: {
            source_line: "媒体",
            source_kind: "sports",
            source_name: domain,
            request_key: `media:sports:${domain}`,
            status: "success",
            item_count: response.results?.length ?? 0,
            request_payload: { query, include_domains: [domain], max_results: 3 },
            response_payload: response,
          } satisfies SourceExecutionRecord,
        };
      } catch (error) {
        return {
          result: {
            source_name: domain,
            query,
            results: [],
          } satisfies SportsResult,
          execution: {
            source_line: "媒体",
            source_kind: "sports",
            source_name: domain,
            request_key: `media:sports:${domain}`,
            status: "failed",
            request_payload: { query, include_domains: [domain], max_results: 3 },
            error: error instanceof Error ? error.message : String(error),
          } satisfies SourceExecutionRecord,
        };
      }
    },
  );

  const events = dedupeEvents(
    countryRuns.flatMap((run) => run.events),
    context.history_ids,
  );
  return {
    line: "媒体",
    data_source: "Tavily媒体搜索",
    events,
    top10_events: events.slice(0, 10),
    analysis: events.length
      ? countryRuns.map((run) => run.status).join(" | ")
      : "Tavily: 0个新事件",
    executions: [
      ...countryRuns.flatMap((run) => run.executions),
      ...sportsRuns.map((run) => run.execution),
    ],
    sports_results: sportsRuns.map((run) => run.result),
  };
}

export async function main(config: RadarConfig, context: RuntimeContext) {
  return collectMedia(config, context);
}

