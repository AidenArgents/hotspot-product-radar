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

async function runGeminiRequest<T>(
  request: () => Promise<T>,
  minIntervalMs: number,
): Promise<T> {
  await waitForGeminiSlot(minIntervalMs);
  try {
    return await request();
  } catch (error) {
    const waitMs = quotaRetryMs(error);
    if (!waitMs) throw error;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    await waitForGeminiSlot(minIntervalMs);
    return request();
  }
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

export function parseGeminiEvents(text: string): RadarEvent[] {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  let candidate = fenced ? fenced[1].trim() : text.trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}") + 1;
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(candidate.slice(start, end)) as { events?: RadarEvent[] };
      if (Array.isArray(parsed.events)) return parsed.events;
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
      if (Array.isArray(parsed.events)) return parsed.events;
    } catch {
      return [];
    }
  }
  return [];
}

export async function callGemini(
  config: RadarConfig,
  prompt: string,
): Promise<{ events: RadarEvent[]; rawText: string }> {
  const baseUrl =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(config.gemini_model)}:generateContent`;
  const requestBody = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 65536 },
  });
  const fetchRequest = () => fetchJson<GeminiResponse>(
    `${baseUrl}?key=${encodeURIComponent(config.gemini_api_key)}`,
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
    config.gemini_api_key,
    requestBody,
    config.gemini_timeout_ms,
    config.https_proxy,
  );
  // 这台 Windows 的 Google 长 POST 直连偶发 TLS reset；长提示优先走本机代理。
  const preferProxy = Boolean(config.https_proxy) && requestBody.length >= 6000;
  let response: GeminiResponse;
  try {
    response = await runGeminiRequest(
      preferProxy ? curlRequest : fetchRequest,
      config.gemini_min_interval_ms,
    );
  } catch (primaryError) {
    if (quotaRetryMs(primaryError)) {
      const message = (primaryError instanceof Error ? primaryError.message : String(primaryError))
        .replaceAll(config.gemini_api_key, "[REDACTED]");
      throw new Error(`Gemini 配额等待后仍未恢复：${message}`);
    }
    try {
      response = await runGeminiRequest(
        preferProxy ? fetchRequest : curlRequest,
        config.gemini_min_interval_ms,
      );
    } catch (fallbackError) {
      const first = (primaryError instanceof Error ? primaryError.message : String(primaryError))
        .replaceAll(config.gemini_api_key, "[REDACTED]");
      const second = (fallbackError instanceof Error ? fallbackError.message : String(fallbackError))
        .replaceAll(config.gemini_api_key, "[REDACTED]");
      throw new Error(`Gemini 主请求与回退均失败：${first} | ${second}`);
    }
  }
  const rawText = response.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  return { events: parseGeminiEvents(rawText), rawText };
}
