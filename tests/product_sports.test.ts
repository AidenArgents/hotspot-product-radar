import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { collectMedia } from "../f/radar/collect_media.ts";
import { collectPlatformIntelligence } from "../f/radar/collect_platform_intelligence.ts";
import { hasEventDateEvidence, productSearchQuery } from "../f/radar/product_sources.ts";
import { ensureSchema, recordSports, startRun } from "../f/radar/database.ts";
import { SOURCE_CATALOG } from "../f/radar/source_catalog.ts";
import type { RadarConfig, RuntimeContext } from "../f/radar/types.ts";

// 所有网络入口均替换为本地响应；这些检查不启动真实扫描、不写业务库、不发送通知。
const config = {
  tavily_api_key: "mock-search", gemini_api_key: "mock-model", gemini_api_key_2: "", gemini_model: "mock-model",
  enabled_countries: ["越南", "菲律宾"], country_concurrency: 2, site_concurrency: 4,
  request_timeout_ms: 1000, gemini_timeout_ms: 1000, gemini_min_interval_ms: 0, https_proxy: "",
} as RadarConfig;
const context: RuntimeContext = {
  run_id: "mock-product", current_date: "2026-11-03", target_region: "全部", time_range: "本周",
  data_lines: "仅媒体", trigger_type: "manual", history_ids: [],
};
const globalUrl = "https://www.fifa.com/tournaments/world-event";
const vnUrl = "https://www.the-afc.com/en/matches/vietnam-event";
const phUrl = "https://www.espn.com/basketball/philippines-event";
const calendarUrl = "https://www.vietnam.travel/event/local-festival";

test("体育与官方活动进入各国分析，全球仅采集一次，未启用美国不产生请求", async (t) => {
  const searches: { domain: string; query: string }[] = [];
  const prompts: string[] = [];
  t.mock.method(globalThis, "fetch", async (value: string, options: RequestInit) => {
    const url = new URL(value);
    if (url.hostname === "date.nager.at") return new Response("[]");
    const body = JSON.parse(String(options.body));
    if (url.hostname === "generativelanguage.googleapis.com") {
      const prompt = body.contents[0].parts[0].text as string;
      prompts.push(prompt);
      const vn = prompt.includes("目标市场：越南");
      const country = vn ? "越南" : "菲律宾";
      const localUrl = vn ? vnUrl : phUrl;
      const base = { country, date: "2026-11-05", stage: "预告期", ecommerce_score: 80, products: [], source_kind: "sports" };
      const events = [
        { ...base, event_id: "same-local", event_name: `${country}本国赛事`, source_url: localUrl },
        { ...base, event_id: "same-global", event_name: "国际赛事", source_url: globalUrl, source_urls: [globalUrl, localUrl], market_relevance: "本国赛事报道包含参加该国际赛事的队伍信息" },
        { ...base, event_id: "wrong-country", event_name: "其他国家材料", source_url: vn ? phUrl : vnUrl },
        { ...base, event_id: "unlinked-global", event_name: "缺少本国关联", source_url: globalUrl },
        { ...base, event_id: "invented-date", event_name: "捏造日期", date: "2026-11-06", source_url: localUrl },
        { ...base, event_id: "old", event_name: "过期赛事", date: "2026-08-14", source_url: localUrl },
        { ...base, event_id: "cross-country", event_name: "错误国家归属", country: vn ? "菲律宾" : "越南", source_url: localUrl },
        ...(vn ? [{ ...base, event_id: "official", event_name: "越南官方活动", source_kind: "official-event-calendar", source_url: calendarUrl }] : []),
      ];
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ events }) }] } }] }));
    }
    assert.equal(url.hostname, "api.tavily.com", "禁止意外外部服务调用");
    const domain = body.include_domains[0];
    searches.push({ domain, query: body.query });
    const result = domain === "fifa.com" ? { title: "SHARED_GLOBAL tournament", url: globalUrl }
      : domain === "the-afc.com" && body.query.includes("Vietnam") ? { title: "LOCAL_VIETNAM football", url: vnUrl }
      : domain === "espn.com" && body.query.includes("Philippines") ? { title: "LOCAL_PHILIPPINES basketball", url: phUrl }
      : domain === "vietnam.travel" ? { title: "OFFICIAL_VIETNAM festival", url: calendarUrl } : null;
    return new Response(JSON.stringify({ results: result ? [{ ...result, content: "The event takes place on November 5, 2026. Confirmed schedule and local team participation." }] : [] }));
  });
  const result = await collectMedia(config, context);
  assert.equal(prompts.length, 2);
  const vnPrompt = prompts.find((prompt) => prompt.includes("目标市场：越南"))!;
  const phPrompt = prompts.find((prompt) => prompt.includes("目标市场：菲律宾"))!;
  assert.ok(vnPrompt.includes("LOCAL_VIETNAM") && vnPrompt.includes("OFFICIAL_VIETNAM"));
  assert.ok(phPrompt.includes("LOCAL_PHILIPPINES"));
  assert.ok(!vnPrompt.includes("LOCAL_PHILIPPINES") && !phPrompt.includes("LOCAL_VIETNAM"));
  assert.ok(prompts.every((prompt) => prompt.includes("SHARED_GLOBAL")));
  for (const [domain] of SOURCE_CATALOG.sports_searches) assert.equal(searches.filter((item) => item.domain === domain).length, 1);
  assert.ok(!searches.some((item) => item.query.includes("United States") || item.domain === "visittheusa.com"));
  assert.equal(result.events.length, 5);
  assert.equal(result.events.filter((event) => event.country === "越南").length, 3);
  assert.equal(result.events.filter((event) => event.country === "菲律宾").length, 2);
  assert.equal(new Set(result.events.map((event) => event.event_id)).size, 5);
  assert.ok(result.events.filter((event) => event.country === "越南").every((event) => event.event_id.startsWith("VN_")));
  assert.ok(result.events.filter((event) => event.country === "菲律宾").every((event) => event.event_id.startsWith("PH_")));
  assert.equal(result.sports_results?.filter((item) => item.scope === "global").length, 4);
  assert.equal(result.sports_results?.filter((item) => item.country === "越南").length, 2);
  assert.ok(result.executions.some((item) => item.country === "越南" && item.source_kind === "official-event-calendar"));
});

test("美国行业来源独立检索、保留Amazon平台并排除其他国家和无日期文章", async (t) => {
  const requests: Record<string, any>[] = [];
  t.mock.method(globalThis, "fetch", async (value: string, options: RequestInit) => {
    assert.equal(new URL(value).hostname, "api.tavily.com");
    const body = JSON.parse(String(options.body));
    requests.push(body);
    if (body.include_domains[0] !== "marketplacepulse.com") return new Response('{"results":[]}');
    return new Response(JSON.stringify({ results: [
      { title: "Amazon increases fulfillment fees", content: "United States marketplace seller fulfillment fees will increase for local merchants.", url: "https://www.marketplacepulse.com/articles/amazon-fee-change", published_date: "2026-11-02" },
      { title: "Walmart Mexico fee update", content: "Mexico sellers will pay updated commission fees starting this week.", url: "https://www.marketplacepulse.com/articles/mexico-update", published_date: "2026-11-02" },
      { title: "Walmart seller fee policy", content: "United States marketplace fees updated for local sellers.", url: "https://www.marketplacepulse.com/articles/undated-policy" },
    ] }));
  });
  const result = await collectPlatformIntelligence(config, { countries: ["美国"], currentDate: context.current_date, timeRange: "近3天" });
  assert.deepEqual(requests.map((body) => body.include_domains[0]).sort(), [
    "marketplacelearn.walmart.com", "sell.amazon.com", "ebay.com", "seller-us.tiktok.com",
    "marketplacepulse.com", "retaildive.com", "ebrun.com", "cifnews.com", "amz123.com",
    "tt123.com", "baijing.cn", "chwang.com", "ikjzd.com",
  ].sort());
  assert.ok(requests.every((body) => body.topic === "news"));
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].country, "美国");
  assert.equal((result.evidence[0].raw as any).platform, "Amazon");
});

test("体育旧表原有记录保留，新记录保存国家，重复初始化安全", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`CREATE TABLE sports_results (id INTEGER PRIMARY KEY, run_id TEXT, source_name TEXT, query TEXT, answer TEXT, results TEXT, created_at TEXT);
      INSERT INTO sports_results VALUES (1, 'old', 'fifa.com', 'old query', NULL, '[]', '2026-08-20');`);
    await ensureSchema(database);
    await ensureSchema(database);
    const old = database.prepare("SELECT * FROM sports_results WHERE id=1").get()!;
    assert.equal(old.scope, "global");
    assert.equal(old.country, null);
    assert.equal(old.query, "old query");
    await startRun(database, context.run_id, context);
    await recordSports(database, context.run_id, {
      line: "媒体", events: [], top10_events: [], executions: [], analysis: "mock", data_source: "mock",
      sports_results: [{ country: "菲律宾", scope: "country", source_name: "espn.com", query: "Philippines basketball", results: [] }],
    });
    const record = database.prepare("SELECT country, scope FROM sports_results WHERE run_id=?").get(context.run_id)!;
    assert.equal(record.country, "菲律宾");
    assert.equal(record.scope, "country");
  } finally { database.close(); }
});

test("活动日期必须见于材料，搜索年份和区间随扫描变化", () => {
  assert.ok(hasEventDateEvidence({ content: "The festival runs November 5–8, 2026." }, "2026-11-05"));
  assert.ok(hasEventDateEvidence({ content: "比赛日期2026年11月5日" }, "2026-11-05"));
  assert.ok(!hasEventDateEvidence({ content: "Schedule to be announced", published_date: "2026-11-05" }, "2026-11-05"));
  assert.ok(!hasEventDateEvidence({ content: "November 5, 2025" }, "2026-11-05"));
  const query = productSearchQuery("${current_year} ${config.time_range} ${start_date} ${end_date}", { ...context, current_date: "2027-01-01", time_range: "近3天" });
  assert.equal(query, "2027 近3天 2027-01-01 2027-01-04");
});
