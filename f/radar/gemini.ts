import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { RadarConfig, RadarEvent } from "./types.ts";
import { fetchJson } from "./http.ts";

const execFileAsync = promisify(execFile);
let geminiStartGate = Promise.resolve();
let nextGeminiStart = 0;
let nextGeminiKeyIndex = 0;
const geminiKeyCooldowns = new Map<string, number>();

async function waitForGeminiSlot(minIntervalMs: number) {
  let release!: () => void;
  const previous = geminiStartGate;
  geminiStartGate = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  const waitMs = Math.max(0, nextGeminiStart - Date.now());
  if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
  nextGeminiStart = Date.now() + Math.max(0, minIntervalMs);
  release();
}

function quotaRetryMs(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes("429") && !message.includes("RESOURCE_EXHAUSTED")) return 0;
  const match = message.match(/retry in\s+([\d.]+)s/i);
  return Math.ceil((Number(match?.[1] ?? 60) + 1) * 1000);
}

export function configuredGeminiApiKeys(config: RadarConfig): string[] {
  return [...new Set([
    config.gemini_api_key,
    config.gemini_api_key_2,
  ].map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function rotatedGeminiApiKeys(config: RadarConfig): string[] {
  const keys = configuredGeminiApiKeys(config);
  if (keys.length < 2) return keys;
  const start = nextGeminiKeyIndex % keys.length;
  nextGeminiKeyIndex = (nextGeminiKeyIndex + 1) % keys.length;
  return [...keys.slice(start), ...keys.slice(0, start)];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redactApiKeys(message: string, keys: string[]): string {
  return keys.reduce((result, key) => result.replaceAll(key, "[REDACTED]"), message);
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
}

async function callGeminiWithCurl(
  url: string,
  apiKey: string,
  body: string,
  timeoutMs: number,
  proxy: string,
): Promise<GeminiResponse> {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "radar-gemini-"));
  const requestFile = path.join(temp, "request.json");
  try {
    await fs.writeFile(requestFile, body, "utf8");
    const args = [
      "--silent",
      "--show-error",
      "--fail-with-body",
      "--http1.1",
      "--connect-timeout", "20",
      "--max-time", String(Math.ceil(timeoutMs / 1000)),
      "--request", "POST",
      "--header", "Content-Type: application/json",
      "--header", `x-goog-api-key: ${apiKey}`,
      "--data-binary", `@${requestFile}`,
      url,
    ];
    if (proxy) args.splice(args.length - 1, 0, "--proxy", proxy);
    const { stdout } = await execFileAsync("curl.exe", args, {
      timeout: timeoutMs + 10_000,
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true,
    });
    return JSON.parse(stdout) as GeminiResponse;
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

function normalizeProducts(events: RadarEvent[]): RadarEvent[] {
  for (const event of events) {
    if (!Array.isArray(event.products)) continue;
    event.products = event.products.map((product) => {
      const p = product as unknown as Record<string, unknown>;
      const name = p.name ?? p["name_中文"] ?? p.product_name ?? "";
      const price_range = p.price_range ?? p["price_range_当地货币"] ?? p.price ?? "";
      return {
        ...p,
        name: String(name),
        price_range: String(price_range),
      };
    });
  }
  return events;
}

export function parseGeminiEvents(text: string): RadarEvent[] {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  let candidate = fenced ? fenced[1].trim() : text.trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}") + 1;
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(candidate.slice(start, end)) as { events?: RadarEvent[] };
      if (Array.isArray(parsed.events)) return normalizeProducts(parsed.events);
    } catch {
      // 与原流程一致：完整 JSON 失败后尝试保留已经闭合的事件对象。
    }
  }

  if (start >= 0) candidate = candidate.slice(start);
  const lastComplete = candidate.lastIndexOf("},");
  if (lastComplete > 0) {
    try {
      const repaired = `${candidate.slice(0, lastComplete + 1)}]}`;
      const parsed = JSON.parse(repaired) as { events?: RadarEvent[] };
      if (Array.isArray(parsed.events)) return normalizeProducts(parsed.events);
    } catch {
      return [];
    }
  }
  return [];
}

export async function callGeminiText(
  config: RadarConfig,
  prompt: string,
): Promise<string> {
  const configuredKeys = configuredGeminiApiKeys(config);
  if (!configuredKeys.length) throw new Error("Gemini API Key 尚未配置");
  const baseUrl =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(config.gemini_model)}:generateContent`;
  const requestBody = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 65536 },
  });
  // 这台 Windows 的 Google 长 POST 直连偶发 TLS reset；长提示优先走本机代理。
  const preferProxy = Boolean(config.https_proxy) && requestBody.length >= 6000;

  const requestWithKey = async (apiKey: string): Promise<GeminiResponse> => {
    const fetchRequest = () => fetchJson<GeminiResponse>(
      `${baseUrl}?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: requestBody,
        timeoutMs: config.gemini_timeout_ms,
        retries: 0,
      },
    );
    const curlRequest = () => callGeminiWithCurl(
      baseUrl,
      apiKey,
      requestBody,
      config.gemini_timeout_ms,
      config.https_proxy,
    );
    await waitForGeminiSlot(config.gemini_min_interval_ms);
    try {
      return await (preferProxy ? curlRequest : fetchRequest)();
    } catch (primaryError) {
      if (quotaRetryMs(primaryError)) throw primaryError;
      await waitForGeminiSlot(config.gemini_min_interval_ms);
      try {
        return await (preferProxy ? fetchRequest : curlRequest)();
      } catch (fallbackError) {
        const first = redactApiKeys(messageOf(primaryError), configuredKeys);
        const second = redactApiKeys(messageOf(fallbackError), configuredKeys);
        throw new Error(`Gemini 主请求与回退均失败：${first} | ${second}`);
      }
    }
  };

  const quotaErrors: string[] = [];
  for (let round = 0; round < 2; round += 1) {
    const keys = rotatedGeminiApiKeys(config);
    for (const apiKey of keys) {
      if ((geminiKeyCooldowns.get(apiKey) ?? 0) > Date.now()) continue;
      try {
        const response = await requestWithKey(apiKey);
        geminiKeyCooldowns.delete(apiKey);
        return response.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      } catch (error) {
        const retryMs = quotaRetryMs(error);
        if (!retryMs) throw error;
        geminiKeyCooldowns.set(apiKey, Date.now() + retryMs);
        quotaErrors.push(redactApiKeys(messageOf(error), configuredKeys));
      }
    }

    if (round === 0) {
      const waits = keys
        .map((key) => Math.max(0, (geminiKeyCooldowns.get(key) ?? 0) - Date.now()))
        .filter((waitMs) => waitMs > 0);
      if (waits.length) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(...waits)));
      }
    }
  }

  const mode = configuredKeys.length > 1 ? "两个 Gemini Key" : "Gemini Key";
  const details = quotaErrors.at(-1) ?? "请求配额暂未恢复";
  throw new Error(`${mode}均达到配额限制：${details}`);
}

export async function callGemini(
  config: RadarConfig,
  prompt: string,
): Promise<{ events: RadarEvent[]; rawText: string }> {
  const rawText = await callGeminiText(config, prompt);
  return { events: parseGeminiEvents(rawText), rawText };
}
