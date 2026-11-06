import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createConnection } from "node:net";
import { promisify } from "node:util";
import type { RadarConfig } from "./types.ts";

const execFileAsync = promisify(execFile);
type ArrayField = "events" | "intelligence";
export interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; thought?: boolean }> };
    finishReason?: string;
    finishMessage?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: Record<string, unknown>;
  modelVersion?: string;
}
export interface GeminiDiagnostics {
  model: string;
  transport: "proxy" | "direct";
  response_chars: number;
  finish_reason?: string;
  block_reason?: string;
  model_version?: string;
  usage?: Record<string, unknown>;
  attempts: Array<{ status?: number; error?: string; elapsed_ms: number; retry_delay_ms?: number }>;
}
export type GeminiResult = { text: string; metadata: GeminiDiagnostics };
export class GeminiFailure extends Error {
  result?: GeminiResult;
  constructor(
    message: string, readonly retryable = false, readonly status?: number,
    readonly retryAfterMs = 0, readonly outputError = false,
  ) { super(message); }
}
export function geminiFailurePayload(error: unknown): GeminiResult | undefined {
  return error instanceof GeminiFailure ? error.result : undefined;
}
export function configuredGeminiApiKeys(config: RadarConfig): string[] {
  return [...new Set([config.gemini_api_key, config.gemini_api_key_2]
    .map((value) => String(value ?? "").trim()).filter(Boolean))];
}
export function parseGeminiArray(text: string, field: ArrayField): Array<Record<string, unknown>> {
  const fenced = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  let parsed: unknown;
  try { parsed = JSON.parse(fenced?.[1] ?? text.trim()); }
  catch { throw new GeminiFailure("Gemini 返回的 JSON 不完整或格式错误，不能视为无结果", true, undefined, 0, true); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new GeminiFailure("Gemini 返回的 JSON 根节点不是对象", true, undefined, 0, true);
  }
  const items = (parsed as Record<string, unknown>)[field];
  if (!Array.isArray(items) || items.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
    throw new GeminiFailure(`Gemini 返回的 ${field} 必须是对象数组`, true, undefined, 0, true);
  }
  return items;
}
function retryDelay(value: string | null, now = Date.now()) {
  if (!value) return 0;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(value) - now) || 0;
}
export function decodeGeminiHttpResponse(status: number, body: string, retryAfter: string | null = null): GeminiResponse {
  if (status < 200 || status >= 300) {
    let message = body.slice(0, 800);
    let retryAfterMs = retryDelay(retryAfter);
    try {
      const data = JSON.parse(body) as { error?: { message?: string; status?: string; details?: Array<{ retryDelay?: string }> } };
      message = [data.error?.status, data.error?.message].filter(Boolean).join(": ") || message;
      for (const detail of data.error?.details ?? []) {
        const duration = detail.retryDelay?.match(/^([\d.]+)s$/)?.[1];
        if (duration) retryAfterMs = Math.max(retryAfterMs, Number(duration) * 1000);
      }
    } catch { /* 非 JSON 错误页仍保留 HTTP 状态。 */ }
    throw new GeminiFailure(`Gemini HTTP ${status}: ${message}`, [408, 429, 500, 502, 503, 504].includes(status), status, retryAfterMs);
  }
  try {
    const response = JSON.parse(body) as GeminiResponse;
    if (!response || typeof response !== "object" || Array.isArray(response)) throw new Error("无效响应");
    return response;
  }
  catch { throw new GeminiFailure("Gemini HTTP 成功但响应不是完整 JSON", true, status, 0, true); }
}
export interface GeminiRequest {
  url: string;
  apiKey: string;
  body: string;
  timeoutMs: number;
  proxy: string;
}
export async function assertGeminiProxyAvailable(proxy: string): Promise<void> {
  if (!proxy) return;
  let address: URL;
  try { address = new URL(proxy); }
  catch { throw new GeminiFailure("Gemini代理地址无效，请检查系统设置中的HTTPS代理"); }
  if (!["http:", "https:", "socks4:", "socks4a:", "socks5:", "socks5h:"].includes(address.protocol)) {
    throw new GeminiFailure("Gemini代理协议不支持，请检查系统设置中的HTTPS代理");
  }
  const host = address.hostname.replace(/^\[|\]$/g, "");
  const port = Number(address.port || (address.protocol === "https:" ? 443 : address.protocol.startsWith("socks") ? 1080 : 80));
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host, port });
    const finish = (error?: string) => {
      clearTimeout(timer); socket.destroy();
      if (error) reject(new GeminiFailure(`Gemini代理不可用（${host}:${port}）：${error}。请启动代理或核对端口；本次停止，不反复重试失效端口`));
      else resolve();
    };
    const timer = setTimeout(() => finish("连接超时"), 3000);
    socket.once("connect", () => finish());
    socket.once("error", (error) => finish((error as NodeJS.ErrnoException).code || "连接失败"));
  });
}
async function requestWithCurl(input: GeminiRequest): Promise<GeminiResponse> {
  const tempRoot = path.resolve(os.tmpdir());
  const temp = await fs.mkdtemp(path.join(tempRoot, "radar-gemini-"));
  const requestFile = path.join(temp, "request.json");
  const headerFile = path.join(temp, "headers.txt");
  try {
    await fs.writeFile(requestFile, input.body, "utf8");
    const args = [
      "--silent", "--show-error", "--http1.1", "--connect-timeout", "20",
      "--max-time", String(Math.ceil(input.timeoutMs / 1000)),
      "--request", "POST", "--header", "Content-Type: application/json",
      "--header", `x-goog-api-key: ${input.apiKey}`,
      "--data-binary", `@${requestFile}`, "--dump-header", headerFile,
      "--write-out", "\n__RADAR_HTTP_STATUS__:%{http_code}",
      "--proxy", input.proxy, input.url,
    ];
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync("curl.exe", args, {
        timeout: input.timeoutMs + 10_000, maxBuffer: 20 * 1024 * 1024, windowsHide: true,
      }));
    } catch (error) {
      const failure = error as { code?: string | number; stderr?: string; killed?: boolean };
      // 不记录 execFile.message，避免日志带上含 Key/代理凭据的完整命令。
      throw new GeminiFailure(`Gemini 代理连接失败：${failure.stderr?.trim() || (failure.killed ? "请求超时" : `curl 错误 ${failure.code}`)}`, failure.code !== "ENOENT");
    }
    const trailer = stdout.match(/\n__RADAR_HTTP_STATUS__:(\d{3})\s*$/);
    if (!trailer) throw new GeminiFailure("Gemini 代理响应缺少 HTTP 状态", true);
    const headers = await fs.readFile(headerFile, "utf8");
    const retryAfter = [...headers.matchAll(/^retry-after:\s*(.+)\r?$/gim)].at(-1)?.[1]?.trim() ?? null;
    return decodeGeminiHttpResponse(Number(trailer[1]), stdout.slice(0, trailer.index), retryAfter);
  } finally {
    if (path.dirname(path.resolve(temp)) === tempRoot && path.basename(temp).startsWith("radar-gemini-")) {
      await fs.rm(temp, { recursive: true, force: true });
    }
  }
}
export async function requestGemini(input: GeminiRequest): Promise<GeminiResponse> {
  // 短请求和重试也使用配置的同一代理，不静默回退直连。
  if (input.proxy) {
    await assertGeminiProxyAvailable(input.proxy);
    return requestWithCurl(input);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await fetch(input.url, {
      method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": input.apiKey },
      body: input.body, signal: controller.signal,
    });
    return decodeGeminiHttpResponse(response.status, await response.text(), response.headers.get("retry-after"));
  } catch (error) {
    if (error instanceof GeminiFailure) throw error;
    throw new GeminiFailure(`Gemini 直连请求失败：${error instanceof Error ? error.message : String(error)}`, true);
  } finally { clearTimeout(timer); }
}
type GenerateOptions = { arrayField?: ArrayField; onProgress?: (message: string) => void };
type ClientDependencies = {
  request: (input: GeminiRequest) => Promise<GeminiResponse>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  random: () => number;
};
export function createGeminiClient(overrides: Partial<ClientDependencies> = {}) {
  const deps: ClientDependencies = {
    request: requestGemini, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now, random: Math.random, ...overrides,
  };
  let queue = Promise.resolve();
  let nextStart = 0;
  let keyIndex = 0;
  const cooldowns = new Map<string, number>();
  async function generate(config: RadarConfig, prompt: string, options: GenerateOptions): Promise<GeminiResult> {
    const configuredKeys = configuredGeminiApiKeys(config);
    if (!configuredKeys.length) throw new GeminiFailure("Gemini API Key 尚未配置");
    const start = keyIndex++ % configuredKeys.length;
    const keys = [...configuredKeys.slice(start), ...configuredKeys.slice(0, start)];
    const secrets = [...configuredKeys, config.https_proxy].filter(Boolean);
    const redact = (text: string) => secrets.reduce((value, secret) => value.replaceAll(secret, "[REDACTED]"), text);
    const result: GeminiResult = {
      text: "", metadata: { model: config.gemini_model, transport: config.https_proxy ? "proxy" : "direct", response_chars: 0, attempts: [] },
    };
    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 65536, responseMimeType: "application/json" },
    });
    let outputFailures = 0;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const availableKey = keys.find((key) => (cooldowns.get(key) ?? 0) <= deps.now());
      const apiKey = availableKey ?? keys.reduce((a, b) => (cooldowns.get(a) ?? 0) <= (cooldowns.get(b) ?? 0) ? a : b);
      const waitMs = Math.max(0, nextStart - deps.now(), (cooldowns.get(apiKey) ?? 0) - deps.now());
      if (waitMs) await deps.sleep(waitMs);
      const started = deps.now();
      nextStart = started + Math.max(0, config.gemini_min_interval_ms);
      const record: GeminiDiagnostics["attempts"][number] = { elapsed_ms: 0 };
      result.metadata.attempts.push(record);
      try {
        const response = await deps.request({
          url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.gemini_model)}:generateContent`,
          apiKey, body, timeoutMs: config.gemini_timeout_ms, proxy: config.https_proxy || "",
        });
        record.status = 200;
        const candidate = response.candidates?.[0];
        result.text = (candidate?.content?.parts ?? []).filter((part) => !part.thought).map((part) => part.text ?? "").join("");
        Object.assign(result.metadata, {
          finish_reason: candidate?.finishReason, block_reason: response.promptFeedback?.blockReason,
          usage: response.usageMetadata, model_version: response.modelVersion, response_chars: result.text.length,
        });
        if (response.promptFeedback?.blockReason) throw new GeminiFailure(`Gemini 拒绝生成：${response.promptFeedback.blockReason}`);
        if (candidate?.finishReason && candidate.finishReason !== "STOP") {
          throw new GeminiFailure(`Gemini 回复未正常完成：${candidate.finishReason}${candidate.finishMessage ? `（${candidate.finishMessage}）` : ""}`, candidate.finishReason === "MAX_TOKENS", undefined, 0, true);
        }
        if (!result.text.trim()) throw new GeminiFailure("Gemini 返回空回复，不能视为无结果", true, undefined, 0, true);
        if (options.arrayField) parseGeminiArray(result.text, options.arrayField);
        cooldowns.delete(apiKey);
        return result;
      } catch (error) {
        const failure = error instanceof GeminiFailure ? error : new GeminiFailure(error instanceof Error ? error.message : String(error));
        record.status = failure.status ?? record.status;
        record.error = redact(failure.message);
        record.elapsed_ms = deps.now() - started;
        if (failure.outputError) outputFailures += 1;
        if (failure.status === 429) cooldowns.set(apiKey, deps.now() + (failure.retryAfterMs || 61_000));
        if (!failure.retryable || attempt === 3 || outputFailures >= 2) {
          const final = new GeminiFailure(`Gemini 调用失败（尝试${attempt + 1}次）：${record.error}`, false, failure.status);
          final.result = result;
          throw final;
        }
        const otherKeyAvailable = failure.status === 429 && keys.some((key) => key !== apiKey && (cooldowns.get(key) ?? 0) <= deps.now());
        const baseDelay = failure.status === 429 ? (failure.retryAfterMs || 61_000) : [15_000, 30_000, 60_000][attempt];
        const delay = otherKeyAvailable ? 0 : Math.max(failure.retryAfterMs, baseDelay) + Math.floor(deps.random() * 1000);
        record.retry_delay_ms = delay;
        options.onProgress?.(`Gemini ${failure.status ?? "回复异常"}，${Math.ceil(delay / 1000)}秒后进行第${attempt + 2}次尝试`);
        if (delay) await deps.sleep(delay);
      } finally { if (!record.error) record.elapsed_ms = deps.now() - started; }
    }
    throw new GeminiFailure("Gemini 重试结束");
  }
  return {
    generate(config: RadarConfig, prompt: string, options: GenerateOptions = {}) {
      // 锁覆盖完整请求和重试，所有情报线路共同排队，失败也释放队列。
      const task = queue.then(() => generate(config, prompt, options));
      queue = task.then(() => undefined, () => undefined);
      return task;
    },
  };
}
const client = createGeminiClient();
export const callGeminiResponse = client.generate;
