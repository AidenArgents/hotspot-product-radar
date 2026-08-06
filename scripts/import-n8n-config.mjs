import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const sourcePath = path.resolve(
  process.argv[2] ??
    "C:/Users/LokiA/Downloads/热点选品雷达v7 东南亚+拉美地区.json",
);

const workflow = JSON.parse(fs.readFileSync(sourcePath, "utf8"));

function node(name) {
  const value = workflow.nodes.find((item) => item.name === name);
  if (!value) throw new Error(`找不到 n8n 节点：${name}`);
  return value;
}

const rawConfig = node("设置参数").parameters.jsonOutput.replace(/^=/, "");
const imported = JSON.parse(rawConfig);

function privateIpv4() {
  const candidates = [];
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal) continue;
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address.address)) {
        candidates.push(address.address);
      }
    }
  }
  return candidates.find((address) => address.startsWith("192.168."))
    ?? candidates.find((address) => address.startsWith("10."))
    ?? candidates[0]
    ?? "localhost";
}

const config = {
  admin_password: "",
  gemini_api_key: imported.gemini_api_key,
  tavily_api_key: imported.tavily_api_key,
  spreadsheet_id: imported.spreadsheet_id,
  google_service_account_email: imported.google_service_account_email,
  google_private_key: imported.google_private_key,
  google_sheet_name: "工作表1",
  dingtalk_token_1: imported.dingtalk_token_1,
  dingtalk_secret_1: imported.dingtalk_secret_1,
  dingtalk_token_2: imported.dingtalk_token_2,
  dingtalk_secret_2: imported.dingtalk_secret_2,
  database_file: "data/radar.sqlite",
  server_host: "0.0.0.0",
  server_port: 3210,
  dashboard_url: `http://${privateIpv4()}:3210`,
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

const mediaCode = node("搜索分析-媒体").parameters.jsCode;
const countriesMatch = mediaCode.match(
  /const countriesConfig = (\{[\s\S]*?\});\nconst sportsSearches/,
);
const sportsMatch = mediaCode.match(
  /const sportsSearches = (\[[\s\S]*?\]);\nconst allEvents/,
);
if (!countriesMatch || !sportsMatch) {
  throw new Error("无法从媒体线路提取国家或体育搜索配置");
}

const sourceCatalog = {
  regions: {
    东南亚: ["越南", "泰国", "印尼", "菲律宾", "马来西亚", "新加坡"],
    拉美: ["巴西", "墨西哥"],
  },
  countries: JSON.parse(countriesMatch[1]),
  sports_searches: JSON.parse(sportsMatch[1]),
  rss_feeds: [
    {
      name: "环球网-国际",
      url: "https://rsshub.rssforever.com/huanqiu/news/world?limit=100"
    },
    {
      name: "环球网-军事",
      url: "https://rsshub.rssforever.com/huanqiu/news/mil?limit=100"
    },
    {
      name: "参考消息-国际",
      url: "https://rsshub.rssforever.com/cankaoxiaoxi/column/guoji?limit=100"
    }
  ],
  google_news_queries: []
};

const configDir = path.join(projectRoot, "config");
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(
  path.join(configDir, "radar_config.local.json"),
  `${JSON.stringify(config, null, 2)}\n`,
  { mode: 0o600 },
);
fs.writeFileSync(
  path.join(configDir, "source_catalog.json"),
  `${JSON.stringify(sourceCatalog, null, 2)}\n`,
);
const radarFolder = path.join(projectRoot, "f", "radar");
fs.mkdirSync(radarFolder, { recursive: true });
fs.writeFileSync(
  path.join(radarFolder, "source_catalog.ts"),
  `// 由 scripts/import-n8n-config.mjs 从原 n8n 工作流机械提取。\n` +
    `// 保留全部国家、逐站点查询和体育搜索，不要在迁移阶段手工压缩。\n` +
    `export const SOURCE_CATALOG = ${JSON.stringify(sourceCatalog, null, 2)} as const;\n`,
);

console.log(
  `已导入集中配置（${Object.keys(config).length} 个字段）并保留 ${Object.keys(sourceCatalog.countries).length} 个国家、${sourceCatalog.sports_searches.length} 条体育搜索；密钥值未输出。`,
);
