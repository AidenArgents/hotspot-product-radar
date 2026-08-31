import assert from "node:assert/strict";
import test from "node:test";
import { parseGdacs } from "../f/radar/gdacs.ts";
import { parseRss } from "../f/radar/rss.ts";
import { isConcreteArticleUrl, mediaPublicationWindow, validateSearchResults } from "../f/radar/web_search.ts";
import { inferPlatformCountries } from "../f/radar/collect_platform_intelligence.ts";
import { normalizeOperationItems, platformIntelligenceId, verificationForEvidence } from "../f/radar/operations_analyzer.ts";
import { withinOperationWindow } from "../f/radar/operations_window.ts";
import type { EvidenceItem } from "../f/radar/types.ts";

test("Tavily结果必须匹配域名、日期并去重", () => {
  const response = {
    results: [
      { title: "Thailand festival announced", content: "A detailed current event description for shoppers.", url: "https://news.example.com/story/1", published_date: "2026-08-11" },
      { title: "Thailand festival announced", content: "duplicate", url: "https://news.example.com/story/2", published_date: "2026-08-11" },
      { title: "Wrong domain story", content: "A detailed current event description for shoppers.", url: "https://wikipedia.org/wiki/Thailand", published_date: "2026-08-11" },
      { title: "Old but otherwise valid story", content: "A detailed old event description for shoppers.", url: "https://news.example.com/story/3", published_date: "2025-01-01" },
      { title: "Undated but otherwise valid story", content: "A detailed undated event description for shoppers.", url: "https://news.example.com/story/4" },
    ],
  };
  const checked = validateSearchResults(response, "example.com", {
    mode: "news",
    startDate: "2026-08-01",
    endDate: "2026-08-12",
  });
  assert.equal(checked.valid.length, 1);
  assert.equal(checked.rejected, 4);
});

test("媒体检索窗口随用户范围变化但不会抓取未来发布日期", () => {
  assert.deepEqual(mediaPublicationWindow("2026-08-12", "今天"), {
    start_date: "2026-08-10",
    end_date: "2026-08-12",
  });
  assert.equal(mediaPublicationWindow("2026-08-12", "未来3个月").start_date, "2026-05-14");
  assert.deepEqual(mediaPublicationWindow("2026-08-19", "近3天"), {
    start_date: "2026-08-17",
    end_date: "2026-08-19",
  });
});

test("近期运营证据必须有发布日期和具体文章链接", () => {
  const evidence = (published_at: string | undefined, url: string): EvidenceItem => ({
    evidence_id: `${published_at ?? "missing"}-${url}`,
    country: "马来西亚",
    region: "东南亚",
    publisher: "测试媒体",
    acquisition_method: "Tavily Search API",
    source_kind: "platform-media",
    title: "Lazada费率调整",
    summary: "平台费率发生变化。",
    url,
    published_at,
    authority: "媒体",
  });
  assert.equal(withinOperationWindow(evidence("2026-08-18", "https://example.com/article/1"), "2026-08-19", "近3天"), true);
  assert.equal(withinOperationWindow(evidence("2026-08-14", "https://example.com/article/2"), "2026-08-19", "近3天"), false);
  assert.equal(withinOperationWindow(evidence("2026-03-26", "https://example.com/article/3"), "2026-08-19", "近3天"), false);
  assert.equal(withinOperationWindow(evidence(undefined, "https://example.com/article/4"), "2026-08-19", "近3天"), false);
  assert.equal(withinOperationWindow(evidence("2026-08-18", "https://example.com/lazada/news"), "2026-08-19", "近3天"), false);
  assert.equal(isConcreteArticleUrl("https://sellercenter.lazada.com.my/helpcenter/s/faq"), false);
  assert.equal(isConcreteArticleUrl("https://www.chwang.com/news/201560143874"), true);
});

test("RSS保留近期文章并淘汰过期与重复标题", () => {
  const xml = `<rss><channel>
    <item><title>Current official event</title><link>https://example.com/1</link><pubDate>Tue, 11 Aug 2026 10:00:00 GMT</pubDate><description><![CDATA[<p>Useful details</p>]]></description></item>
    <item><title>Current official event</title><link>https://example.com/2</link><pubDate>Tue, 11 Aug 2026 11:00:00 GMT</pubDate></item>
    <item><title>Very old report title</title><link>https://example.com/3</link><pubDate>Tue, 01 Jan 2023 10:00:00 GMT</pubDate></item>
  </channel></rss>`;
  const parsed = parseRss(xml, {
    sourceName: "官方源",
    currentDate: "2026-08-12",
    maxAgeDays: 14,
    seenTitles: new Set(),
  });
  assert.equal(parsed.articles.length, 1);
  assert.equal(parsed.duplicate, 1);
  assert.equal(parsed.stale, 1);
  assert.match(parsed.articles[0].line, /2026-08-11.*Useful details.*https:\/\/example.com\/1/);
});

test("GDACS仅保留目标8国近期当前事件并按事件ID去重", () => {
  const item = (iso3: string, id: string, current = "true") => `<item>
    <title>Orange flood alert in target</title><description>Flood warning details</description>
    <link>https://www.gdacs.org/report.aspx?eventid=${id}</link><pubDate>Tue, 11 Aug 2026 10:00:00 GMT</pubDate>
    <gdacs:datemodified>Tue, 11 Aug 2026 12:00:00 GMT</gdacs:datemodified><gdacs:iscurrent>${current}</gdacs:iscurrent>
    <gdacs:fromdate>Tue, 11 Aug 2026 00:00:00 GMT</gdacs:fromdate><gdacs:eventtype>FL</gdacs:eventtype>
    <gdacs:alertlevel>Orange</gdacs:alertlevel><gdacs:eventid>${id}</gdacs:eventid><gdacs:severity>1000 people exposed</gdacs:severity><gdacs:iso3>${iso3}</gdacs:iso3>
  </item>`;
  const parsed = parseGdacs(`<rss><channel>${item("THA", "1")}${item("THA", "1")}${item("USA", "2")}${item("BRA", "3", "false")}</channel></rss>`, {
    currentDate: "2026-08-12",
    maxAgeDays: 14,
    maxItems: 40,
  });
  assert.equal(parsed.alerts.length, 1);
  assert.equal(parsed.alerts[0].country, "泰国");
  assert.equal(parsed.duplicate, 1);
});

test("平台行业媒体结果只路由到正文明确提到的国家", () => {
  const countries = ["越南", "泰国", "马来西亚", "墨西哥"];
  assert.deepEqual(
    inferPlatformCountries("Shopee Thailand fee update and Malaysia payment integration", countries),
    ["泰国", "马来西亚"],
  );
  assert.deepEqual(inferPlatformCountries("Mercado Libre México seller policy", countries), ["墨西哥"]);
  assert.deepEqual(inferPlatformCountries("Generic platform article", countries), []);
});

test("平台情报按国家平台政策日期和费率变化生成稳定去重ID", () => {
  const first = platformIntelligenceId(
    "泰国", "Shopee", "佣金与交易费", "2026-08-04", "本土店佣金调整",
    "服装从11.24%升至13.38%，快消从13.91%升至16.05%",
  );
  const rewritten = platformIntelligenceId(
    "泰国", "Shopee", "佣金与交易费", "2026-08-04", "佣金费率更新",
    "快消新费率16.05%，旧费率13.91%；服装新费率13.38%，旧费率11.24%",
  );
  assert.equal(first, rewritten);
});

test("平台官方、双媒体和单媒体分别形成三级核验状态", () => {
  const item = (publisher: string, source_kind: string, authority: string): EvidenceItem => ({
    evidence_id: `${publisher}-${source_kind}`,
    country: "马来西亚",
    region: "东南亚",
    publisher,
    acquisition_method: "Tavily Search API",
    source_kind,
    title: "Shopee卖家费率调整公告",
    summary: "平台公布了新的卖家费率和生效日期。",
    url: `https://${publisher}.example/policy`,
    authority,
  });
  const mediaA = item("媒体A", "platform-media", "跨境行业专业媒体·一级线索");
  const mediaB = item("媒体B", "platform-media", "跨境行业专业媒体·一级线索");
  const official = item("Shopee官方", "platform-official", "平台官方公告");
  assert.equal(verificationForEvidence([official]), "已确认");
  assert.equal(verificationForEvidence([mediaA, mediaB]), "多源佐证");
  assert.equal(verificationForEvidence([mediaA]), "待核实");
});

test("Gemini平台候选必须引用真实URL并由程序重算证据等级", () => {
  const evidence: EvidenceItem[] = [
    {
    evidence_id: "official", country: "泰国", region: "东南亚", publisher: "Shopee泰国帮助中心",
      acquisition_method: "Tavily Search API · 平台官方域名限定", source_kind: "platform-official",
      title: "Shopee fee policy", summary: "Effective 4 August 2026", url: "https://help.shopee.co.th/policy",
      published_at: "2026-08-05",
      authority: "平台官方公告",
    },
    {
      evidence_id: "media", country: "泰国", region: "东南亚", publisher: "亿邦动力",
      acquisition_method: "Tavily Search API · 跨境行业媒体单站搜索", source_kind: "platform-media",
      title: "Shopee泰国佣金调整", summary: "服装13.38%，快消16.05%", url: "https://ebrun.com/story",
      published_at: "2026-08-05",
      authority: "跨境行业专业/垂直媒体·一级线索",
    },
  ];
  const items = normalizeOperationItems([{
    title: "Shopee泰国本土店上调佣金",
    platform: "Shopee",
    policy_type: "佣金与交易费",
    policy_subject: "本土店佣金调整",
    category: "平台规则与费用",
    direction: "利空",
    impact_score: 90,
    urgency: "立即处理",
    effective_date: "2026-08-04",
    business_impact: "服装费率升至13.38%，快消品费率升至16.05%，卖家需要重新核算利润。",
    recommended_actions: ["更新费率表"],
    source_url: evidence[0].url,
    source_urls: evidence.map((item) => item.url),
    confidence: 99,
  }], "泰国", "东南亚", evidence, new Set());
  assert.equal(items.length, 1);
  assert.equal(items[0].verification_status, "已确认");
  assert.equal(items[0].evidence_count, 2);
  assert.equal(items[0].source_url, evidence[0].url);
  assert.deepEqual(items[0].source_urls, evidence.map((item) => item.url));
  assert.ok(items[0].affected_dimensions?.includes("Shopee"));
});
