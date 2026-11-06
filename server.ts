import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { loadConfig, PROJECT_ROOT, readConfig, writeConfig } from "./config.ts";
import { main as initDatabase } from "./f/radar/init_database.ts";
import { queryEvents } from "./f/radar/query_events.ts";
import { main as queryRuns } from "./f/radar/query_runs.ts";
import { main as queryRunDetail } from "./f/radar/query_run_detail.ts";
import { main as querySourceHealth } from "./f/radar/query_source_health.ts";
import { queryOperations } from "./f/radar/query_operations.ts";
import { queryOperationRuns } from "./f/radar/query_operation_runs.ts";
import { queryOperationRunDetail } from "./f/radar/query_operation_run_detail.ts";
import { runScan } from "./f/radar/run_scan.ts";
import { runOperationsScan } from "./f/radar/run_operations.ts";
import { CalendarReminders } from "./f/radar/calendar_reminders.ts";
import { connectDatabase } from "./f/radar/database.ts";
import { applySettingsUpdate, LIVE_CONFIG_FIELDS, publicSettings } from "./f/radar/settings.ts";
import type { DataLines, OperationScanInput, ScanInput, SourceLine, TargetRegion, TimeRange } from "./f/radar/types.ts";

type Job = {
  id: string;
  status: "running" | "success" | "failed";
  started_at: string;
  finished_at?: string;
  result?: unknown;
  error?: string;
  progress?: string;
  module?: "product" | "operations";
};

const config = loadConfig();
await initDatabase(config);
const calendar = new CalendarReminders(connectDatabase(config), config);
const jobs = new Map<string, Job>();
const dashboardDist = path.join(PROJECT_ROOT, "f", "radar", "dashboard__raw_app", "dist");
let activeScan: Promise<unknown> | null = null;
let lastScheduledDate = "";
let lastOperationsScheduledDate = "";

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of request) {
    text += String(chunk);
    if (text.length > 1_000_000) throw new Error("请求内容过大");
  }
  return text ? JSON.parse(text) : {};
}

function startJob(input: ScanInput) {
  if (activeScan) throw new Error("已有扫描正在运行，请等待完成");
  const id = crypto.randomUUID();
  const job: Job = { id, module: "product", status: "running", started_at: new Date().toISOString(), progress: "初始化中..." };
  jobs.set(id, job);
  activeScan = runScan(config, input, true, true, (msg) => { job.progress = msg; })
    .then((result) => {
      Object.assign(job, { status: "success", result, finished_at: new Date().toISOString() });
      return result;
    })
    .catch((error) => {
      Object.assign(job, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        finished_at: new Date().toISOString(),
      });
    })
    .finally(() => { activeScan = null; });
  return job;
}

function startOperationsJob(input: OperationScanInput) {
  if (activeScan) throw new Error("已有扫描正在运行，请等待完成");
  const id = crypto.randomUUID();
  const job: Job = { id, module: "operations", status: "running", started_at: new Date().toISOString(), progress: "初始化运营情报..." };
  jobs.set(id, job);
  activeScan = runOperationsScan(config, input, true, true, (msg) => { job.progress = msg; })
    .then((result) => {
      Object.assign(job, { status: "success", result, finished_at: new Date().toISOString() });
      return result;
    })
    .catch((error) => {
      Object.assign(job, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        finished_at: new Date().toISOString(),
      });
    })
    .finally(() => { activeScan = null; });
  return job;
}

function queryString(url: URL, key: string) {
  return url.searchParams.get(key) ?? "";
}

function isLocalRequest(request: IncomingMessage) {
  const address = request.socket.remoteAddress ?? "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function sameSecret(actual: string, supplied: string) {
  const actualBuffer = Buffer.from(actual, "utf8");
  const suppliedBuffer = Buffer.from(supplied, "utf8");
  return actualBuffer.length === suppliedBuffer.length && timingSafeEqual(actualBuffer, suppliedBuffer);
}

function canSaveSettings(request: IncomingMessage) {
  const actual = config.admin_password?.trim() ?? "";
  if (!actual) return isLocalRequest(request);
  const header = request.headers["x-radar-admin-password"];
  const supplied = Array.isArray(header) ? header[0] ?? "" : header ?? "";
  return sameSecret(actual, supplied);
}

async function api(request: IncomingMessage, response: ServerResponse, url: URL) {
  if (request.method === "GET" && url.pathname === "/api/health") {
    return json(response, 200, {
      ok: true,
      service: "热点选品雷达",
      active_scan: Boolean(activeScan),
      calendar_enabled: Boolean(config.calendar_enabled),
      calendar_schedule: `${String(config.calendar_hour ?? 9).padStart(2, "0")}:${String(config.calendar_minute ?? 0).padStart(2, "0")}`,
      schedule: config.schedule_enabled
        ? `${String(config.schedule_hour).padStart(2, "0")}:${String(config.schedule_minute).padStart(2, "0")}`
        : "disabled",
      operations_schedule: config.operations_schedule_enabled
        ? `${String(config.operations_schedule_hour).padStart(2, "0")}:${String(config.operations_schedule_minute).padStart(2, "0")}`
        : "disabled",
    });
  }
  if (request.method === "GET" && url.pathname === "/api/calendar") return json(response, 200, calendar.state());
  if (request.method === "POST" && ["/api/calendar/sync", "/api/calendar/action"].includes(url.pathname)) {
    if (!canSaveSettings(request)) return json(response, 403, { error: "请填写正确的管理员密码" });
    if (url.pathname.endsWith("/sync")) return json(response, 200, await calendar.sync());
    const input = await body(request);
    calendar.action(String(input.id ?? ""), String(input.action ?? ""));
    return json(response, 200, calendar.state());
  }
  if (request.method === "GET" && url.pathname === "/api/settings") {
    return json(response, 200, publicSettings(readConfig(), { localRequest: isLocalRequest(request) }));
  }
  if (request.method === "PUT" && url.pathname === "/api/settings") {
    if (!canSaveSettings(request)) {
      return json(response, 403, {
        error: config.admin_password
          ? "管理员密码不正确"
          : "尚未设置管理员密码，只能在服务器本机修改设置",
      });
    }
    if (activeScan) return json(response, 409, { error: "扫描正在运行，完成后才能修改系统设置" });

    const input = await body(request);
    let update: ReturnType<typeof applySettingsUpdate>;
    try {
      update = applySettingsUpdate(readConfig(), input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json(response, 400, { error: message });
    }

    writeConfig(update.next);
    const loaded = loadConfig();
    Object.assign(
      config,
      Object.fromEntries(LIVE_CONFIG_FIELDS.map((field) => [field, loaded[field]])),
    );
    lastScheduledDate = "";
    lastOperationsScheduledDate = "";
    return json(response, 200, {
      ...publicSettings(readConfig(), { localRequest: isLocalRequest(request) }),
      changed_fields: update.changed_fields,
      restart_required: update.restart_required,
    });
  }
  if (request.method === "GET" && url.pathname === "/api/events") {
    const result = await queryEvents(config, {
      region: queryString(url, "region"),
      country: queryString(url, "country"),
      source_line: queryString(url, "source_line") as SourceLine | "",
      stage: queryString(url, "stage"),
      min_score: Number(queryString(url, "min_score") || 0),
      date_from: queryString(url, "date_from"),
      date_to: queryString(url, "date_to"),
      search: queryString(url, "search"),
      sort_by: (queryString(url, "sort_by") || "first_seen_at") as "first_seen_at" | "ecommerce_score",
      sort_order: (queryString(url, "sort_order") || "desc") as "asc" | "desc",
      limit: Number(queryString(url, "limit") || 100),
      offset: Number(queryString(url, "offset") || 0),
    });
    return json(response, 200, result);
  }
  if (request.method === "GET" && url.pathname === "/api/runs") {
    return json(response, 200, await queryRuns(config, Number(queryString(url, "limit") || 30)));
  }
  if (request.method === "GET" && url.pathname === "/api/source-health") {
    return json(response, 200, await querySourceHealth(config));
  }
  if (request.method === "GET" && url.pathname === "/api/operations") {
    return json(response, 200, await queryOperations(config, {
      region: queryString(url, "region"), country: queryString(url, "country"),
      category: queryString(url, "category"), direction: queryString(url, "direction"),
      urgency: queryString(url, "urgency"), min_score: Number(queryString(url, "min_score") || 0),
      date_from: queryString(url, "date_from"), search: queryString(url, "search"),
      sort_by: (queryString(url, "sort_by") || "first_seen_at") as "first_seen_at" | "impact_score" | "effective_date",
      sort_order: (queryString(url, "sort_order") || "desc") as "asc" | "desc",
      limit: Number(queryString(url, "limit") || 100), offset: Number(queryString(url, "offset") || 0),
    }));
  }
  if (request.method === "GET" && url.pathname === "/api/operations/runs") {
    return json(response, 200, await queryOperationRuns(config, Number(queryString(url, "limit") || 30)));
  }
  const operationDetailMatch = url.pathname.match(/^\/api\/operations\/runs\/([^/]+)$/);
  if (request.method === "GET" && operationDetailMatch) {
    return json(response, 200, await queryOperationRunDetail(config, decodeURIComponent(operationDetailMatch[1])));
  }
  const detailMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (request.method === "GET" && detailMatch) {
    return json(response, 200, await queryRunDetail(config, decodeURIComponent(detailMatch[1])));
  }
  if (request.method === "POST" && url.pathname === "/api/scan") {
    const input = await body(request);
    const job = startJob({
      target_region: String(input.target_region || config.default_target_region) as TargetRegion,
      time_range: String(input.time_range || config.default_time_range) as TimeRange,
      data_lines: String(input.data_lines || config.default_manual_data_lines) as DataLines,
      trigger_type: "manual",
    });
    return json(response, 202, { job_id: job.id });
  }
  if (request.method === "POST" && url.pathname === "/api/operations/scan") {
    const input = await body(request);
    const job = startOperationsJob({
      target_region: String(input.target_region || config.default_operations_target_region) as TargetRegion,
      time_range: String(input.time_range || config.default_operations_time_range) as TimeRange,
      trigger_type: "manual",
      force_refresh: Boolean(input.force_refresh),
    });
    return json(response, 202, { job_id: job.id });
  }
  const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (request.method === "GET" && jobMatch) {
    const job = jobs.get(decodeURIComponent(jobMatch[1]));
    return job ? json(response, 200, job) : json(response, 404, { error: "任务不存在" });
  }
  return json(response, 404, { error: "接口不存在" });
}

const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function staticFile(response: ServerResponse, url: URL) {
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  let file = path.resolve(dashboardDist, `.${pathname}`);
  if (!file.startsWith(dashboardDist)) return json(response, 403, { error: "禁止访问" });
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dashboardDist, "index.html");
  if (!fs.existsSync(file)) {
    return json(response, 503, { error: "看板尚未构建，请运行 npm run build:dashboard" });
  }
  response.writeHead(200, { "Content-Type": mimeTypes[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(response);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) await api(request, response, url);
    else staticFile(response, url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    json(response, message.includes("正在运行") ? 409 : 500, { error: message });
  }
});

function scheduledTick() {
  if (activeScan) return;
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  if (config.schedule_enabled
    && now.getHours() === config.schedule_hour && now.getMinutes() === config.schedule_minute
    && lastScheduledDate !== date) {
    lastScheduledDate = date;
    startJob({
      target_region: config.default_target_region,
      time_range: config.default_time_range,
      data_lines: config.default_schedule_data_lines,
      trigger_type: "schedule",
    });
    return;
  }
  if (config.operations_schedule_enabled
    && now.getHours() === config.operations_schedule_hour
    && now.getMinutes() === config.operations_schedule_minute
    && lastOperationsScheduledDate !== date) {
    lastOperationsScheduledDate = date;
    startOperationsJob({
      target_region: config.default_operations_target_region,
      time_range: config.default_operations_time_range,
      trigger_type: "schedule",
    });
  }
}

server.listen(config.server_port, config.server_host, () => {
  console.log(`热点选品雷达已启动：${config.dashboard_url}`);
  console.log(`本机访问：http://localhost:${config.server_port}`);
  console.log(
    `每日定时：${config.schedule_enabled
      ? `${String(config.schedule_hour).padStart(2, "0")}:${String(config.schedule_minute).padStart(2, "0")}`
      : "已关闭"}`,
  );
  console.log(
    `运营情报定时：${config.operations_schedule_enabled
      ? `${String(config.operations_schedule_hour).padStart(2, "0")}:${String(config.operations_schedule_minute).padStart(2, "0")}`
      : "已关闭"}`,
  );
});
setInterval(scheduledTick, 30_000).unref();
scheduledTick();
// 每30秒只检查是否到发送/失败重试时间，不定期抓取线上日历。
setInterval(() => { void calendar.tick().catch((error) => console.error("备货提醒任务失败", error instanceof Error ? error.message : String(error))); }, 30_000).unref();
void calendar.tick().catch((error) => console.error("备货提醒启动检查失败", error instanceof Error ? error.message : String(error)));
