export type TargetRegion = "全部" | "东南亚" | "拉美" | string;
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
export type SourceLine = "假日" | "媒体" | "网页";

export interface RadarConfig {
  gemini_api_key: string;
  tavily_api_key: string;
  spreadsheet_id: string;
  google_service_account_email: string;
  google_private_key: string;
  google_sheet_name: string;
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
