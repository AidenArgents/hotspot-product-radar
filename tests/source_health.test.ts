import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  connectDatabase,
  ensureSchema,
  recordExecutions,
  startRun,
} from "../f/radar/database.ts";
import { main as querySourceHealth } from "../f/radar/query_source_health.ts";
import type { RadarConfig, ScanInput } from "../f/radar/types.ts";

test("数据源健康接口返回每个来源最近一次真实状态", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "radar-source-health-"));
  const config = { database_file: path.join(temp, "radar.sqlite") } as RadarConfig;
  const database = connectDatabase(config);
  const input = {
    target_region: "东南亚",
    time_range: "今天",
    data_lines: "仅媒体",
    trigger_type: "manual",
  } satisfies ScanInput;

  try {
    await ensureSchema(database);
    await startRun(database, "health-run-1", input);
    await recordExecutions(database, "health-run-1", [{
      source_line: "媒体",
      source_kind: "tavily",
      country: "越南",
      source_name: "vnexpress.net",
      request_key: "media:越南:vnexpress.net",
      status: "failed",
      error: "timeout",
    }]);
    await startRun(database, "health-run-2", input);
    await recordExecutions(database, "health-run-2", [{
      source_line: "媒体",
      source_kind: "tavily",
      country: "越南",
      source_name: "vnexpress.net",
      request_key: "media:越南:vnexpress.net",
      status: "success",
      item_count: 4,
    }]);
    await recordExecutions(database, "health-run-2", [{
      source_line: "媒体",
      source_kind: "sports",
      source_name: "fifa.com",
      request_key: "media:sports:fifa.com",
      status: "success",
      item_count: 0,
    }]);
  } finally {
    database.close();
  }

  try {
    const health = await querySourceHealth(config) as Array<Record<string, unknown>>;
    assert.equal(health.length, 2);
    const media = health.find((item) => item.source_name === "vnexpress.net");
    assert.equal(media?.status, "success");
    assert.equal(media?.item_count, 4);
    assert.equal(media?.run_id, "health-run-2");
    const emptySports = health.find((item) => item.source_name === "fifa.com");
    assert.equal(emptySports?.status, "partial");
    assert.match(String(emptySports?.error), /没有取得有效内容/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
