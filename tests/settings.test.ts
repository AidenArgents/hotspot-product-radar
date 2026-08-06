import assert from "node:assert/strict";
import test from "node:test";
import { applySettingsUpdate, publicSettings } from "../f/radar/settings.ts";
import type { RadarConfig } from "../f/radar/types.ts";

function fixture(): RadarConfig {
  return {
    admin_password: "admin-secret",
    gemini_api_key: "gemini-secret-value",
    tavily_api_key: "tavily-secret-value",
    spreadsheet_id: "sheet-id",
    google_service_account_email: "radar@example.test",
    google_private_key: "private-key-value",
    google_sheet_name: "工作表1",
    dingtalk_token_1: "token-one",
    dingtalk_secret_1: "secret-one",
    dingtalk_token_2: "token-two",
    dingtalk_secret_2: "secret-two",
    database_file: "data/radar.sqlite",
    server_host: "0.0.0.0",
    server_port: 3210,
    dashboard_url: "http://localhost:3210",
    https_proxy: "http://127.0.0.1:7897",
    schedule_enabled: true,
    schedule_hour: 9,
    schedule_minute: 10,
    gemini_model: "gemini-2.5-flash",
    country_concurrency: 3,
    site_concurrency: 4,
    request_timeout_ms: 15000,
    gemini_timeout_ms: 120000,
    gemini_min_interval_ms: 3200,
    default_target_region: "全部",
    default_time_range: "未来3个月",
    default_manual_data_lines: "全部",
    default_schedule_data_lines: "媒体+网页",
  };
}

test("页面设置响应只返回密钥状态，不返回密钥原值", () => {
  const result = publicSettings(fixture(), { localRequest: false });
  const text = JSON.stringify(result);
  assert.equal(result.secret_status.gemini_api_key, true);
  assert.equal(result.admin_password_configured, true);
  assert.equal(result.local_request, false);
  assert.doesNotMatch(text, /gemini-secret-value|private-key-value|admin-secret/);
});

test("定时、默认线路和性能设置可即时更新，空密钥输入保留原值", () => {
  const current = fixture();
  const result = applySettingsUpdate(current, {
    values: {
      schedule_enabled: false,
      schedule_hour: 18,
      schedule_minute: 35,
      default_target_region: "拉美",
      default_schedule_data_lines: "全部",
      country_concurrency: 5,
    },
    secret_values: { gemini_api_key: "" },
  });

  assert.equal(result.next.schedule_enabled, false);
  assert.equal(result.next.schedule_hour, 18);
  assert.equal(result.next.schedule_minute, 35);
  assert.equal(result.next.default_target_region, "拉美");
  assert.equal(result.next.country_concurrency, 5);
  assert.equal(result.next.gemini_api_key, current.gemini_api_key);
  assert.equal(result.restart_required, false);
});

test("密钥可替换或明确清除，端口变化要求重启", () => {
  const result = applySettingsUpdate(fixture(), {
    values: { server_port: 4321 },
    secret_values: { gemini_api_key: "new-gemini-key" },
    clear_secrets: ["dingtalk_secret_2"],
    new_admin_password: "new-admin-password",
  });

  assert.equal(result.next.gemini_api_key, "new-gemini-key");
  assert.equal(result.next.dingtalk_secret_2, "");
  assert.equal(result.next.admin_password, "new-admin-password");
  assert.equal(result.restart_required, true);
});

test("页面设置拒绝越界时间和过短管理员密码", () => {
  assert.throws(
    () => applySettingsUpdate(fixture(), { values: { schedule_hour: 24 } }),
    /0–23/,
  );
  assert.throws(
    () => applySettingsUpdate(fixture(), { new_admin_password: "short" }),
    /至少需要 8 个字符/,
  );
});
