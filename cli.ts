import { loadConfig } from "./config.ts";
import { runScan } from "./f/radar/run_scan.ts";
import type { DataLines, TargetRegion, TimeRange } from "./f/radar/types.ts";

const command = process.argv[2] ?? "help";
const config = loadConfig();

function argument(name: string, fallback: string) {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

if (command === "scan") {
  const result = await runScan(config, {
    target_region: argument("region", config.default_target_region) as TargetRegion,
    time_range: argument("time", config.default_time_range) as TimeRange,
    data_lines: argument("lines", config.default_manual_data_lines) as DataLines,
    trigger_type: "manual",
  });
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log("用法：npm run scan -- --region=全部 --time=未来3个月 --lines=全部");
}
