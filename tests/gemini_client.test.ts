import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
  createGeminiClient, decodeGeminiHttpResponse, GeminiFailure, geminiFailurePayload,
  parseGeminiArray, requestGemini, type GeminiRequest, type GeminiResponse,
} from "../f/radar/gemini_client.ts";
import type { RadarConfig } from "../f/radar/types.ts";

const config = {
  gemini_api_key: "test-key-one", gemini_api_key_2: "", gemini_model: "test-model",
  gemini_timeout_ms: 1000, gemini_min_interval_ms: 0, https_proxy: "http://test-proxy.invalid:7897",
} as RadarConfig;
const reply = (text = '{"events":[]}'): GeminiResponse => ({
  candidates: [{ finishReason: "STOP", content: { parts: [{ text }] } }],
});
function harness(request: (input: GeminiRequest) => Promise<GeminiResponse>) {
  let now = 1_000;
  const waits: number[] = [];
  return {
    waits,
    client: createGeminiClient({ request, now: () => now, random: () => 0,
      sleep: async (ms) => { waits.push(ms); now += ms; } }),
  };
}

test("503最多尝试4次并按15/30/60秒退避，不更换代理和模型", async () => {
  const requests: GeminiRequest[] = [];
  const { client, waits } = harness(async (input) => {
    requests.push(input);
    throw new GeminiFailure("model high demand", true, 503);
  });
  await assert.rejects(client.generate(config, "short", { arrayField: "events" }), (error) => {
    assert.match(String(error), /尝试4次.*high demand/);
    const saved = geminiFailurePayload(error)!;
    assert.equal(saved.metadata.transport, "proxy");
    assert.deepEqual(saved.metadata.attempts.map((item) => item.status), [503, 503, 503, 503]);
    return true;
  });
  assert.deepEqual(waits, [15_000, 30_000, 60_000]);
  assert.equal(requests.length, 4);
  assert.ok(requests.every((input) => input.proxy === config.https_proxy && input.url.includes("test-model")));
});

test("短请求和长请求都使用相同代理，并声明JSON输出", async () => {
  const requests: GeminiRequest[] = [];
  const { client } = harness(async (input) => { requests.push(input); return reply(); });
  await client.generate(config, "hi", { arrayField: "events" });
  await client.generate(config, "x".repeat(25_000), { arrayField: "events" });
  assert.deepEqual(requests.map((input) => input.proxy), [config.https_proxy, config.https_proxy]);
  assert.ok(requests.every((input) => JSON.parse(input.body).generationConfig.responseMimeType === "application/json"));
});

test("完整拼接所有正文段，排除thought并保留结束原因和用量", async () => {
  const { client } = harness(async () => ({
    candidates: [{ finishReason: "STOP", content: { parts: [
      { thought: true, text: "推理内容不能混入JSON" },
      { text: '{"events":[' }, { text: '{"event_id":"x"}]}' },
    ] } }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 }, modelVersion: "test-model-v1",
  }));
  const result = await client.generate(config, "test", { arrayField: "events" });
  assert.equal(parseGeminiArray(result.text, "events")[0]?.event_id, "x");
  assert.equal(result.metadata.finish_reason, "STOP");
  assert.equal(result.metadata.usage?.promptTokenCount, 100);
  assert.equal(result.metadata.model_version, "test-model-v1");
});

test("截断JSON重试一次仍失败就报错，保留原文供排查", async () => {
  const text = '{"events":[{"event_name":"退伍军人节","products":[{"name":"旗帜"},{"price_';
  let calls = 0;
  const { client } = harness(async () => { calls += 1; return reply(text); });
  await assert.rejects(client.generate(config, "test", { arrayField: "events" }), (error) => {
    assert.match(String(error), /JSON 不完整或格式错误/);
    assert.equal(geminiFailurePayload(error)?.text, text);
    assert.equal(geminiFailurePayload(error)?.metadata.response_chars, text.length);
    return true;
  });
  assert.equal(calls, 2);
});

test("运营JSON同样严格校验，合法空数组不会重试", async () => {
  let calls = 0;
  const { client } = harness(async () => { calls += 1; return reply('{"intelligence":[]}'); });
  const result = await client.generate(config, "test", { arrayField: "intelligence" });
  assert.deepEqual(parseGeminiArray(result.text, "intelligence"), []);
  assert.equal(calls, 1);
  assert.throws(() => parseGeminiArray('{"intelligence":[{"title":"未完成"', "intelligence"), /JSON 不完整/);
  assert.throws(() => parseGeminiArray('{"events":[]}', "intelligence"), /intelligence/);
});

test("首个回复格式错误，第二个完整回复可恢复", async () => {
  let calls = 0;
  const { client } = harness(async () => reply(++calls === 1 ? '{"events":[' : '{"events":[{"event_id":"recovered"}]}'));
  const result = await client.generate(config, "test", { arrayField: "events" });
  assert.equal(calls, 2);
  assert.equal(result.metadata.attempts.length, 2);
  assert.equal(parseGeminiArray(result.text, "events")[0]?.event_id, "recovered");
});

test("MAX_TOKENS和空回复不会被误当成无情报", async () => {
  for (const response of [
    { candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: '{"events":[]}' }] } }] },
    { candidates: [{ finishReason: "STOP", content: { parts: [] } }] },
  ]) {
    let calls = 0;
    const { client } = harness(async () => { calls += 1; return response; });
    await assert.rejects(client.generate(config, "test", { arrayField: "events" }), /MAX_TOKENS|空回复/);
    assert.equal(calls, 2);
  }
});

test("安全拦截与403权限错误不做无效重试", async () => {
  for (const blocked of [true, false]) {
    let calls = 0;
    const { client, waits } = harness(async () => {
      calls += 1;
      if (blocked) return { promptFeedback: { blockReason: "SAFETY" } };
      throw new GeminiFailure("permission denied", false, 403);
    });
    await assert.rejects(client.generate(config, "test", { arrayField: "events" }), /SAFETY|permission denied/);
    assert.equal(calls, 1);
    assert.deepEqual(waits, []);
  }
});

test("429按Google建议冷却，并优先使用未冷却的备用Key", async () => {
  const keys: string[] = [];
  const { client, waits } = harness(async (input) => {
    keys.push(input.apiKey);
    if (keys.length === 1) throw new GeminiFailure("quota", true, 429, 5000);
    return reply();
  });
  await client.generate({ ...config, gemini_api_key_2: "test-key-two" }, "test", { arrayField: "events" });
  assert.deepEqual(keys, ["test-key-one", "test-key-two"]);
  assert.deepEqual(waits, []);
  const single = harness(async () => {
    if (!single.waits.length) throw new GeminiFailure("quota", true, 429, 5000);
    return reply();
  });
  await single.client.generate(config, "test", { arrayField: "events" });
  assert.deepEqual(single.waits, [5000]);
});

test("服务端Retry-After优先于本地退避，HTTP错误正文不丢失", async () => {
  let calls = 0;
  const { client, waits } = harness(async () => {
    if (++calls === 1) return decodeGeminiHttpResponse(503, '{"error":{"status":"UNAVAILABLE","message":"high demand"}}', "45");
    return reply();
  });
  const result = await client.generate(config, "test", { arrayField: "events" });
  assert.deepEqual(waits, [45_000]);
  assert.match(result.metadata.attempts[0]?.error ?? "", /503.*UNAVAILABLE.*high demand/);
  assert.throws(() => decodeGeminiHttpResponse(429, '{"error":{"details":[{"retryDelay":"2.5s"}]}}'), (error) => {
    assert.equal((error as GeminiFailure).retryAfterMs, 2500);
    return true;
  });
});

test("媒体网页等请求完整串行，某个失败后仍释放队列", async () => {
  let active = 0, peak = 0, calls = 0;
  const { client } = harness(async () => {
    const call = ++calls;
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active -= 1;
    if (call === 2) throw new GeminiFailure("bad request", false, 400);
    return reply();
  });
  const results = await Promise.allSettled(["媒体", "网页", "运营"].map((prompt) => client.generate(config, prompt, { arrayField: "events" })));
  assert.equal(peak, 1);
  assert.deepEqual(results.map((result) => result.status), ["fulfilled", "rejected", "fulfilled"]);
});

test("串行调用仍遵守配置的最小启动间隔", async () => {
  const { client, waits } = harness(async () => reply());
  await Promise.all(["one", "two"].map((prompt) => client.generate({ ...config, gemini_min_interval_ms: 8000 }, prompt)));
  assert.deepEqual(waits, [8000]);
});

test("最终错误与诊断均隐藏Key和代理凭据", async () => {
  const { client } = harness(async () => { throw new GeminiFailure(`${config.gemini_api_key} ${config.https_proxy}`, false, 403); });
  await assert.rejects(client.generate(config, "test"), (error) => {
    const serialized = `${error} ${JSON.stringify(geminiFailurePayload(error))}`;
    assert.ok(!serialized.includes(config.gemini_api_key));
    assert.ok(!serialized.includes(config.https_proxy));
    return true;
  });
});

test("实际curl通过本地模拟代理取得503正文并恢复，不访问Google", { skip: process.platform !== "win32" }, async () => {
  const received: Array<{ url?: string; key?: string; body: string }> = [];
  const proxy = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += String(chunk);
    received.push({ url: req.url, key: req.headers["x-goog-api-key"] as string, body });
    res.writeHead(received.length === 1 ? 503 : 200, { "Content-Type": "application/json" });
    res.end(received.length === 1 ? '{"error":{"status":"UNAVAILABLE","message":"mock high demand"}}' : JSON.stringify(reply()));
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  try {
    const port = (proxy.address() as { port: number }).port;
    const { client } = harness((input) => requestGemini({ ...input, url: "http://gemini.invalid/generate", timeoutMs: 5000 }));
    const result = await client.generate({ ...config, https_proxy: `http://127.0.0.1:${port}` }, "mock prompt", { arrayField: "events" });
    assert.equal(received.length, 2);
    assert.ok(received.every((request) => request.url === "http://gemini.invalid/generate" && request.key === config.gemini_api_key));
    assert.deepEqual(parseGeminiArray(result.text, "events"), []);
    assert.match(result.metadata.attempts[0]?.error ?? "", /503.*mock high demand/);
  } finally { await new Promise<void>((resolve) => proxy.close(() => resolve())); }
});

test("无代理时直连本地模拟服务，用请求头传Key且正确读取回复", async () => {
  let receivedKey = "", receivedBody = "";
  const server = http.createServer(async (req, res) => {
    receivedKey = String(req.headers["x-goog-api-key"]);
    for await (const chunk of req) receivedBody += String(chunk);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(reply()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const response = await requestGemini({
      url: `http://127.0.0.1:${port}/generate`, apiKey: "local-dummy-key", body: '{"contents":[]}', timeoutMs: 1000, proxy: "",
    });
    assert.equal(receivedKey, "local-dummy-key");
    assert.equal(receivedBody, '{"contents":[]}');
    assert.equal(response.candidates?.[0]?.finishReason, "STOP");
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("代理端口未监听时只失败一次，不发模型请求或退避重试", async () => {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const { client, waits } = harness(requestGemini);
  await assert.rejects(client.generate({ ...config, https_proxy: `http://127.0.0.1:${port}` }, "test", { arrayField: "events" }), (error) => {
    assert.match(String(error), /尝试1次.*代理不可用.*ECONNREFUSED/);
    assert.equal(geminiFailurePayload(error)?.metadata.attempts.length, 1);
    return true;
  });
  assert.deepEqual(waits, []);
});
