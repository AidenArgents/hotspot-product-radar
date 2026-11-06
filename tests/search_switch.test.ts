import assert from "node:assert/strict";
import test from "node:test";
import { searchWeb } from "../f/radar/web_search.ts";
import { collectMedia } from "../f/radar/collect_media.ts";
import { sendDingTalk } from "../f/radar/dingtalk.ts";
import { extractEvidence } from "../f/radar/evidence.ts";
import type { BranchResult, RadarConfig, RuntimeContext } from "../f/radar/types.ts";

const config = {
  tavily_api_key: "tavily-test", enabled_countries: ["美国"], country_concurrency: 1, site_concurrency: 4,
  request_timeout_ms: 1000, dingtalk_token_1: "robot-test", dingtalk_secret_1: "secret-test",
  dingtalk_token_2: "", dingtalk_secret_2: "",
} as RadarConfig;

test("搜索请求只发往Tavily", async (t) => {
  const requests: { url: URL; body: Record<string, unknown> }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    requests.push({ url: new URL(url), body: options.body ? JSON.parse(String(options.body)) : {} });
    return new Response(JSON.stringify({ items: [], results: [] }));
  });
  const input = { query: "US retail news", domain: "cnn.com", maxResults: 5, mode: "general" as const };
  await searchWeb(config, input);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.hostname, "api.tavily.com");
  assert.equal(requests[0].body.api_key, "tavily-test");
  assert.deepEqual(requests[0].body.include_domains, ["cnn.com"]);
});

test("仅启用美国时媒体采集不请求其他国家，也不调用Gemini", async (t) => {
  const urls: URL[] = [];
  t.mock.method(globalThis, "fetch", async (value: string) => {
    const url = new URL(value);
    urls.push(url);
    if (url.hostname === "date.nager.at") return new Response("[]");
    assert.equal(url.hostname, "api.tavily.com");
    return new Response('{"items":[]}');
  });
  const result = await collectMedia(config, {
    run_id: "mock-us", current_date: "2026-11-02", target_region: "全部", time_range: "本周",
    data_lines: "仅媒体", trigger_type: "manual", history_ids: [],
  } satisfies RuntimeContext);
  assert.deepEqual(result.events, []);
  const countrySteps = result.executions.filter((item) => item.country);
  assert.ok(countrySteps.length > 0);
  assert.ok(countrySteps.every((item) => item.country === "美国"));
  assert.equal(result.executions.filter((item) => item.source_kind === "tavily").length, 4);
  assert.equal(urls.filter((url) => url.hostname === "date.nager.at").length, 1);
  assert.ok(urls.find((url) => url.pathname.endsWith("/US")));
  assert.equal(result.executions.filter((item) => item.source_kind === "official-event-calendar").length, 1);
  assert.ok(result.executions.some((item) => item.source_name === "Brand USA · 美国重大节庆与活动" && item.country === "美国"));
  assert.equal(result.sports_results?.filter((item) => item.country === "美国").length, 2);
  assert.equal(result.sports_results?.filter((item) => item.scope === "global").length, 4);
});

test("Tavily媒体证据可供运营复用", () => {
  const result = extractEvidence([{
    line: "媒体", events: [], top10_events: [], analysis: "mock", data_source: "Tavily媒体搜索",
    executions: [{ source_line: "媒体", source_kind: "tavily", country: "美国", source_name: "cnn.com", request_key: "mock", status: "success",
      response_payload: { results: [{ title: "US retail news", url: "https://cnn.com/article/us-retail", content: "Useful source text", published_date: "2026-11-02" }] } }],
  } satisfies BranchResult]);
  assert.equal(result.length, 1);
  assert.equal(result[0].region, "北美");
  assert.equal(result[0].source_kind, "tavily");
  assert.match(result[0].acquisition_method, /Tavily/);
});

test("机器人2未配置时只发机器人1，校验真实加签参数", async (t) => {
  let count = 0;
  t.mock.method(globalThis, "fetch", async (value: string, options: RequestInit) => {
    count++;
    const url = new URL(value);
    assert.equal(url.searchParams.get("access_token"), "robot-test");
    assert.ok(url.searchParams.get("timestamp"));
    assert.ok(url.searchParams.get("sign"));
    assert.equal(JSON.parse(String(options.body)).msgtype, "text");
    return new Response('{"errcode":0,"errmsg":"ok"}');
  });
  const result = await sendDingTalk(config, "Local mock only. ".repeat(5));
  assert.equal(count, 1);
  assert.equal(result.length, 1);
  assert.equal(result[0].robotIndex, 1);
  assert.equal(result[0].ok, true);
});
