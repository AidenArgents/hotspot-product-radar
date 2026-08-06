import assert from "node:assert/strict";
import test from "node:test";
import {
  countriesForTarget,
  dedupeEvents,
  isLineSelected,
  mapLimit,
  normalizeDate,
  timeWindow,
} from "../f/radar/lib.ts";

test("三条业务线路选择规则与原流程一致", () => {
  assert.equal(isLineSelected("全部", "假日"), true);
  assert.equal(isLineSelected("媒体+网页", "假日"), false);
  assert.equal(isLineSelected("媒体+网页", "媒体"), true);
  assert.equal(isLineSelected("媒体+网页", "网页"), true);
});

test("目标区域仍是东南亚 6 国与拉美 2 国", () => {
  assert.deepEqual(countriesForTarget("东南亚"), [
    "越南", "泰国", "印尼", "菲律宾", "马来西亚", "新加坡",
  ]);
  assert.deepEqual(countriesForTarget("拉美"), ["巴西", "墨西哥"]);
  assert.equal(countriesForTarget("全部").length, 8);
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
