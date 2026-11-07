import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fetchText } from "./http.ts";
import type { RadarConfig } from "./types.ts";

export const DEFAULT_CALENDAR_URL = "https://aidenargents.github.io/hotspot-product-radar/%E7%BE%8E%E5%9B%BD%E7%94%B5%E5%95%86%E5%A4%87%E8%B4%A7%E6%97%A5%E5%8E%86.html";
export type CalendarNode = {
  id: string; event_id: string; event_name: string; event_date: string; estimated: boolean;
  route_id: string; route_name: string; stage: "start" | "finish" | "depart"; stage_name: string; due_date: string;
};
export type CalendarFeed = {
  schema_version: 1; title: string; action_timezone: "Asia/Shanghai"; generated_at: string;
  event_count: number; route_count: number; nodes: CalendarNode[];
};
export function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function chinaDate(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
export function calendarUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("备货看板必须使用不含账号密码的HTTPS链接");
  return url.href;
}
export function parseCalendarFeed(html: string): CalendarFeed {
  const tags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .filter((match) => /\bid\s*=\s*["']calendar-reminder-data["']/i.test(match[1]));
  if (tags.length !== 1) throw new Error("线上看板缺少唯一的备货提醒数据，请保存并发布已接入的HTML版本");
  let feed: CalendarFeed;
  try { feed = JSON.parse(tags[0][2]); } catch { throw new Error("线上备货提醒数据不是完整JSON，保留上次成功方案"); }
  if (!feed || typeof feed !== "object" || feed.schema_version !== 1 || feed.action_timezone !== "Asia/Shanghai" || !Array.isArray(feed.nodes)
    || !Number.isFinite(Date.parse(feed.generated_at)) || feed.nodes.length > 10_000) throw new Error("线上备货提醒数据版本或结构不正确");
  const ids = new Set<string>();
  for (const node of feed.nodes) {
    if (!node || typeof node !== "object" || ![node.id, node.event_id, node.event_name, node.route_id, node.route_name, node.stage_name].every((value) => typeof value === "string" && value.length > 0 && value.length <= 300)
      || !["start", "finish", "depart"].includes(node.stage) || !validDate(node.due_date) || !validDate(node.event_date)
      || node.due_date > node.event_date || typeof node.estimated !== "boolean" || ids.has(node.id)) throw new Error("线上备货节点包含重复ID、无效日期或缺失字段");
    ids.add(node.id);
  }
  return feed;
}
const execFileAsync = promisify(execFile);
export async function fetchCalendarHtml(config: RadarConfig): Promise<string> {
  const url = new URL(calendarUrl(config.calendar_url || DEFAULT_CALENDAR_URL));
  url.searchParams.set("_radar_sync", String(Date.now()));
  // 公开看板优先直连；即使搜索代理暂时没启动，也能正常同步已发布的计划。
  try { return await fetchText(url.href, { timeoutMs: 15_000, retries: 0, headers: { "Cache-Control": "no-cache" } }); }
  catch (error) { if (!config.https_proxy) throw error; }
  try {
    const { stdout } = await execFileAsync("curl.exe", ["--silent", "--show-error", "--fail-with-body", "--location",
      "--connect-timeout", "15", "--max-time", "30", "--proxy", config.https_proxy, url.href],
    { timeout: 35_000, maxBuffer: 3 * 1024 * 1024, windowsHide: true });
    return stdout;
  } catch (error) {
    const detail = (error as { stderr?: string }).stderr || "看板请求失败";
    throw new Error(`备货看板同步失败：${detail.replaceAll(config.https_proxy, "[代理]").slice(0, 300)}`);
  }
}
