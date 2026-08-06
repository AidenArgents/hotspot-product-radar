import fs from "node:fs";
import path from "node:path";
import type { RadarConfig } from "./f/radar/types.ts";

export const PROJECT_ROOT = import.meta.dirname;
export const CONFIG_FILE = path.join(PROJECT_ROOT, "config", "radar_config.local.json");

export function loadConfig(): RadarConfig {
  if (!fs.existsSync(CONFIG_FILE)) {
    throw new Error("缺少 config/radar_config.local.json，请先运行 npm run import:n8n");
  }
  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as RadarConfig;
  return {
    ...config,
    database_file: path.isAbsolute(config.database_file)
      ? config.database_file
      : path.join(PROJECT_ROOT, config.database_file),
  };
}
