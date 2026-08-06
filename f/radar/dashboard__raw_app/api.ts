type Arguments = Record<string, unknown>;
type Runnable = (args: Arguments) => Promise<any>;
type Backend = Record<string, Runnable>;

async function responseJson(response: Response) {
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `请求失败：${response.status}`);
  return value;
}

async function call(runnable: string, args: Arguments) {
  if (runnable === "query_events" || runnable === "query_runs") {
    const endpoint = runnable === "query_events" ? "/api/events" : "/api/runs";
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(args)) {
      if (value !== undefined && value !== null) query.set(key, String(value));
    }
    return responseJson(await fetch(`${endpoint}?${query}`));
  }
  if (runnable === "query_run_detail") {
    return responseJson(await fetch(`/api/runs/${encodeURIComponent(String(args.run_id ?? ""))}`));
  }
  throw new Error(`未知接口：${runnable}`);
}

export const backend = new Proxy({} as Backend, {
  get: (_, runnable: string) => (args: Arguments) => call(runnable, args),
});

export const backendAsync = new Proxy({} as Backend, {
  get: (_, runnable: string) => async (args: Arguments) => {
    if (runnable !== "run_scan") throw new Error(`未知异步接口：${runnable}`);
    const result = await responseJson(await fetch("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    }));
    return result.job_id as string;
  },
});

export async function waitJob(jobId: string) {
  while (true) {
    const job = await responseJson(await fetch(`/api/jobs/${encodeURIComponent(jobId)}`));
    if (job.status === "success") return job.result;
    if (job.status === "failed") throw new Error(job.error ?? "扫描失败");
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
