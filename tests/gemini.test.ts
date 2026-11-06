import assert from "node:assert/strict";
import test from "node:test";
import { configuredGeminiApiKeys, parseGeminiEvents } from "../f/radar/gemini.ts";
import type { RadarConfig } from "../f/radar/types.ts";

test("Gemini Key 列表去空并去重", () => {
  const config = {
    gemini_api_key: " key-one ",
    gemini_api_key_2: "key-two",
  } as RadarConfig;
  assert.deepEqual(configuredGeminiApiKeys(config), ["key-one", "key-two"]);
  config.gemini_api_key_2 = "key-one";
  assert.deepEqual(configuredGeminiApiKeys(config), ["key-one"]);
});

test("解析纯 JSON 和 markdown JSON", () => {
  const json = '{"events":[{"event_id":"x","event_name":"热点"}]}';
  assert.equal(parseGeminiEvents(json)[0]?.event_id, "x");
  assert.equal(parseGeminiEvents(`\`\`\`json\n${json}\n\`\`\``)[0]?.event_name, "热点");
});

test("Gemini 截断时明确报错，避免漏数据却记成成功", () => {
  const truncated = '{"events":[{"event_id":"a","event_name":"A"},{"event_id":"b"';
  assert.throws(() => parseGeminiEvents(truncated), /JSON 不完整或格式错误/);
});

test("只有有效的空数组才表示无结果", () => {
  assert.deepEqual(parseGeminiEvents('{"events":[]}'), []);
  for (const text of ["no json", "", "{}", '{"events":[null]}']) {
    assert.throws(() => parseGeminiEvents(text));
  }
});

test("兼容 Gemini 返回的中文产品字段", () => {
  const json = JSON.stringify({
    events: [{
      event_id: "legacy-product",
      event_name: "大促",
      products: [{
        name_中文: "便携式风扇",
        price_range_当地货币: "300-800 PHP",
      }],
    }],
  });
  const product = parseGeminiEvents(json)[0]?.products?.[0];
  assert.equal(product?.name, "便携式风扇");
  assert.equal(product?.price_range, "300-800 PHP");
});
