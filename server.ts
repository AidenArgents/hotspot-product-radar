import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { loadConfig, PROJECT_ROOT } from "./config.ts";
import { queryEvents } from "./f/radar/query_events.ts";
import { main as queryRuns } from "./f/radar/query_runs.ts";
import { main as queryRunDetail } from "./f/radar/query_run_detail.ts";
import { runScan } from "./f/radar/run_scan.ts";
import type { DataLines, ScanInput, SourceLine, TargetRegion, TimeRange } from "./f/radar/types.ts";

type Job = {
  id: string;
  status: "running" | "success" | "failed";
  started_at: string;
  finished_at?: string;
  result?: unknown;
  error?: string;
};

const config = loadConfig();
const jobs = new Map<string, Job>();
const dashboardDist = path.join(PROJECT_ROOT, "f", "radar", "dashboard__raw_app", "dist");
let activeScan: Promise<unknown> | null = null;
let lastScheduledDate = "";

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
  const job: Job = { id, status: "running", started_at: new Date().toISOString() };
  jobs.set(id, job);
  activeScan = runScan(config, input, true, true)
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

async function api(request: IncomingMessage, response: ServerResponse, url: URL) {
  if (request.method === "GET" && url.pathname === "/api/health") {
    return json(response, 200, {
      ok: true,
      service: "热点选品雷达",
      active_scan: Boolean(activeScan),
      schedule: config.schedule_enabled
        ? `${String(config.schedule_hour).padStart(2, "0")}:${String(config.schedule_minute).padStart(2, "0")}`
        : "disabled",
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
      limit: Number(queryString(url, "limit") || 100),
      offset: Number(queryString(url, "offset") || 0),
    });
    return json(response, 200, result);
  }
  if (request.method === "GET" && url.pathname === "/api/runs") {
    return json(response, 200, await queryRuns(config, Number(queryString(url, "limit") || 30)));
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
  if (!config.schedule_enabled || activeScan) return;
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  if (now.getHours() !== config.schedule_hour || now.getMinutes() !== config.schedule_minute) return;
  if (lastScheduledDate === date) return;
  lastScheduledDate = date;
  startJob({
    target_region: config.default_target_region,
    time_range: config.default_time_range,
    data_lines: config.default_schedule_data_lines,
    trigger_type: "schedule",
  });
}

server.listen(config.server_port, config.server_host, () => {
  console.log(`热点选品雷达已启动：${config.dashboard_url}`);
  console.log(`本机访问：http://localhost:${config.server_port}`);
  console.log(`每日定时：${String(config.schedule_hour).padStart(2, "0")}:${String(config.schedule_minute).padStart(2, "0")}`);
});
setInterval(scheduledTick, 30_000).unref();
scheduledTick();
