import { SOURCE_CATALOG } from "./source_catalog.ts";
import { callGemini } from "./gemini.ts";
import { fetchCountryHolidays } from "./holidays.ts";
import {
  countriesForTarget,
  dedupeEvents,
  isLineSelected,
  mapLimit,
  timeWindow,
} from "./lib.ts";
import type {
  BranchResult,
  CountryConfig,
  RadarConfig,
  RadarEvent,
  RuntimeContext,
  SourceExecutionRecord,
} from "./types.ts";

export async function collectHoliday(
  config: RadarConfig,
  context: RuntimeContext,
): Promise<BranchResult> {
  if (!isLineSelected(context.data_lines, "假日")) {
    return {
      line: "假日",
      data_source: "假日API",
      events: [],
      top10_events: [],
      analysis: "假日API: 跳过",
      executions: [
        {
          source_line: "假日",
          source_kind: "branch",
          request_key: "holiday:branch",
          status: "skipped",
        },
      ],
    };
  }

  const countries = countriesForTarget(context.target_region, config.enabled_countries);
  const runs = await mapLimit(
    countries,
    config.country_concurrency,
    async (countryName) => {
      const country = (SOURCE_CATALOG.countries as unknown as Record<string, CountryConfig>)[countryName];
      const executions: SourceExecutionRecord[] = [];
      const events: RadarEvent[] = [];
      if (!country) return { countryName, events, executions, status: `${countryName}: 0` };

      context.onProgress?.(`正在收集官方假日: ${countryName}`);
      const holidayResult = await fetchCountryHolidays(config, context, countryName, country, "假日");
      const holidays = holidayResult.holidays;
      executions.push(...holidayResult.executions);

      const { start, end } = timeWindow(context.current_date, context.time_range);
      const results = holidays
        .filter((holiday) => {
          const date = new Date(`${holiday.date}T00:00:00Z`);
          return date >= start && date <= end;
        })
        .map(
          (holiday) =>
            `[${countryName}假日] ${holiday.date} - ${holiday.localName} (${holiday.name})`,
        );
      if (results.length === 0) {
        return { countryName, events, executions, status: `${countryName}: 0` };
      }

      const prompt = `你是跨境电商选品专家。今天：${context.current_date}，时间范围：${context.time_range}
国家：${countryName}  货币：${country.currency}  地区：${country.region}

数据来源：Nager.Date + 泰国/马来西亚官方年度假日兜底表
规则：不卖服装鞋类！所有内容用中文。已记录ID(去重): ${context.history_ids.join(",").substring(0, 1000)}

对每个有电商价值的假日事件输出：event_id, event_name(中文), event_type, country, region, currency, date, stage(预告期/进行中/已过/节后余温), source("假日API"), ecommerce_score(0-100), products(3个,含name中文/category/price_range当地货币/keywords_en[]/keywords_local[]), best_listing_time(中文), why_sellable(中文)

严格格式：country="${countryName}", region="${country.region}", date=YYYY-MM-DD, event_id=国家代码_事件_YYYYMMDD_STAGE, stage只能是：预告期/进行中/已过/节后余温

只输出纯JSON，直接以 {"events":[ 开头。最多10个事件。

假日数据：
${results.join("\n")}`;

      const geminiKey = `holiday:gemini:${country.code}`;
      context.onProgress?.(`正在通过 Gemini 智能分析假日价值: ${countryName}`);
      try {
        const response = await callGemini(config, prompt);
        for (const event of response.events) {
          event.country = countryName;
          event.region = country.region;
          event.data_source = "假日API";
          events.push(event);
        }
        executions.push({
          source_line: "假日",
          source_kind: "gemini",
          country: countryName,
          source_name: config.gemini_model,
          request_key: geminiKey,
          status: response.events.length ? "success" : "partial",
          item_count: response.events.length,
          request_payload: { prompt },
          response_payload: { text: response.rawText },
        });
        return {
          countryName,
          events,
          executions,
          status: `${countryName}: ${response.events.length}`,
        };
      } catch (error) {
        executions.push({
          source_line: "假日",
          source_kind: "gemini",
          country: countryName,
          source_name: config.gemini_model,
          request_key: geminiKey,
          status: "failed",
          request_payload: { prompt },
          error: error instanceof Error ? error.message : String(error),
        });
        return { countryName, events, executions, status: `${countryName}: Gemini错误` };
      }
    },
  );

  const allEvents = runs.flatMap((run) => run.events);
  const events = dedupeEvents(allEvents, context.history_ids);
  return {
    line: "假日",
    data_source: "假日API",
    events,
    top10_events: events.slice(0, 10),
    analysis: events.length
      ? `假日API | ${runs.map((run) => run.status).join(" | ")}`
      : "假日API: 0个新事件(全部已记录)",
    executions: runs.flatMap((run) => run.executions),
  };
}

export async function main(config: RadarConfig, context: RuntimeContext) {
  return collectHoliday(config, context);
}
