import assert from "node:assert/strict";
import test from "node:test";
import { SOURCE_CATALOG } from "../f/radar/source_catalog.ts";
import { buildDingTalkMessage } from "../f/radar/dingtalk.ts";
import type { BranchResult, RadarConfig, RuntimeContext } from "../f/radar/types.ts";

test("源目录保留 17 国配置、目标 8 国逐站查询、7 条体育与 3 条 RSS", () => {
  assert.equal(Object.keys(SOURCE_CATALOG.countries).length, 17);
  const targets = [...SOURCE_CATALOG.regions.东南亚, ...SOURCE_CATALOG.regions.拉美];
  const countries = SOURCE_CATALOG.countries as unknown as Record<
    string,
    { media: readonly (readonly [string, string])[] }
  >;
  const targetSites = targets.flatMap((country) => [...countries[country].media]);
  assert.equal(targetSites.length, 30);
  assert.equal(SOURCE_CATALOG.sports_searches.length, 7);
  assert.equal(SOURCE_CATALOG.rss_feeds.length, 3);
  for (const [domain, query] of targetSites) {
    assert.match(query, new RegExp(`site:${domain.replaceAll(".", "\\.")}`));
  }
});

test("三条钉钉标题与单独消息边界保留", () => {
  const config = {
    dashboard_url: "https://radar.example.test",
    spreadsheet_id: "sheet",
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
    assert.ok(message.includes("https://radar.example.test"));
  }
});
