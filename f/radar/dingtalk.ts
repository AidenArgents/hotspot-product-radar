import crypto from "node:crypto";
import type { BranchResult, OperationIntelligence, RadarConfig, RadarEvent, RuntimeContext } from "./types.ts";
import { fetchJson } from "./http.ts";

const LINE_TITLES = {
  假日: "假日API",
  媒体: "媒体搜索",
  网页: "网页抓取",
  运营: "运营情报",
} as const;

export function buildDingTalkMessage(
  config: RadarConfig,
  context: RuntimeContext,
  branch: BranchResult,
  events: RadarEvent[],
): string {
  const lineTitle = branch.line === "媒体"
    ? "Tavily媒体"
    : LINE_TITLES[branch.line];
  let message = `🎯 热点选品雷达v7·${lineTitle} · ${context.current_date}\n`;
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
  const reportUrl = config.product_report_url
    || `https://docs.google.com/spreadsheets/d/${config.spreadsheet_id}/edit?gid=0`;
  message += "────────────────────────────\n";
  message += `📋 完整报告→ ${reportUrl}`;
  return message.slice(0, 19000);
}

export function buildOperationsDingTalkMessage(
  config: RadarConfig,
  currentDate: string,
  targetRegion: string,
  items: OperationIntelligence[],
): string {
  let message = `🧭 运营情报日报 · ${currentDate}\n`;
  message += `📍 ${targetRegion} | ${items.length}条新增经营影响\n`;
  message += `════════════════════════════\n\n`;
  items.slice().sort((a, b) => b.impact_score - a.impact_score).slice(0, 12)
    .forEach((item, index) => {
      const marker = item.direction === "利空" ? "⚠️" : item.direction === "利好" ? "📈" : "🔎";
      const scope = [item.country, item.platform, item.category].filter(Boolean).join("·");
      message += `${marker} ${index + 1}. 【${scope}】${item.title}\n`;
      message += `   ${item.direction} | 影响${item.impact_score}分 | ${item.urgency}\n`;
      if (item.verification_status) message += `   🔐 ${item.verification_status} | ${item.evidence_count ?? 1}个证据来源\n`;
      message += `   💼 ${item.business_impact.slice(0, 130)}\n`;
      if (item.recommended_actions?.length) {
        message += `   ✅ ${item.recommended_actions.slice(0, 2).join("；")}\n`;
      }
      message += `   来源：${item.source_name}${item.source_url ? ` ${item.source_url}` : ""}\n\n`;
    });
  message += "────────────────────────────\n";
  const reportUrl = config.operations_report_url
    || `https://docs.google.com/spreadsheets/d/${config.spreadsheet_id}/edit`;
  message += `📋 完整情报→ ${reportUrl}`;
  return message.slice(0, 19000);
}

function signedUrl(token: string, secret: string): string {
  const baseUrl = `https://oapi.dingtalk.com/robot/send?access_token=${encodeURIComponent(token)}`;
  if (!secret?.trim()) return baseUrl;
  const timestamp = Date.now();
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}\n${secret}`)
    .digest("base64");
  return (
    baseUrl +
    `&timestamp=${timestamp}&sign=${encodeURIComponent(signature)}`
  );
}

export async function sendDingTalk(
  config: RadarConfig,
  content: string,
  robotIndices?: number[],
): Promise<Array<{ robotIndex: number; ok: boolean; response?: unknown; error?: string }>> {
  if (!content || content.length < 50) return [];
  const robots = [
    [config.dingtalk_token_1, config.dingtalk_secret_1],
    [config.dingtalk_token_2, config.dingtalk_secret_2],
  ] as const;
  return Promise.all(
    robots.flatMap(([token, secret], index) => {
      if (robotIndices && !robotIndices.includes(index + 1)) return [];
      if (!token?.trim() || /^YOUR_/.test(token.trim())) return [];
      return [(async () => {
      try {
        const response = await fetchJson<{ errcode?: number; errmsg?: string }>(
          signedUrl(token, secret),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ msgtype: "text", text: { content } }),
            timeoutMs: 10000,
            retries: 0,
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
      })()];
    }),
  );
}
