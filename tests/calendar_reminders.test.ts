import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CalendarReminders } from "../f/radar/calendar_reminders.ts";
import { chinaDate, parseCalendarFeed, type CalendarFeed, type CalendarNode } from "../f/radar/calendar_feed.ts";
import type { RadarConfig } from "../f/radar/types.ts";

const node: CalendarNode = {
  id: "builtin-2027-event|route-0|start", event_id: "builtin-2027-event", event_name: "美国活动", event_date: "2027-01-20",
  estimated: false, route_id: "route-0", route_name: "合德正班", stage: "start", stage_name: "开始选品", due_date: "2027-01-08",
};
function feed(nodes: CalendarNode[] = [node]): CalendarFeed {
  return { schema_version: 1, title: "看板", action_timezone: "Asia/Shanghai", generated_at: "2026-11-05T01:00:00Z", event_count: nodes.length ? 1 : 0, route_count: nodes.length ? 1 : 0, nodes };
}
const html = (value: CalendarFeed) => `<html><head><script type="application/json" id="calendar-reminder-data">${JSON.stringify(value)}</script></head><body></body></html>`;
function setup() {
  const db = new DatabaseSync(":memory:");
  const config = { calendar_enabled: true, calendar_hour: 9, calendar_minute: 0, calendar_offsets: [7, 3, 0],
    calendar_url: "https://example.test/calendar.html", dingtalk_token_1: "test-robot", dingtalk_token_2: "" } as RadarConfig;
  let now = new Date("2027-01-01T01:00:00Z"), content = html(feed()), failFetch = false;
  let fetchCount = 0;
  const sent: Array<{ text: string; robots?: number[] }> = [];
  let failRobot = 0;
  const dependencies = {
    now: () => now,
    fetchHtml: async () => { fetchCount += 1; if (failFetch) throw new Error("模拟断网"); return content; },
    send: async (_config: RadarConfig, text: string, robots?: number[]) => {
      sent.push({ text, robots });
      return (robots ?? [1]).map((robotIndex) => ({ robotIndex, ok: robotIndex !== failRobot, error: robotIndex === failRobot ? "模拟发送失败" : undefined }));
    },
  };
  return {
    db, config, sent, dependencies, service: new CalendarReminders(db, config, dependencies),
    setTime: (value: string) => { now = new Date(value); }, setFeed: (value: CalendarFeed) => { content = html(value); },
    setHtml: (value: string) => { content = value; }, failFetch: () => { failFetch = true; },
    failRobot: (index: number) => { failRobot = index; }, fetchCount: () => fetchCount,
  };
}

test("只解析静态JSON，不执行远端网页脚本；校验重复ID与日期", () => {
  assert.equal(parseCalendarFeed(html(feed())).nodes[0].due_date, "2027-01-08");
  assert.throws(() => parseCalendarFeed("<script>throw new Error('不可执行')</script>"), /缺少唯一/);
  assert.throws(() => parseCalendarFeed(html(feed([node, node]))), /重复ID/);
  assert.throws(() => parseCalendarFeed(html(feed([{ ...node, due_date: "2027-02-30" }]))), /无效日期/);
  assert.throws(() => parseCalendarFeed(html(feed()).replace('"Asia/Shanghai"', '"America/New_York"')), /版本或结构/);
  assert.throws(() => parseCalendarFeed(html(feed()).replace(JSON.stringify(feed()), "null")), /版本或结构/);
  assert.throws(() => parseCalendarFeed(html({ ...feed(), nodes: [null as unknown as CalendarNode] })), /缺失字段/);
  assert.equal(chinaDate(new Date("2027-01-01T18:00:00Z")), "2027-01-02");
});

test("手动同步只更新计划，不发送；样式或生成时间变化不重置状态", async () => {
  const h = setup();
  try {
    await h.service.sync();
    h.service.action(h.service.state().nodes[0].id, "done");
    h.setFeed({ ...feed(), generated_at: "2026-11-06T00:00:00Z" });
    await h.service.sync();
    assert.equal(h.service.state().nodes[0].done, true);
    assert.equal(h.fetchCount(), 2); assert.equal(h.sent.length, 0);
  } finally { h.db.close(); }
});

test("每日发送前同步一次，其他时刻反复tick不轮询网页", async () => {
  const h = setup();
  try {
    h.setTime("2027-01-01T00:59:00Z"); await h.service.tick(); assert.equal(h.fetchCount(), 0);
    h.setTime("2027-01-01T01:00:00Z"); await h.service.tick();
    assert.equal(h.fetchCount(), 1); assert.equal(h.sent.length, 1);
    for (let i = 0; i < 10; i += 1) await h.service.tick();
    assert.equal(h.fetchCount(), 1); assert.equal(h.sent.length, 1);
    assert.match(h.sent[0].text, /开始选品.*\n线路：合德正班/);
    const restarted = new CalendarReminders(h.db, h.config, h.dependencies);
    await restarted.tick(); assert.equal(h.fetchCount(), 1); assert.equal(h.sent.length, 1);
  } finally { h.db.close(); }
});

test("设置开始日期之前或关闭提醒时不抓取也不发送", async () => {
  const h = setup();
  try {
    h.config.calendar_start_date = "2027-01-02"; await h.service.tick();
    h.config.calendar_start_date = ""; h.config.calendar_enabled = false; await h.service.tick();
    assert.equal(h.fetchCount(), 0); assert.equal(h.sent.length, 0);
  } finally { h.db.close(); }
});

test("同一事项按7/3/当天提醒，不每天重复；已完成停止提醒", async () => {
  const h = setup();
  try {
    await h.service.tick();
    h.setTime("2027-01-02T01:00:00Z"); await h.service.tick(); assert.equal(h.sent.length, 1);
    h.setTime("2027-01-05T01:00:00Z"); await h.service.tick(); assert.equal(h.sent.length, 2);
    h.service.action(h.service.state().nodes[0].id, "done");
    h.setTime("2027-01-08T01:00:00Z"); await h.service.tick(); assert.equal(h.sent.length, 2);
  } finally { h.db.close(); }
});

test("稍后一天可再次提醒，提醒状态在同步后保留", async () => {
  const h = setup();
  try {
    await h.service.tick();
    h.service.action(h.service.state().nodes[0].id, "snooze");
    await h.service.sync(); assert.equal(h.service.state().nodes[0].snooze_until, "2027-01-02");
    h.setTime("2027-01-02T01:00:00Z"); await h.service.tick(); assert.equal(h.sent.length, 2);
    await h.service.tick(); assert.equal(h.sent.length, 2);
  } finally { h.db.close(); }
});

test("线上日期变化更新待办，已通知事项只发一次变更提示", async () => {
  const h = setup();
  try {
    await h.service.tick();
    h.setFeed(feed([{ ...node, due_date: "2027-01-10" }]));
    await h.service.sync(); assert.equal(h.service.state().nodes[0].due_date, "2027-01-10");
    h.setTime("2027-01-02T01:00:00Z"); await h.service.tick();
    assert.equal(h.sent.length, 2); assert.match(h.sent[1].text, /日期变更/); assert.match(h.sent[1].text, /原截止：2027-01-08/);
    h.setTime("2027-01-03T01:00:00Z"); await h.service.tick();
    assert.equal(h.sent.filter((item) => item.text.includes("日期变更")).length, 1);
  } finally { h.db.close(); }
});

test("取消事件或禁用线路后，已排队的失败消息不会再发", async () => {
  const h = setup();
  try {
    h.failRobot(1); await h.service.tick(); assert.equal(h.sent.length, 1);
    h.setFeed(feed([])); await h.service.sync();
    h.setTime("2027-01-01T01:02:00Z"); await h.service.tick();
    assert.equal(h.sent.length, 1); assert.equal(h.service.state().node_count, 0);
    assert.equal(h.service.state().messages[0].status, "cancelled");
  } finally { h.db.close(); }
});

test("重试只发送失败机器人，成功机器人不重复收到", async () => {
  const h = setup();
  try {
    h.config.dingtalk_token_2 = "test-robot-two"; h.failRobot(2); await h.service.tick();
    assert.deepEqual(h.sent.map((item) => item.robots), [[1], [2]]);
    h.failRobot(0); h.setTime("2027-01-01T01:02:00Z"); await h.service.tick();
    assert.deepEqual(h.sent.map((item) => item.robots), [[1], [2], [2]]); assert.equal(h.fetchCount(), 1);
  } finally { h.db.close(); }
});

test("无效线上方案不覆盖成功缓存；同步失败时按缓存发送并标注", async () => {
  const h = setup();
  try {
    await h.service.tick(); h.setHtml("<html>error page</html>");
    await assert.rejects(h.service.sync(), /缺少唯一/); assert.equal(h.service.state().node_count, 1);
    h.setTime("2027-01-05T01:00:00Z"); h.failFetch(); await h.service.tick();
    assert.match(h.sent[1].text, /线上同步暂未成功.*上次成功同步/);
    assert.match(h.service.state().last_sync_error, /模拟断网/);
  } finally { h.db.close(); }
});

test("没有缓存时同步失败只安排失败重试，正常时刻不额外抓取", async () => {
  const h = setup();
  try {
    h.failFetch(); await h.service.tick(); await h.service.tick();
    assert.equal(h.fetchCount(), 1); assert.equal(h.sent.length, 0);
    h.setTime("2027-01-01T01:16:00Z"); await h.service.tick(); assert.equal(h.fetchCount(), 2);
  } finally { h.db.close(); }
});

test("长消息按UTF8字节分组，预计日期标注且多线路合并", async () => {
  const h = setup();
  try {
    const nodes = Array.from({ length: 50 }, (_, index) => ({ ...node, id: `node-${index}`, event_id: `event-${index}`, event_name: "规划活动".repeat(30) + index, estimated: true }));
    h.setFeed(feed(nodes)); await h.service.tick();
    assert.ok(h.sent.length > 1); assert.ok(h.sent.every((item) => Buffer.byteLength(item.text) < 15_000));
    assert.match(h.sent[0].text, /预计／规划日期/); assert.match(h.sent[0].text, /不代表物流或入库已实际完成/);
  } finally { h.db.close(); }
});
