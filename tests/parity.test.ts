import assert from "node:assert/strict";
import test from "node:test";
import { SOURCE_CATALOG } from "../f/radar/source_catalog.ts";
import { buildDingTalkMessage, buildOperationsDingTalkMessage } from "../f/radar/dingtalk.ts";
import type { BranchResult, OperationIntelligence, RadarConfig, RuntimeContext } from "../f/radar/types.ts";

test("源目录保留原媒体结构并加入官方数据层", () => {
  assert.equal(Object.keys(SOURCE_CATALOG.countries).length, 17);
  const targets = [...SOURCE_CATALOG.regions.东南亚, ...SOURCE_CATALOG.regions.拉美];
  const countries = SOURCE_CATALOG.countries as unknown as Record<
    string,
    { media: readonly (readonly [string, string])[] }
  >;
  const targetSites = targets.flatMap((country) => [...countries[country].media]);
  assert.equal(targetSites.length, 29);
  assert.equal(SOURCE_CATALOG.sports_searches.length, 7);
  assert.equal(SOURCE_CATALOG.rss_feeds.length, 7);
  assert.equal(SOURCE_CATALOG.official_event_sources.length, 8);
  assert.equal(SOURCE_CATALOG.operations_official_sources.length, 8);
  assert.equal(new Set(SOURCE_CATALOG.operations_official_sources.map((source) => source.country)).size, 8);
  assert.equal(SOURCE_CATALOG.platform_official_sources.length, 24);
  assert.equal(new Set(SOURCE_CATALOG.platform_official_sources.map((source) => source.country)).size, 8);
  assert.deepEqual(
    SOURCE_CATALOG.platform_industry_media_sources.map((source) => source.name),
    ["亿邦动力", "雨果跨境", "AMZ123", "TT123", "DNY123", "白鲸出海", "出海网", "跨境知道", "Fintech News Malaysia"],
  );
  assert.equal(SOURCE_CATALOG.rss_feeds.filter((feed) => feed.official).length, 4);
  assert.deepEqual(Object.keys(SOURCE_CATALOG.holiday_fallbacks).sort(), ["泰国", "马来西亚"]);
  assert.match(SOURCE_CATALOG.gdacs.url, /gdacs\.org/);
  assert.equal(SOURCE_CATALOG.optional_sources.length, 2);
  for (const [domain, query] of targetSites) {
    assert.match(query, new RegExp(`site:${domain.replaceAll(".", "\\.")}`));
  }
  assert.equal(targetSites.some(([domain]) => domain === "todayonline.com"), false);
  assert.equal(targetSites.some(([domain]) => domain === "world.thaipbs.or.th"), true);
});

test("三条钉钉标题与单独消息边界保留", () => {
  const config = {
    dashboard_url: "https://radar.example.test",
    spreadsheet_id: "sheet",
    product_report_url: "https://docs.google.test/product",
    operations_report_url: "https://docs.google.test/operations",
  } as RadarConfig;
  const context = {
    current_date: "2026-08-06",
    target_region: "全部",
    time_range: "未来3个月",
  } as RuntimeContext;
  for (const [line, title] of [["假日", "假日API"], ["媒体", "Tavily媒体"], ["网页", "网页抓取"]] as const) {
    const branch = {
      line,
      analysis: "测试",
      data_source: title,
      events: [],
      top10_events: [],
      executions: [],
    } satisfies BranchResult;
    const message = buildDingTalkMessage(config, context, branch, []);
    assert.ok(message.includes(`热点选品雷达v7·${title}`));
    assert.ok(message.includes("https://docs.google.test/product"));
    assert.equal(message.includes("https://radar.example.test"), false);
  }
  const operationsMessage = buildOperationsDingTalkMessage(config, "2026-08-06", "全部", [{
    intelligence_id: "OPS_TEST",
    title: "测试经营变化",
    country: "泰国",
    region: "东南亚",
    category: "法规与合规",
    direction: "中性",
    impact_score: 70,
    urgency: "近期关注",
    business_impact: "这是一条用于验证消息链接的经营影响说明。",
    source_name: "测试来源",
  } satisfies OperationIntelligence]);
  assert.ok(operationsMessage.includes("https://docs.google.test/operations"));
  assert.equal(operationsMessage.includes("https://radar.example.test"), false);
});
