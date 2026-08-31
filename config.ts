import fs from "node:fs";
import path from "node:path";
import type { RadarConfig } from "./f/radar/types.ts";
import { TARGET_COUNTRIES } from "./f/radar/lib.ts";

export const PROJECT_ROOT = import.meta.dirname;
export const CONFIG_FILE = path.join(PROJECT_ROOT, "config", "radar_config.local.json");

export function readConfig(): RadarConfig {
  if (!fs.existsSync(CONFIG_FILE)) {
    throw new Error(
      "缺少 config/radar_config.local.json，请先运行 初始化.bat，或复制 radar_config.example.json 后填写配置",
    );
  }
  return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as RadarConfig;
}

export function writeConfig(config: RadarConfig) {
  const temporaryFile = `${CONFIG_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryFile, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryFile, CONFIG_FILE);
}

export function loadConfig(): RadarConfig {
  const config = readConfig();
  return {
    ...config,
    admin_password: config.admin_password ?? "",
    search_engine: (config.search_engine === "tavily" || config.search_engine === "google") ? config.search_engine : "google",
    google_search_api_key: config.google_search_api_key ?? "",
    google_search_cx_a: config.google_search_cx_a ?? "",
    google_search_cx_b: config.google_search_cx_b ?? "",
    gemini_api_key_2: config.gemini_api_key_2 ?? "",
    google_sheet_name: config.google_sheet_name || "产品情报",
    operations_google_sheet_name: config.operations_google_sheet_name || "运营情报",
    product_report_url: config.product_report_url
      || `https://docs.google.com/spreadsheets/d/${config.spreadsheet_id}/edit?gid=0`,
    operations_report_url: config.operations_report_url
      || `https://docs.google.com/spreadsheets/d/${config.spreadsheet_id}/edit`,
    operations_schedule_enabled: config.operations_schedule_enabled ?? config.schedule_enabled ?? false,
    operations_schedule_hour: config.operations_schedule_hour ?? 9,
    operations_schedule_minute: config.operations_schedule_minute ?? 30,
    enabled_countries: Array.isArray(config.enabled_countries)
      ? config.enabled_countries
      : [...TARGET_COUNTRIES],
    default_operations_target_region: config.default_operations_target_region || "全部",
    default_operations_time_range: config.default_operations_time_range || "近3天",
    database_file: path.isAbsolute(config.database_file)
      ? config.database_file
      : path.join(PROJECT_ROOT, config.database_file),
  };
}
