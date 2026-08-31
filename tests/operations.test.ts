import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  connectDatabase,
  ensureSchema,
  finishOperationRun,
  insertEvidenceItems,
  insertOperationIntelligence,
  loadRecentEvidence,
  loadUnsyncedOperationIntelligence,
  markOperationSheetSynced,
  startOperationRun,
} from "../f/radar/database.ts";
import { queryOperations } from "../f/radar/query_operations.ts";
import type { OperationIntelligence, OperationScanInput, RadarConfig } from "../f/radar/types.ts";

test("运营情报拥有独立证据库、结果表和完整筛选统计", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "radar-operations-"));
  const config = { database_file: path.join(temp, "radar.sqlite") } as RadarConfig;
  const database = connectDatabase(config);
  const input = {
    target_region: "东南亚", time_range: "近3天", trigger_type: "manual",
  } satisfies OperationScanInput;
  const item = {
    intelligence_id: "OPS_TEST_1",
    title: "海关调整跨境电商申报规则",
    country: "马来西亚",
    region: "东南亚",
    category: "关税与海关",
    direction: "利空",
    impact_score: 91,
    urgency: "立即处理",
    business_impact: "电子配件申报资料不足时可能延迟清关。",
    recommended_actions: ["核查在途货物申报文件"],
    source_name: "海关公告",
    source_url: "https://example.test/customs",
    authority: "官方",
    confidence: 95,
  } satisfies OperationIntelligence;
  try {
    await ensureSchema(database);
    await startOperationRun(database, "ops-run", input, "fresh");
    await insertEvidenceItems(database, [{
      evidence_id: "evidence-1", country: "马来西亚", region: "东南亚",
      publisher: "海关公告", acquisition_method: "Tavily Search API", source_kind: "tavily",
      title: item.title, summary: item.business_impact, url: item.source_url!, authority: "官方",
    }]);
    assert.equal((await loadRecentEvidence(database, ["马来西亚"], 180)).length, 1);
    assert.equal((await insertOperationIntelligence(database, "ops-run", [item])).length, 1);
    assert.equal((await insertOperationIntelligence(database, "ops-run", [item])).length, 0);
    assert.equal((await loadUnsyncedOperationIntelligence(database)).length, 1);
    await markOperationSheetSynced(database, [item.intelligence_id]);
    assert.equal((await loadUnsyncedOperationIntelligence(database)).length, 0);
    await finishOperationRun(database, "ops-run", "success", 1, [], { countries: { 马来西亚: 1 } });
  } finally { database.close(); }

  try {
    const result = await queryOperations(config, { min_score: 80, direction: "利空" });
    assert.equal(result.total, 1);
    assert.equal(result.stats.high, 1);
    assert.equal(result.stats.urgent_risk, 1);
    assert.equal(result.items[0]?.title, item.title);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
