import fs from "node:fs";
import path from "node:path";
import type { RadarConfig } from "./f/radar/types.ts";

export const PROJECT_ROOT = import.meta.dirname;
export const CONFIG_FILE = path.join(PROJECT_ROOT, "config", "radar_config.local.json");

export function readConfig(): RadarConfig {
  if (!fs.existsSync(CONFIG_FILE)) {
    throw new Error(
      "缺少 config/radar_config.local.json，请先运行 setup.bat，或复制 radar_config.example.json 后填写配置",
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
    database_file: path.isAbsolute(config.database_file)
      ? config.database_file
      : path.join(PROJECT_ROOT, config.database_file),
  };
}
