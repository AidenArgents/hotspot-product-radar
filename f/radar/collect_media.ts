import { SOURCE_CATALOG } from "./source_catalog.ts";
import { callGemini, geminiFailurePayload } from "./gemini.ts";
import { fetchCountryHolidays } from "./holidays.ts";
import { countriesForTarget, dedupeEvents, isLineSelected, mapLimit, timeWindow } from "./lib.ts";
import { searchWeb, validateSearchResults } from "./web_search.ts";
import { collectOfficialEvents, collectSports, productSourceLines, routeProductEvents, sportsRecords, type ProductSearchRun } from "./product_sources.ts";
import type { BranchResult, CountryConfig, RadarConfig, RuntimeContext, SourceExecutionRecord } from "./types.ts";

export async function collectMedia(config: RadarConfig, context: RuntimeContext): Promise<BranchResult> {
  if (!isLineSelected(context.data_lines, "媒体")) {
    return {
      line: "媒体", data_source: "Tavily媒体搜索", events: [], top10_events: [], analysis: "Tavily: 跳过",
      executions: [{ source_line: "媒体", source_kind: "branch", request_key: "media:branch", status: "skipped" }],
      sports_results: [],
    };
  }
  const countryConfigs = SOURCE_CATALOG.countries as unknown as Record<string, CountryConfig>;
  const countries = countriesForTarget(context.target_region, config.enabled_countries);
  // 无启用国家时不调用任何采集接口。全球赛事每次扫描只采集一次，供本国证据判断关联。
  if (!countries.length) return { line: "媒体", data_source: "Tavily媒体搜索", events: [], top10_events: [], analysis: "没有启用的国家", executions: [], sports_results: [] };
  const globalSports = await collectSports(config, context);
  const { start, end } = timeWindow(context.current_date, context.time_range);
  const countryRuns = await mapLimit(countries, config.country_concurrency, async (countryName) => {
    const country = countryConfigs[countryName];
    const executions: SourceExecutionRecord[] = [];
    if (!country) return { events: [], executions, sports: [] as ProductSearchRun[], status: `${countryName}: 0` };
    context.onProgress?.(`正在收集产品情报：${countryName}`);

    const holidayResult = await fetchCountryHolidays(config, context, countryName, country, "媒体");
    executions.push(...holidayResult.executions);
    const holidays = holidayResult.holidays.filter((holiday) => {
      const date = new Date(`${holiday.date}T00:00:00Z`);
      return date >= start && date <= end;
    });

    const mediaRuns = await mapLimit(country.media, config.site_concurrency, async ([domain, queryTemplate]): Promise<ProductSearchRun> => {
      const query = queryTemplate.replaceAll("${current_year}", context.current_date.slice(0, 4))
        .replaceAll("${config.time_range}", context.time_range || "本周");
      const execution: SourceExecutionRecord = {
        source_line: "媒体", source_kind: "tavily", country: countryName, source_name: domain,
        request_key: `media:tavily:${country.code}:${domain}`, status: "running",
        request_payload: { query, search_depth: "basic", max_results: 5, include_domains: [domain] },
      };
      try {
        const response = await searchWeb(config, { query, domain, maxResults: 5, mode: "general" });
        const checked = validateSearchResults(response, domain, { mode: "general" });
        return {
          source_name: domain, source_kind: "tavily", country: countryName, query, results: checked.valid,
          execution: { ...execution, status: checked.valid.length ? "success" : "partial", item_count: checked.valid.length, response_payload: checked },
        };
      } catch (error) {
        return {
          source_name: domain, source_kind: "tavily", country: countryName, query, results: [],
          execution: { ...execution, status: "failed", item_count: 0, error: error instanceof Error ? error.message : String(error) },
        };
      }
    });
    const sports = await collectSports(config, context, countryName);
    const officialEvents = await collectOfficialEvents(config, context, countryName);
    executions.push(...[...mediaRuns, ...sports, ...officialEvents].map((run) => run.execution));
    const sourceRuns = [...mediaRuns, ...sports, ...officialEvents, ...globalSports];
    if (!holidays.length && ![...mediaRuns, ...sports, ...officialEvents].some((run) => run.results.length)) {
      return { events: [], executions, sports, status: `${countryName}: 0` };
    }

    const prompt = `你是跨境电商选品专家。今天：${context.current_date}，时间范围：${context.time_range}
目标市场：${countryName}；货币：${country.currency}；地区：${country.region}

不卖服装鞋类。所有解释用中文。只依据下方材料，不得编造事件、日期、来源或市场联系。
已记录ID（去重）：${context.history_ids.join(",").substring(0, 1000)}

本国体育、官方活动和本国媒体共同参与本国选品分析。全球赛事材料只采集了一次，并不自动适用于每个国家。
对于体育和官方活动，活动日期必须在 ${start.toISOString().slice(0, 10)} 至 ${end.toISOString().slice(0, 10)}，并能从材料正文或标题找到明确年月日；不能把新闻发布日期当成比赛/活动日期，不能按每年惯例补日期。
全球赛事只有在本国媒体/本国赛事材料中也找到明确关联时才能生成本国机会；market_relevance说明关联，source_urls同时引用全球原文和本国关联原文。没有本国证据就跳过。举办国与目标市场分别判断，不要仅因赛事发生在别国就改写目标市场。
单次空结果、失败或无日期页面都不能补写成事件。若没有适合本国的事件，输出空数组。

每条输出：event_id, event_name(中文), event_type, country="${countryName}", region="${country.region}", currency="${country.currency}", date(YYYY-MM-DD), stage(预告期/进行中/已过/节后余温), source, source_kind(tavily/sports/official-event-calendar/nager), source_url, source_urls(数组), market_relevance, ecommerce_score(0-100), products(3个，含name/category/price_range/keywords_en[]/keywords_local[]), best_listing_time, why_sellable。
source_url及source_urls必须逐字复制提供的URL；假日使用source_kind=nager。event_id以${country.code}_开头，同一事件在不同市场分别记录；同一市场内同一事件合并，不要按来源重复输出。
只输出纯JSON：{"events":[]}，最多10个有明确电商价值的事件。

本国媒体材料：
${productSourceLines(mediaRuns, 9000)}

本国体育材料：
${productSourceLines(sports, 6000)}

本国官方活动材料：
${productSourceLines(officialEvents, 6000)}

全球体育材料（逐国核实关联）：
${productSourceLines(globalSports, 7000)}

本国公共假日：
${holidays.map((holiday) => `${holiday.date} ${holiday.localName} (${holiday.name})`).join("\n")}`;
    context.onProgress?.(`正在通过 Gemini 分析产品机会：${countryName}（含体育与官方活动）`);
    try {
      const response = await callGemini(config, prompt, context.onProgress);
      const routed = routeProductEvents(response.events, countryName, country, context, sourceRuns, new Set(holidays.map((holiday) => holiday.date)));
      executions.push({
        source_line: "媒体", source_kind: "gemini", country: countryName, source_name: config.gemini_model,
        request_key: `media:gemini:${country.code}`, status: routed.events.length ? "success" : "partial",
        item_count: routed.events.length, request_payload: { prompt },
        response_payload: { text: response.rawText, metadata: response.metadata, rejected_events: routed.rejected },
        error: routed.rejected ? `${routed.rejected}条生成结果因国家、来源、活动日期或全球赛事关联证据不足被拦截` : undefined,
      });
      return { events: routed.events, executions, sports, status: `${countryName}: ${routed.events.length}` };
    } catch (error) {
      executions.push({
        source_line: "媒体", source_kind: "gemini", country: countryName, source_name: config.gemini_model,
        request_key: `media:gemini:${country.code}`, status: "failed", request_payload: { prompt },
        response_payload: geminiFailurePayload(error),
        error: error instanceof Error ? error.message : String(error),
      });
      return { events: [], executions, sports, status: `${countryName}: Gemini错误` };
    }
  });
  const events = dedupeEvents(countryRuns.flatMap((run) => run.events), context.history_ids);
  return {
    line: "媒体", data_source: "Tavily媒体搜索", events, top10_events: events.slice(0, 10),
    analysis: countryRuns.map((run) => run.status).join(" | "),
    executions: [...globalSports.map((run) => run.execution), ...countryRuns.flatMap((run) => run.executions)],
    sports_results: sportsRecords([...globalSports, ...countryRuns.flatMap((run) => run.sports)]),
  };
}

export async function main(config: RadarConfig, context: RuntimeContext) {
  return collectMedia(config, context);
}
