import assert from "node:assert/strict";
import test from "node:test";
import { parseGeminiEvents } from "../f/radar/gemini.ts";

test("解析纯 JSON 和 markdown JSON", () => {
  const json = '{"events":[{"event_id":"x","event_name":"热点"}]}';
  assert.equal(parseGeminiEvents(json)[0]?.event_id, "x");
  assert.equal(parseGeminiEvents(`\`\`\`json\n${json}\n\`\`\``)[0]?.event_name, "热点");
});

test("Gemini 截断时保留最后一个完整事件", () => {
  const truncated = '{"events":[{"event_id":"a","event_name":"A"},{"event_id":"b"';
  assert.deepEqual(parseGeminiEvents(truncated).map((event) => event.event_id), ["a"]);
});

test("无有效 JSON 时安全返回空数组", () => {
  assert.deepEqual(parseGeminiEvents("no json"), []);
});
