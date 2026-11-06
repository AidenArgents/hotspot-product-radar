type Arguments = Record<string, unknown>;
type Runnable = (args: Arguments) => Promise<any>;
type Backend = Record<string, Runnable>;

async function responseJson(response: Response) {
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `请求失败：${response.status}`);
  return value;
}

async function call(runnable: string, args: Arguments) {
  if (["query_events", "query_runs", "query_operations", "query_operation_runs"].includes(runnable)) {
    const endpoint = runnable === "query_events" ? "/api/events"
      : runnable === "query_runs" ? "/api/runs"
      : runnable === "query_operations" ? "/api/operations"
      : "/api/operations/runs";
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(args)) {
      if (value !== undefined && value !== null) query.set(key, String(value));
    }
    return responseJson(await fetch(`${endpoint}?${query}`));
  }
  if (runnable === "query_source_health") {
    return responseJson(await fetch("/api/source-health"));
  }
  if (runnable === "query_run_detail") {
    return responseJson(await fetch(`/api/runs/${encodeURIComponent(String(args.run_id ?? ""))}`));
  }
  if (runnable === "query_operation_run_detail") {
    return responseJson(await fetch(`/api/operations/runs/${encodeURIComponent(String(args.run_id ?? ""))}`));
  }
  if (runnable === "get_settings") {
    return responseJson(await fetch("/api/settings"));
  }
  if (runnable === "calendar_state") return responseJson(await fetch("/api/calendar"));
  if (runnable === "calendar_sync" || runnable === "calendar_action") {
    const { auth_password, ...payload } = args;
    return responseJson(await fetch(runnable === "calendar_sync" ? "/api/calendar/sync" : "/api/calendar/action", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Radar-Admin-Password": String(auth_password ?? "") }, body: JSON.stringify(payload),
    }));
  }
  if (runnable === "save_settings") {
    const { auth_password, ...payload } = args;
    return responseJson(await fetch("/api/settings", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Radar-Admin-Password": String(auth_password ?? ""),
      },
      body: JSON.stringify(payload),
    }));
  }
  throw new Error(`未知接口：${runnable}`);
}

export const backend = new Proxy({} as Backend, {
  get: (_, runnable: string) => (args: Arguments) => call(runnable, args),
});

export const backendAsync = new Proxy({} as Backend, {
  get: (_, runnable: string) => async (args: Arguments) => {
    if (runnable !== "run_scan" && runnable !== "run_operations_scan") throw new Error(`未知异步接口：${runnable}`);
    const result = await responseJson(await fetch(runnable === "run_scan" ? "/api/scan" : "/api/operations/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    }));
    return result.job_id as string;
  },
});

export async function waitJob(jobId: string, onProgress?: (msg: string) => void) {
  while (true) {
    const job = await responseJson(await fetch(`/api/jobs/${encodeURIComponent(jobId)}`));
    if (job.status === "success") return job.result;
    if (job.status === "failed") throw new Error(job.error ?? "扫描失败");
    if (job.progress && onProgress) onProgress(job.progress);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
