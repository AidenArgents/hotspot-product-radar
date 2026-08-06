import crypto from "node:crypto";
import type { BranchResult, RadarConfig, RadarEvent, RuntimeContext } from "./types.ts";
import { fetchJson } from "./http.ts";

const LINE_TITLES = {
  假日: "假日API",
  媒体: "Tavily媒体",
  网页: "网页抓取",
} as const;

export function buildDingTalkMessage(
  config: RadarConfig,
  context: RuntimeContext,
  branch: BranchResult,
  events: RadarEvent[],
): string {
  let message = `🎯 热点选品雷达v7·${LINE_TITLES[branch.line]} · ${context.current_date}\n`;
  message += `📍 ${context.target_region} | ${context.time_range}\n`;
  message += `📊 ${events.length}个事件 | ${branch.analysis}\n`;
  message += `════════════════════════════\n\n`;
  events.slice(0, 10).forEach((event, index) => {
    const score = event.ecommerce_score ?? 0;
    const marker = score >= 80 ? "🔥" : score >= 60 ? "⭐" : "📌";
    message += `${marker} ${index + 1}. 【${event.event_name ?? ""}】${score}分\n`;
    message += `   📍 ${event.country ?? ""} | 📅 ${event.date ?? ""} | ${event.stage ?? ""}\n`;
    if ((event.products ?? []).length) {
      message += "   🛒 推荐选品：\n";
      for (const product of (event.products ?? []).slice(0, 3)) {
        message += `      · ${product.name ?? ""} (${product.category ?? ""})\n`;
        if (product.price_range) message += `        💰 ${product.price_range}\n`;
        if (product.keywords_en?.length) {
          message += `        🔑 ${product.keywords_en.slice(0, 3).join(", ")}\n`;
        }
      }
    }
    if (event.best_listing_time) message += `   ⏰ 最佳上架：${event.best_listing_time}\n`;
    if (event.why_sellable) message += `   💡 ${event.why_sellable.slice(0, 80)}\n`;
    message += "\n";
  });
  const reportUrl =
    config.dashboard_url ||
    `https://docs.google.com/spreadsheets/d/${config.spreadsheet_id}`;
  message += "────────────────────────────\n";
  message += `📋 完整报告→ ${reportUrl}`;
  return message.slice(0, 19000);
}

function signedUrl(token: string, secret: string): string {
  const timestamp = Date.now();
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}\n${secret}`)
    .digest("base64");
  return (
    `https://oapi.dingtalk.com/robot/send?access_token=${encodeURIComponent(token)}` +
    `&timestamp=${timestamp}&sign=${encodeURIComponent(signature)}`
  );
}

export async function sendDingTalk(
  config: RadarConfig,
  content: string,
): Promise<Array<{ robotIndex: number; ok: boolean; response?: unknown; error?: string }>> {
  if (!content || content.length < 50) return [];
  const robots = [
    [config.dingtalk_token_1, config.dingtalk_secret_1],
    [config.dingtalk_token_2, config.dingtalk_secret_2],
  ] as const;
  return Promise.all(
    robots.map(async ([token, secret], index) => {
      try {
        const response = await fetchJson<{ errcode?: number; errmsg?: string }>(
          signedUrl(token, secret),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ msgtype: "text", text: { content } }),
            timeoutMs: 10000,
            retries: 1,
          },
        );
        const ok = response.errcode === 0;
        return {
          robotIndex: index + 1,
          ok,
          response,
          error: ok ? undefined : response.errmsg ?? "钉钉返回未知错误",
        };
      } catch (error) {
        return {
          robotIndex: index + 1,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
}

