import {
  appendSheetRows,
  OPERATIONS_SHEET_HEADERS,
  readSheetHistory,
} from "./google_sheets.ts";
import type { OperationIntelligence, RadarConfig } from "./types.ts";

export async function readOperationsSheetHistory(config: RadarConfig) {
  return readSheetHistory(config, config.operations_google_sheet_name, OPERATIONS_SHEET_HEADERS);
}

export async function appendOperationIntelligence(
  config: RadarConfig,
  items: OperationIntelligence[],
  scanDate: string,
) {
  const values = items.map((item) => [
    item.intelligence_id,
    item.title,
    item.country,
    item.region,
    item.category,
    item.direction,
    String(item.impact_score),
    item.urgency,
    item.effective_date ?? "",
    item.impact_scope ?? "",
    (item.affected_dimensions ?? []).join("、"),
    (item.affected_categories ?? []).join("、"),
    item.business_impact,
    (item.recommended_actions ?? []).join("；"),
    item.source_name,
    item.source_url ?? "",
    item.source_date ?? "",
    item.authority ?? "",
    String(item.confidence ?? 0),
    String(item.evidence_count ?? 1),
    scanDate,
  ]);
  return appendSheetRows(
    config,
    config.operations_google_sheet_name,
    OPERATIONS_SHEET_HEADERS,
    values,
  );
}
