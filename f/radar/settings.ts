import type { RadarConfig } from "./types.ts";

export const SECRET_CONFIG_FIELDS = [
  "gemini_api_key",
  "tavily_api_key",
  "google_private_key",
  "dingtalk_token_1",
  "dingtalk_secret_1",
  "dingtalk_token_2",
  "dingtalk_secret_2",
  "https_proxy",
] as const;

export const LIVE_CONFIG_FIELDS = [
  "admin_password",
  "gemini_api_key",
  "tavily_api_key",
  "spreadsheet_id",
  "google_service_account_email",
  "google_private_key",
  "google_sheet_name",
  "dingtalk_token_1",
  "dingtalk_secret_1",
  "dingtalk_token_2",
  "dingtalk_secret_2",
  "dashboard_url",
  "https_proxy",
  "schedule_enabled",
  "schedule_hour",
  "schedule_minute",
  "gemini_model",
  "country_concurrency",
  "site_concurrency",
  "request_timeout_ms",
  "gemini_timeout_ms",
  "gemini_min_interval_ms",
  "default_target_region",
  "default_time_range",
  "default_manual_data_lines",
  "default_schedule_data_lines",
] as const;

type SecretConfigField = (typeof SECRET_CONFIG_FIELDS)[number];

const targetRegions = new Set(["全部", "东南亚", "拉美"]);
const timeRanges = new Set(["今天", "近3天", "本周", "本月", "未来3个月"]);
const dataLines = new Set(["全部", "媒体+网页", "仅网页", "仅媒体", "仅假日", "假日+网页", "假日+媒体"]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 格式不正确`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string, options: { required?: boolean; max?: number } = {}) {
  if (typeof value !== "string") throw new Error(`${label} 必须是文本`);
  const result = value.trim();
  if (options.required && !result) throw new Error(`${label} 不能为空`);
  if (result.length > (options.max ?? 4096)) throw new Error(`${label} 内容过长`);
  return result;
}

function integerValue(value: unknown, label: string, min: number, max: number) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < min || result > max) {
    throw new Error(`${label} 必须是 ${min}–${max} 之间的整数`);
  }
  return result;
}

function enumValue(value: unknown, label: string, allowed: Set<string>) {
  const result = stringValue(value, label, { required: true, max: 50 });
  if (!allowed.has(result)) throw new Error(`${label} 选项无效`);
  return result;
}

function has(object: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function configured(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return false;
  return !/^YOUR_[A-Z0-9_]+$/.test(value.trim());
}

export function publicSettings(config: RadarConfig, options: { localRequest: boolean }) {
  return {
    values: {
      schedule_enabled: config.schedule_enabled,
      schedule_hour: config.schedule_hour,
      schedule_minute: config.schedule_minute,
      default_target_region: config.default_target_region,
      default_time_range: config.default_time_range,
      default_manual_data_lines: config.default_manual_data_lines,
      default_schedule_data_lines: config.default_schedule_data_lines,
      gemini_model: config.gemini_model,
      country_concurrency: config.country_concurrency,
      site_concurrency: config.site_concurrency,
      request_timeout_ms: config.request_timeout_ms,
      gemini_timeout_ms: config.gemini_timeout_ms,
      gemini_min_interval_ms: config.gemini_min_interval_ms,
      spreadsheet_id: config.spreadsheet_id,
      google_service_account_email: config.google_service_account_email,
      google_sheet_name: config.google_sheet_name,
      dashboard_url: config.dashboard_url,
      server_host: config.server_host,
      server_port: config.server_port,
      database_file: config.database_file,
    },
    secret_status: Object.fromEntries(
      SECRET_CONFIG_FIELDS.map((field) => [field, configured(config[field])]),
    ) as Record<SecretConfigField, boolean>,
    admin_password_configured: configured(config.admin_password),
    local_request: options.localRequest,
  };
}

export function applySettingsUpdate(current: RadarConfig, payloadValue: unknown) {
  const payload = record(payloadValue, "设置请求");
  const values = record(payload.values ?? {}, "普通设置");
  const secrets = record(payload.secret_values ?? {}, "密钥设置");
  const next: RadarConfig = { ...current };
  const changed = new Set<string>();

  const setValue = <K extends keyof RadarConfig>(field: K, value: RadarConfig[K]) => {
    if (next[field] !== value) {
      next[field] = value;
      changed.add(String(field));
    }
  };

  if (has(values, "schedule_enabled")) {
    if (typeof values.schedule_enabled !== "boolean") throw new Error("定时开关必须是布尔值");
    setValue("schedule_enabled", values.schedule_enabled);
  }
  if (has(values, "schedule_hour")) setValue("schedule_hour", integerValue(values.schedule_hour, "定时小时", 0, 23));
  if (has(values, "schedule_minute")) setValue("schedule_minute", integerValue(values.schedule_minute, "定时分钟", 0, 59));
  if (has(values, "default_target_region")) setValue("default_target_region", enumValue(values.default_target_region, "默认区域", targetRegions));
  if (has(values, "default_time_range")) setValue("default_time_range", enumValue(values.default_time_range, "默认时间范围", timeRanges));
  if (has(values, "default_manual_data_lines")) setValue("default_manual_data_lines", enumValue(values.default_manual_data_lines, "手动扫描线路", dataLines));
  if (has(values, "default_schedule_data_lines")) setValue("default_schedule_data_lines", enumValue(values.default_schedule_data_lines, "定时扫描线路", dataLines));
  if (has(values, "gemini_model")) setValue("gemini_model", stringValue(values.gemini_model, "Gemini 模型", { required: true, max: 100 }));
  if (has(values, "country_concurrency")) setValue("country_concurrency", integerValue(values.country_concurrency, "国家并发数", 1, 16));
  if (has(values, "site_concurrency")) setValue("site_concurrency", integerValue(values.site_concurrency, "站点并发数", 1, 32));
  if (has(values, "request_timeout_ms")) setValue("request_timeout_ms", integerValue(values.request_timeout_ms, "普通请求超时", 1000, 300000));
  if (has(values, "gemini_timeout_ms")) setValue("gemini_timeout_ms", integerValue(values.gemini_timeout_ms, "Gemini 超时", 10000, 600000));
  if (has(values, "gemini_min_interval_ms")) setValue("gemini_min_interval_ms", integerValue(values.gemini_min_interval_ms, "Gemini 最小间隔", 0, 60000));
  if (has(values, "spreadsheet_id")) setValue("spreadsheet_id", stringValue(values.spreadsheet_id, "Google 表格 ID", { max: 512 }));
  if (has(values, "google_service_account_email")) setValue("google_service_account_email", stringValue(values.google_service_account_email, "Google 服务账号邮箱", { max: 320 }));
  if (has(values, "google_sheet_name")) setValue("google_sheet_name", stringValue(values.google_sheet_name, "Google 工作表名称", { required: true, max: 200 }));
  if (has(values, "dashboard_url")) setValue("dashboard_url", stringValue(values.dashboard_url, "看板外部地址", { max: 2048 }));
  if (has(values, "server_host")) setValue("server_host", stringValue(values.server_host, "监听地址", { required: true, max: 255 }));
  if (has(values, "server_port")) setValue("server_port", integerValue(values.server_port, "服务端口", 1, 65535));

  for (const field of SECRET_CONFIG_FIELDS) {
    if (!has(secrets, field)) continue;
    const maximum = field === "google_private_key" ? 20000 : 4096;
    const value = stringValue(secrets[field], field, { max: maximum });
    if (value) setValue(field, value);
  }

  const clearSecrets = payload.clear_secrets ?? [];
  if (!Array.isArray(clearSecrets) || clearSecrets.some((field) => typeof field !== "string")) {
    throw new Error("清除密钥列表格式不正确");
  }
  for (const field of clearSecrets) {
    if (!SECRET_CONFIG_FIELDS.includes(field as SecretConfigField)) throw new Error(`不能清除未知密钥：${field}`);
    setValue(field as SecretConfigField, "");
  }

  if (has(payload, "new_admin_password")) {
    const password = stringValue(payload.new_admin_password, "新管理员密码", { max: 256 });
    if (password && password.length < 8) throw new Error("新管理员密码至少需要 8 个字符");
    if (password) setValue("admin_password", password);
  }

  return {
    next,
    changed_fields: [...changed],
    restart_required: changed.has("server_host") || changed.has("server_port"),
  };
}
