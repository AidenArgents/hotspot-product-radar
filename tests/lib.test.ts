import assert from "node:assert/strict";
import test from "node:test";
import {
  countriesForTarget,
  dedupeEvents,
  isLineSelected,
  mapLimit,
  normalizeDate,
  normalizeTargetCountry,
  timeWindow,
} from "../f/radar/lib.ts";

test("三条业务线路选择规则与原流程一致", () => {
  assert.equal(isLineSelected("全部", "假日"), true);
  assert.equal(isLineSelected("媒体+网页", "假日"), false);
  assert.equal(isLineSelected("媒体+网页", "媒体"), true);
  assert.equal(isLineSelected("媒体+网页", "网页"), true);
});

test("北美美国排在东南亚和拉美前，所有地区遵守启用国家", () => {
  assert.deepEqual(countriesForTarget("北美"), ["美国"]);
  assert.equal(countriesForTarget("全部")[0], "美国");
  assert.deepEqual(countriesForTarget("东南亚"), [
    "越南", "泰国", "印尼", "菲律宾", "马来西亚", "新加坡",
  ]);
  assert.deepEqual(countriesForTarget("拉美"), ["巴西", "墨西哥"]);
  assert.equal(countriesForTarget("全部").length, 9);
  assert.deepEqual(countriesForTarget("全部", ["美国"]), ["美国"]);
  assert.deepEqual(countriesForTarget("东南亚", ["美国"]), []);
  assert.deepEqual(countriesForTarget("拉美", ["美国"]), []);
  assert.deepEqual(
    countriesForTarget("东南亚", ["越南", "泰国", "巴西"]),
    ["越南", "泰国"],
  );
  assert.deepEqual(countriesForTarget("新加坡", ["越南", "泰国"]), []);
});

test("时间范围保留原流程的计算语义", () => {
  assert.equal(timeWindow("2026-08-06", "今天").end.toISOString().slice(0, 10), "2026-08-07");
  assert.equal(timeWindow("2026-08-06", "近3天").end.toISOString().slice(0, 10), "2026-08-09");
  assert.equal(timeWindow("2026-08-06", "未来3个月").end.toISOString().slice(0, 10), "2026-11-06");
});

test("事件去重按名称、国家、阶段并排除历史 ID", () => {
  const events = [
    { event_id: "a", event_name: "赛事", country: "巴西", stage: "预告期", ecommerce_score: 80 },
    { event_id: "b", event_name: "赛事", country: "巴西", stage: "预告期", ecommerce_score: 90 },
    { event_id: "old", event_name: "节日", country: "泰国", stage: "进行中", ecommerce_score: 99 },
  ];
  assert.deepEqual(dedupeEvents(events, ["old"]).map((event) => event.event_id), ["b"]);
});

test("日期归一化与并发映射顺序稳定", async () => {
  assert.equal(normalizeDate("2026年8月6日"), "2026-08-06");
  const output = await mapLimit([30, 1, 10], 2, async (delay) => {
    await new Promise((resolve) => setTimeout(resolve, delay));
    return delay;
  });
  assert.deepEqual(output, [30, 1, 10]);
});

test("网页线路国家名称统一为目标国家标准", () => {
  assert.equal(normalizeTargetCountry("United States"), "美国");
  assert.equal(normalizeTargetCountry("USA"), "美国");
  assert.equal(normalizeTargetCountry("印度尼西亚"), "印尼");
  assert.equal(normalizeTargetCountry("Indonesia"), "印尼");
  assert.equal(normalizeTargetCountry("México"), "墨西哥");
  assert.equal(normalizeTargetCountry("Colombia"), undefined);
});
