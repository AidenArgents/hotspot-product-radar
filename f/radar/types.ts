export type TargetRegion = "全部" | "北美" | "东南亚" | "拉美" | string;
export type TimeRange = "今天" | "近3天" | "本周" | "本月" | "未来3个月" | string;
export type DataLines =
  | "全部"
  | "媒体+网页"
  | "仅网页"
  | "仅媒体"
  | "仅假日"
  | "假日+网页"
  | "假日+媒体"
  | string;
export type SourceLine = "假日" | "媒体" | "网页" | "运营";

export interface RadarConfig {
  admin_password?: string;
  gemini_api_key: string;
  gemini_api_key_2: string;
  tavily_api_key: string;
  spreadsheet_id: string;
  google_service_account_email: string;
  google_private_key: string;
  google_sheet_name: string;
  operations_google_sheet_name: string;
  product_report_url: string;
  operations_report_url: string;
  dingtalk_token_1: string;
  dingtalk_secret_1: string;
  dingtalk_token_2: string;
  dingtalk_secret_2: string;
  database_file: string;
  server_host: string;
  server_port: number;
  dashboard_url: string;
  https_proxy: string;
  schedule_enabled: boolean;
  schedule_hour: number;
  schedule_minute: number;
  operations_schedule_enabled: boolean;
  operations_schedule_hour: number;
  operations_schedule_minute: number;
  enabled_countries: string[];
  gemini_model: string;
  country_concurrency: number;
  site_concurrency: number;
  request_timeout_ms: number;
  gemini_timeout_ms: number;
  gemini_min_interval_ms: number;
  default_target_region: TargetRegion;
  default_time_range: TimeRange;
  default_manual_data_lines: DataLines;
  default_schedule_data_lines: DataLines;
  default_operations_target_region: TargetRegion;
  default_operations_time_range: TimeRange;
  calendar_enabled?: boolean;
  calendar_url?: string;
  calendar_hour?: number;
  calendar_minute?: number;
  calendar_start_date?: string;
  calendar_offsets?: number[];
}

export interface ScanInput {
  target_region: TargetRegion;
  time_range: TimeRange;
  data_lines: DataLines;
  trigger_type: "manual" | "schedule";
}

export interface ProductSuggestion {
  name?: string;
  category?: string;
  price_range?: string;
  keywords_en?: string[];
  keywords_local?: string[];
}

export interface RadarEvent {
  event_id: string;
  event_name: string;
  event_type?: string;
  country?: string;
  region?: string;
  currency?: string;
  date?: string;
  stage?: string;
  source?: string;
  data_source?: string;
  ecommerce_score?: number;
  products?: ProductSuggestion[];
  best_listing_time?: string;
  why_sellable?: string;
  [key: string]: unknown;
}

export interface RuntimeContext extends ScanInput {
  run_id: string;
  current_date: string;
  history_ids: string[];
  onProgress?: (msg: string) => void;
}

export interface SourceExecutionRecord {
  source_line: SourceLine;
  source_kind: string;
  country?: string;
  source_name?: string;
  request_key: string;
  status: "running" | "success" | "failed" | "partial" | "skipped";
  item_count?: number;
  request_payload?: unknown;
  response_payload?: unknown;
  error?: string;
}

export interface SportsResult {
  country?: string;
  scope?: "country" | "global";
  source_name: string;
  query: string;
  answer?: string;
  results: unknown[];
}

export interface BranchResult {
  line: SourceLine;
  data_source: string;
  events: RadarEvent[];
  top10_events: RadarEvent[];
  analysis: string;
  executions: SourceExecutionRecord[];
  sports_results?: SportsResult[];
}

export interface CountryConfig {
  code: string;
  currency: string;
  region: string;
  media: readonly (readonly [string, string])[];
}

export type OperationDirection = "利好" | "利空" | "混合" | "中性";
export type OperationUrgency = "立即处理" | "近期关注" | "长期观察";
export type OperationVerificationStatus = "已确认" | "多源佐证" | "待核实";

export interface OperationIntelligence {
  intelligence_id: string;
  title: string;
  country: string;
  region: string;
  platform?: string;
  policy_type?: string;
  policy_subject?: string;
  category: string;
  direction: OperationDirection;
  impact_score: number;
  urgency: OperationUrgency;
  effective_date?: string;
  impact_scope?: string;
  affected_dimensions?: string[];
  affected_categories?: string[];
  business_impact: string;
  recommended_actions?: string[];
  source_name: string;
  source_url?: string;
  source_urls?: string[];
  source_date?: string;
  authority?: string;
  verification_status?: OperationVerificationStatus;
  confidence?: number;
  evidence_count?: number;
  [key: string]: unknown;
}

export interface OperationScanInput {
  target_region: TargetRegion;
  time_range: TimeRange;
  trigger_type: "manual" | "schedule";
  force_refresh?: boolean;
}

export interface EvidenceItem {
  evidence_id: string;
  country: string;
  region: string;
  publisher: string;
  acquisition_method: string;
  source_kind: string;
  title: string;
  summary: string;
  url: string;
  published_at?: string;
  authority: string;
  raw?: unknown;
}
