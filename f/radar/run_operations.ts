import { collectMedia } from "./collect_media.ts";
import { collectWeb } from "./collect_web.ts";
import { collectOperationsOfficial } from "./collect_operations_official.ts";
import { collectPlatformIntelligence } from "./collect_platform_intelligence.ts";
import {
  connectDatabase,
  ensureSchema,
  finishOperationRun,
  insertEvidenceItems,
  insertOperationIntelligence,
  loadOperationHistoryIds,
  loadRecentEvidence,
  loadUnsyncedOperationIntelligence,
  markOperationSheetSynced,
  recordOperationExecutions,
  recordOperationNotification,
  startOperationRun,
} from "./database.ts";
import { buildOperationsDingTalkMessage, sendDingTalk } from "./dingtalk.ts";
import { extractEvidence } from "./evidence.ts";
import { countriesForTarget, makeRunId, todayIso } from "./lib.ts";
import { analyzeOperations } from "./operations_analyzer.ts";
import { withinOperationWindow } from "./operations_window.ts";
import { appendOperationIntelligence, readOperationsSheetHistory } from "./operations_google_sheets.ts";
import type {
  EvidenceItem,
  OperationIntelligence,
  OperationScanInput,
  RadarConfig,
  RuntimeContext,
  SourceExecutionRecord,
} from "./types.ts";

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function mergeEvidence(...groups: EvidenceItem[][]) {
  return [...new Map(groups.flat().map((item) => [item.evidence_id, item])).values()];
}

function mergeOperationItems(...groups: OperationIntelligence[][]) {
  return [...new Map(groups.flat().map((item) => [item.intelligence_id, item])).values()];
}

export async function runOperationsScan(
  config: RadarConfig,
  input: OperationScanInput,
  syncGoogleSheets = true,
  sendNotifications = true,
  onProgress?: (text: string) => void,
) {
  const startedAt = new Date();
  const runId = makeRunId(startedAt);
  const currentDate = todayIso(startedAt);
  const countries = countriesForTarget(input.target_region, config.enabled_countries);
  if (!countries.length) {
    throw new Error(`“${input.target_region}”范围内没有启用的国家，请先在系统设置中勾选`);
  }
  const database = connectDatabase(config);
  const executions: SourceExecutionRecord[] = [];
  let started = false;
  let evidenceMode: "fresh" | "reused" = "fresh";
  try {
    await ensureSchema(database);
    let evidence = input.force_refresh ? [] : (await loadRecentEvidence(database, countries, 180))
      .filter((item) => withinOperationWindow(item, currentDate, input.time_range));
    const sharedCovered = new Set(evidence.filter((item) =>
      item.source_kind !== "operations-official" && !item.source_kind.startsWith("platform-"),
    ).map((item) => item.country));
    const officialCovered = new Set(evidence.filter((item) => item.source_kind === "operations-official").map((item) => item.country));
    const platformCovered = new Set(evidence.filter((item) => item.source_kind.startsWith("platform-")).map((item) => item.country));
    const reuseShared = !input.force_refresh && countries.every((country) => sharedCovered.has(country));
    const reuseOfficial = !input.force_refresh && countries.every((country) => officialCovered.has(country));
    const reusePlatform = !input.force_refresh && countries.every((country) => platformCovered.has(country));
    evidenceMode = reuseShared && reuseOfficial && reusePlatform ? "reused" : "fresh";
    await startOperationRun(database, runId, input, evidenceMode);
    started = true;

    if (reuseShared) {
      onProgress?.(`复用最近3小时的${evidence.length}条新闻证据`);
      executions.push(...countries.map((country) => ({
        source_line: "运营" as const,
        source_kind: "evidence-cache",
        country,
        source_name: "共享原始证据库",
        request_key: `operations:evidence-cache:${country}`,
        status: "success" as const,
        item_count: evidence.filter((item) => item.country === country
          && item.source_kind !== "operations-official" && !item.source_kind.startsWith("platform-")).length,
      })));
    } else {
      onProgress?.("正在逐国、逐站采集运营与产品共用新闻证据...");
      const context: RuntimeContext = {
        run_id: runId,
        current_date: currentDate,
        target_region: input.target_region,
        time_range: input.time_range,
        data_lines: "媒体+网页",
        trigger_type: input.trigger_type,
        history_ids: [],
        onProgress,
      };
      const collected = await Promise.all([
        collectMedia(config, context),
        collectWeb(config, context, false),
      ]);
      const freshEvidence = extractEvidence(collected);
      await insertEvidenceItems(database, freshEvidence);
      evidence = mergeEvidence(freshEvidence, evidence)
        .filter((item) => countries.includes(item.country))
        .filter((item) => withinOperationWindow(item, currentDate, input.time_range));
      executions.push(...collected.flatMap((branch) => branch.executions));
      onProgress?.(`采集完成，共${evidence.length}条可验证新闻证据`);
    }
    if (!reuseOfficial) {
      const official = await collectOperationsOfficial(config, {
        countries, currentDate, timeRange: input.time_range, onProgress,
      });
      await insertEvidenceItems(database, official.evidence);
      evidence = mergeEvidence(official.evidence, evidence)
        .filter((item) => withinOperationWindow(item, currentDate, input.time_range));
      executions.push(...official.executions);
    }
    if (!reusePlatform) {
      const missingPlatformCountries = input.force_refresh
        ? countries
        : countries.filter((country) => !platformCovered.has(country));
      const platform = await collectPlatformIntelligence(config, {
        countries: missingPlatformCountries,
        currentDate,
        timeRange: input.time_range,
        onProgress,
      });
      await insertEvidenceItems(database, platform.evidence);
      evidence = mergeEvidence(platform.evidence, evidence)
        .filter((item) => withinOperationWindow(item, currentDate, input.time_range));
      executions.push(...platform.executions);
      onProgress?.(`平台动态采集完成，新增${platform.evidence.length}条可追溯证据`);
    } else {
      executions.push(...countries.map((country) => ({
        source_line: "运营" as const,
        source_kind: "platform-evidence-cache",
        country,
        source_name: "平台动态证据缓存",
        request_key: `operations:platform-cache:${country}`,
        status: "success" as const,
        item_count: evidence.filter((item) => item.country === country && item.source_kind.startsWith("platform-")).length,
      })));
    }
    await recordOperationExecutions(database, runId, executions);

    const localHistory = await loadOperationHistoryIds(database);
    let sheetHistory: string[] = [];
    let sheetHistoryAvailable = false;
    if (syncGoogleSheets) {
      try {
        sheetHistory = await readOperationsSheetHistory(config);
        sheetHistoryAvailable = true;
        const alreadyPresent = (await loadUnsyncedOperationIntelligence(database))
          .map((item) => item.intelligence_id)
          .filter((id) => sheetHistory.includes(id));
        await markOperationSheetSynced(database, alreadyPresent);
      } catch (error) {
        const execution = {
          source_line: "运营" as const,
          source_kind: "google-sheets-history",
          source_name: config.operations_google_sheet_name,
          request_key: "operations:sheets:history",
          status: "failed" as const,
          item_count: 0,
          error: message(error),
        };
        executions.push(execution);
        await recordOperationExecutions(database, runId, [execution]);
      }
    }
    const pendingBeforeAnalysis = syncGoogleSheets && sheetHistoryAvailable
      ? await loadUnsyncedOperationIntelligence(database)
      : [];
    const analyzed = await analyzeOperations(config, {
      currentDate,
      targetCountries: countries,
      evidence,
      historyIds: [...new Set([...localHistory, ...sheetHistory])],
      onProgress,
    });
    executions.push(...analyzed.executions);
    await recordOperationExecutions(database, runId, analyzed.executions);
    const inserted = await insertOperationIntelligence(database, runId, analyzed.items);

    const rowsToSync = syncGoogleSheets
      ? mergeOperationItems(pendingBeforeAnalysis, inserted)
        .filter((item) => !sheetHistory.includes(item.intelligence_id))
      : [];
    if (syncGoogleSheets && rowsToSync.length) {
      onProgress?.(`正在写入Google表格“${config.operations_google_sheet_name}”...`);
      try {
        await appendOperationIntelligence(config, rowsToSync, currentDate);
        await markOperationSheetSynced(database, rowsToSync.map((item) => item.intelligence_id));
        const execution = {
          source_line: "运营" as const,
          source_kind: "google-sheets",
          source_name: config.operations_google_sheet_name,
          request_key: "operations:sheets:append",
          status: "success" as const,
          item_count: rowsToSync.length,
        };
        executions.push(execution);
        await recordOperationExecutions(database, runId, [execution]);
      } catch (error) {
        const execution = {
          source_line: "运营" as const,
          source_kind: "google-sheets",
          source_name: config.operations_google_sheet_name,
          request_key: "operations:sheets:append",
          status: "failed" as const,
          item_count: rowsToSync.length,
          error: message(error),
        };
        executions.push(execution);
        await recordOperationExecutions(database, runId, [execution]);
      }
    }

    const notifiable = inserted.filter((item) => item.verification_status !== "待核实");
    if (sendNotifications && notifiable.length) {
      onProgress?.("正在发送运营情报日报...");
      const results = await sendDingTalk(
        config,
        buildOperationsDingTalkMessage(config, currentDate, input.target_region, notifiable),
      );
      for (const result of results) {
        await recordOperationNotification(
          database, runId, result.robotIndex, result.ok ? "success" : "failed",
          result.response, result.error,
        );
        const execution = {
          source_line: "运营" as const,
          source_kind: "dingtalk",
          source_name: `robot-${result.robotIndex}`,
          request_key: `operations:dingtalk:${result.robotIndex}`,
          status: result.ok ? "success" as const : "failed" as const,
          item_count: 1,
          error: result.error,
        };
        executions.push(execution);
        await recordOperationExecutions(database, runId, [execution]);
      }
    }

    const countryCounts = Object.fromEntries(countries.map((country) => [
      country,
      inserted.filter((item) => item.country === country).length,
    ]));
    const status = executions.some((item) => item.status === "failed") ? "partial" : "success";
    await finishOperationRun(database, runId, status, inserted.length, executions, {
      evidence_mode: evidenceMode,
      evidence_count: evidence.length,
      broadcast_count: notifiable.length,
      pending_verification_count: inserted.length - notifiable.length,
      countries: countryCounts,
    });
    return {
      run_id: runId,
      status,
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      intelligence_count: inserted.length,
      evidence_count: evidence.length,
      evidence_mode: evidenceMode,
      countries: countryCounts,
    };
  } catch (error) {
    if (started) {
      await finishOperationRun(database, runId, "failed", 0, executions, {}, message(error));
    }
    throw error;
  } finally {
    database.close();
  }
}
