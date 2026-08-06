import { collectHoliday } from "./collect_holiday.ts";
import { collectMedia } from "./collect_media.ts";
import { collectWeb } from "./collect_web.ts";
import {
  connectDatabase,
  ensureSchema,
  finishRun,
  insertNewEvents,
  loadHistoryIds,
  markSheetSynced,
  recordExecutions,
  recordNotification,
  recordSports,
  startRun,
  type RadarDatabase,
} from "./database.ts";
import { buildDingTalkMessage, sendDingTalk } from "./dingtalk.ts";
import { appendSheetEvents, readSheetHistory } from "./google_sheets.ts";
import { makeRunId, todayIso } from "./lib.ts";
import type {
  BranchResult,
  DataLines,
  RadarConfig,
  RuntimeContext,
  ScanInput,
  TargetRegion,
  TimeRange,
} from "./types.ts";

function validateConfig(config: RadarConfig): void {
  const required: Array<keyof RadarConfig> = [
    "gemini_api_key",
    "tavily_api_key",
    "database_file",
    "dingtalk_token_1",
    "dingtalk_secret_1",
    "dingtalk_token_2",
    "dingtalk_secret_2",
  ];
  const missing = required.filter((key) => !config[key]);
  if (missing.length) throw new Error(`radar_config 缺少字段：${missing.join(", ")}`);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function persistAndDeliverBranch(
  sql: RadarDatabase,
  config: RadarConfig,
  context: RuntimeContext,
  branch: BranchResult,
  syncGoogleSheets: boolean,
  sendNotifications: boolean,
): Promise<BranchResult> {
  await recordExecutions(sql, context.run_id, branch.executions);
  await recordSports(sql, context.run_id, branch);
  const newEvents = await insertNewEvents(sql, context, branch);
  const persisted: BranchResult = {
    ...branch,
    events: newEvents,
    top10_events: newEvents.slice(0, 10),
    executions: [...branch.executions],
  };

  if (syncGoogleSheets && newEvents.length) {
    try {
      await appendSheetEvents(
        config,
        newEvents,
        branch.data_source,
        context.current_date,
      );
      await markSheetSynced(
        sql,
        newEvents.map((event) => event.event_id),
      );
      await recordExecutions(sql, context.run_id, [
        {
          source_line: branch.line,
          source_kind: "google-sheets",
          source_name: config.google_sheet_name,
          request_key: `${branch.line}:sheets:append`,
          status: "success",
          item_count: newEvents.length,
        },
      ]);
      persisted.executions.push({
        source_line: branch.line,
        source_kind: "google-sheets",
        source_name: config.google_sheet_name,
        request_key: `${branch.line}:sheets:append`,
        status: "success",
        item_count: newEvents.length,
      });
    } catch (error) {
      const execution = {
        source_line: branch.line,
        source_kind: "google-sheets",
        source_name: config.google_sheet_name,
        request_key: `${branch.line}:sheets:append`,
        status: "failed",
        item_count: newEvents.length,
        error: errorText(error),
      } as const;
      await recordExecutions(sql, context.run_id, [execution]);
      persisted.executions.push(execution);
    }
  }

  if (sendNotifications && newEvents.length) {
    const content = buildDingTalkMessage(config, context, persisted, newEvents);
    const results = await sendDingTalk(config, content);
    await Promise.all(
      results.map((result) =>
        recordNotification(
          sql,
          context.run_id,
          branch.line,
          result.robotIndex,
          result.ok ? "success" : "failed",
          result.response,
          result.error,
        ),
      ),
    );
    const executions = results.map((result) => ({
      source_line: branch.line,
      source_kind: "dingtalk",
      source_name: `robot-${result.robotIndex}`,
      request_key: `${branch.line}:dingtalk:${result.robotIndex}`,
      status: result.ok ? "success" as const : "failed" as const,
      item_count: 1,
      error: result.error,
    }));
    await recordExecutions(sql, context.run_id, executions);
    persisted.executions.push(...executions);
  }
  return persisted;
}

export async function runScan(
  config: RadarConfig,
  input: ScanInput,
  syncGoogleSheets = true,
  sendNotifications = true,
): Promise<{
  run_id: string;
  status: "success" | "partial";
  started_at: string;
  finished_at: string;
  branches: Array<{ line: string; events: number; analysis: string }>;
}> {
  validateConfig(config);
  const startedAt = new Date();
  const runId = makeRunId(startedAt);
  const sql = connectDatabase(config);
  let started = false;
  const branches: BranchResult[] = [];
  try {
    await ensureSchema(sql);
    await startRun(sql, runId, input);
    started = true;

    const databaseHistory = await loadHistoryIds(sql);
    const sheetHistory = syncGoogleSheets
      ? await readSheetHistory(config)
      : [];
    const context: RuntimeContext = {
      ...input,
      run_id: runId,
      current_date: todayIso(startedAt),
      history_ids: [...new Set([...databaseHistory, ...sheetHistory])],
    };

    // 三条线路保持独立并发；每条线路内部仍遵循原来的站点/国家边界。
    const collected = await Promise.all([
      collectHoliday(config, context),
      collectMedia(config, context),
      collectWeb(config, context),
    ]);
    const persisted = await Promise.all(
      collected.map((branch) =>
        persistAndDeliverBranch(
          sql,
          config,
          context,
          branch,
          syncGoogleSheets,
          sendNotifications,
        ),
      ),
    );
    branches.push(...persisted);

    const hasFailures = persisted.some((branch) =>
      branch.executions.some((execution) => execution.status === "failed"),
    );
    const status = hasFailures ? "partial" : "success";
    await finishRun(sql, runId, status, branches);
    return {
      run_id: runId,
      status,
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      branches: branches.map((branch) => ({
        line: branch.line,
        events: branch.events.length,
        analysis: branch.analysis,
      })),
    };
  } catch (error) {
    if (started) await finishRun(sql, runId, "failed", branches, errorText(error));
    throw error;
  } finally {
    sql.close();
  }
}

export async function main(
  config: RadarConfig,
  target_region: TargetRegion = "",
  time_range: TimeRange = "",
  data_lines: DataLines = "",
  trigger_type: "manual" | "schedule" = "manual",
  sync_google_sheets = true,
  send_notifications = true,
) {
  const input: ScanInput = {
    target_region: target_region || config.default_target_region,
    time_range: time_range || config.default_time_range,
    data_lines:
      data_lines ||
      (trigger_type === "schedule"
        ? config.default_schedule_data_lines
        : config.default_manual_data_lines),
    trigger_type,
  };
  return runScan(config, input, sync_google_sheets, send_notifications);
}
