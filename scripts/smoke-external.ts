import { loadConfig } from "../config.ts";
import { runScan } from "../f/radar/run_scan.ts";

const mode = process.argv[2] === "media" ? "media" : "holiday";
const result = await runScan(
  loadConfig(),
  {
    target_region: mode === "media" ? "新加坡" : "越南",
    time_range: "未来3个月",
    data_lines: mode === "media" ? "仅媒体" : "仅假日",
    trigger_type: "manual",
  },
  false,
  false,
);

console.log(JSON.stringify({
  status: result.status,
  branches: result.branches,
}, null, 2));
