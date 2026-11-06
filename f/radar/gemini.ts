import type { RadarConfig, RadarEvent } from "./types.ts";
import { callGeminiResponse, parseGeminiArray, type GeminiDiagnostics } from "./gemini_client.ts";

export { configuredGeminiApiKeys, geminiFailurePayload } from "./gemini_client.ts";

function normalizeProducts(events: RadarEvent[]): RadarEvent[] {
  for (const event of events) {
    if (!Array.isArray(event.products)) continue;
    event.products = event.products.map((product) => {
      const p = product as unknown as Record<string, unknown>;
      return {
        ...p,
        name: String(p.name ?? p["name_中文"] ?? p.product_name ?? ""),
        price_range: String(p.price_range ?? p["price_range_当地货币"] ?? p.price ?? ""),
      };
    });
  }
  return events;
}

export function parseGeminiEvents(text: string): RadarEvent[] {
  return normalizeProducts(parseGeminiArray(text, "events") as RadarEvent[]);
}

export async function callGeminiText(config: RadarConfig, prompt: string): Promise<string> {
  return (await callGeminiResponse(config, prompt)).text;
}

export async function callGemini(
  config: RadarConfig,
  prompt: string,
  onProgress?: (message: string) => void,
): Promise<{ events: RadarEvent[]; rawText: string; metadata: GeminiDiagnostics }> {
  const response = await callGeminiResponse(config, prompt, { arrayField: "events", onProgress });
  return { events: parseGeminiEvents(response.text), rawText: response.text, metadata: response.metadata };
}
