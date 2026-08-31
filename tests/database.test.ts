import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  connectDatabase,
  ensureSchema,
  finishRun,
  insertNewEvents,
  startRun,
} from "../f/radar/database.ts";
import { queryEvents } from "../f/radar/query_events.ts";
import type { BranchResult, RadarConfig, RuntimeContext } from "../f/radar/types.ts";

test("SQLite 单文件完成运行、事件写入与看板查询", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "radar-test-"));
  const config = { database_file: path.join(temp, "radar.sqlite") } as RadarConfig;
  const database = connectDatabase(config);
  const context = {
    run_id: "test-run",
    current_date: "2026-08-06",
    target_region: "拉美",
    time_range: "未来3个月",
    data_lines: "仅媒体",
    trigger_type: "manual",
    history_ids: [],
  } satisfies RuntimeContext;
  const branch = {
    line: "媒体",
    data_source: "Tavily媒体",
    analysis: "测试",
    events: [{
      event_id: "evt-1",
      event_name: "世界杯测试事件",
      country: "墨西哥",
      region: "拉美",
      date: "2026-08-06",
      stage: "预告期",
      ecommerce_score: 91,
      products: [{
        name_中文: "球迷用品",
        price_range_当地货币: "100-500 MXN",
      }] as any,
    }],
    top10_events: [],
    executions: [],
  } satisfies BranchResult;
  try {
    await ensureSchema(database);
    await startRun(database, context.run_id, context);
    const inserted = await insertNewEvents(database, context, branch);
    assert.equal(inserted.length, 1);
    await finishRun(database, context.run_id, "success", [branch]);
  } finally {
    database.close();
  }
  const queried = await queryEvents(config, { region: "拉美", min_score: 80 });
  assert.equal(queried.total, 1);
  assert.equal(queried.items[0]?.event_name, "世界杯测试事件");
  assert.deepEqual(queried.items[0]?.products, [{
    name_中文: "球迷用品",
    price_range_当地货币: "100-500 MXN",
    name: "球迷用品",
    price_range: "100-500 MXN",
  }]);
  fs.rmSync(temp, { recursive: true, force: true });
});
