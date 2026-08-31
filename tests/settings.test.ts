import assert from "node:assert/strict";
import test from "node:test";
import { applySettingsUpdate, publicSettings } from "../f/radar/settings.ts";
import type { RadarConfig } from "../f/radar/types.ts";

function fixture(): RadarConfig {
  return {
    admin_password: "admin-secret",
    gemini_api_key: "gemini-secret-value",
    gemini_api_key_2: "gemini-secret-value-two",
    tavily_api_key: "tavily-secret-value",
    search_engine: "tavily",
    google_search_api_key: "google-search-key",
    google_search_cx_a: "cx-aaa",
    google_search_cx_b: "cx-bbb",
    spreadsheet_id: "sheet-id",
    google_service_account_email: "radar@example.test",
    google_private_key: "private-key-value",
    google_sheet_name: "产品情报",
    operations_google_sheet_name: "运营情报",
    product_report_url: "https://docs.google.test/product",
    operations_report_url: "https://docs.google.test/operations",
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
    operations_schedule_enabled: true,
    operations_schedule_hour: 9,
    operations_schedule_minute: 30,
    enabled_countries: ["越南", "泰国", "印尼", "菲律宾", "马来西亚", "新加坡", "巴西", "墨西哥"],
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
    default_operations_target_region: "全部",
    default_operations_time_range: "近3天",
  };
}

test("页面设置响应只返回密钥状态，不返回密钥原值", () => {
  const result = publicSettings(fixture(), { localRequest: false });
  const text = JSON.stringify(result);
  assert.equal(result.secret_status.gemini_api_key, true);
  assert.equal(result.secret_status.gemini_api_key_2, true);
  assert.equal(result.admin_password_configured, true);
  assert.equal(result.local_request, false);
  assert.doesNotMatch(text, /gemini-secret-value|gemini-secret-value-two|private-key-value|admin-secret/);
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
      operations_google_sheet_name: "运营日报",
      operations_schedule_hour: 10,
      enabled_countries: ["越南", "泰国", "巴西", "墨西哥"],
    },
    secret_values: { gemini_api_key: "" },
  });

  assert.equal(result.next.schedule_enabled, false);
  assert.equal(result.next.schedule_hour, 18);
  assert.equal(result.next.schedule_minute, 35);
  assert.equal(result.next.default_target_region, "拉美");
  assert.equal(result.next.country_concurrency, 5);
  assert.equal(result.next.operations_google_sheet_name, "运营日报");
  assert.equal(result.next.operations_schedule_hour, 10);
  assert.deepEqual(result.next.enabled_countries, ["越南", "泰国", "巴西", "墨西哥"]);
  assert.equal(result.next.gemini_api_key, current.gemini_api_key);
  assert.equal(result.restart_required, false);
});

test("密钥可替换或明确清除，端口变化要求重启", () => {
  const result = applySettingsUpdate(fixture(), {
    values: { server_port: 4321 },
    secret_values: { gemini_api_key: "new-gemini-key", gemini_api_key_2: "new-gemini-key-two" },
    clear_secrets: ["dingtalk_secret_2"],
    new_admin_password: "new-admin-password",
  });

  assert.equal(result.next.gemini_api_key, "new-gemini-key");
  assert.equal(result.next.gemini_api_key_2, "new-gemini-key-two");
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
  assert.throws(
    () => applySettingsUpdate(fixture(), { values: { operations_google_sheet_name: "产品情报" } }),
    /必须使用不同的 Google Sheet 名称/,
  );
  assert.throws(
    () => applySettingsUpdate(fixture(), { values: { enabled_countries: [] } }),
    /至少需要启用一个国家/,
  );
  assert.throws(
    () => applySettingsUpdate(fixture(), { values: { enabled_countries: ["火星"] } }),
    /未知国家/,
  );
});
