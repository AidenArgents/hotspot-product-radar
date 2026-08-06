import https from "node:https";

export interface RequestOptions extends RequestInit {
  timeoutMs: number;
  retries?: number;
  retryDelayMs?: number;
}

function fetchTextViaHttps(url: string, options: RequestOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    new Headers(options.headers).forEach((value, key) => { headers[key] = value; });
    const request = https.request(url, {
      method: options.method ?? "GET",
      headers,
      family: 4,
      agent: false,
      timeout: options.timeoutMs,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          reject(new Error(`HTTP ${status}: ${text.slice(0, 500)}`));
        } else {
          resolve(text);
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error("HTTPS request timed out")));
    request.on("error", reject);
    if (typeof options.body === "string" || options.body instanceof Uint8Array) {
      request.write(options.body);
    } else if (options.body != null) {
      request.destroy(new Error("HTTPS fallback only supports string or byte request bodies"));
      return;
    }
    request.end();
  });
}

export async function fetchText(
  url: string,
  options: RequestOptions,
): Promise<string> {
  const retries = options.retries ?? 1;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
      }
      return text;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await new Promise((resolve) =>
          setTimeout(resolve, (options.retryDelayMs ?? 750) * (attempt + 1)),
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }
  const causeCode = lastError instanceof Error
    ? (lastError.cause as { code?: string } | undefined)?.code
    : undefined;
  if (url.startsWith("https://") && ["UND_ERR_SOCKET", "ECONNRESET", "ETIMEDOUT"].includes(causeCode ?? "")) {
    return fetchTextViaHttps(url, options);
  }
  if (lastError instanceof Error) {
    const cause = lastError.cause as { code?: string; message?: string } | undefined;
    const detail = [cause?.code, cause?.message].filter(Boolean).join(": ");
    throw new Error(detail ? `${lastError.message} (${detail})` : lastError.message, {
      cause: lastError,
    });
  }
  throw lastError;
}

export async function fetchJson<T>(
  url: string,
  options: RequestOptions,
): Promise<T> {
  return JSON.parse(await fetchText(url, options)) as T;
}
