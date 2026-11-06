import crypto from "node:crypto";
import { SOURCE_CATALOG } from "./source_catalog.ts";
import { mapLimit } from "./lib.ts";
import { mediaPublicationWindow, searchWeb, validateSearchResults } from "./web_search.ts";
import type { EvidenceItem, RadarConfig, SourceExecutionRecord, TimeRange } from "./types.ts";

type OfficialSource = { country: string; name: string; domain: string; url?: string; query: string };

export async function collectOperationsOfficial(
  config: RadarConfig,
  input: { countries: string[]; currentDate: string; timeRange: TimeRange; onProgress?: (text: string) => void },
) {
  const countryConfigs = SOURCE_CATALOG.countries as unknown as Record<string, { region: string }>;
  const sources = (SOURCE_CATALOG.operations_official_sources as OfficialSource[])
    .filter((source) => input.countries.includes(source.country));
  const window = mediaPublicationWindow(input.currentDate, input.timeRange);
  const runs = await mapLimit(sources, config.site_concurrency, async (source) => {
    input.onProgress?.(`正在收集官方经营公告：${source.country}`);
    const query = source.query.replaceAll("${current_year}", input.currentDate.slice(0, 4));
    try {
      const response = await searchWeb(config, {
        query, domain: source.domain, maxResults: 5, mode: "news",
        startDate: window.start_date, endDate: window.end_date,
      });
      const checked = validateSearchResults(response, source.domain, {
        mode: "news", startDate: window.start_date, endDate: window.end_date,
      });
      const evidence = checked.valid.map((item) => {
        const url = String(item.url ?? "");
        const title = String(item.title ?? "");
        const evidence_id = crypto.createHash("sha256")
          .update(`${source.country}|${url.toLowerCase()}|${title.toLowerCase()}`).digest("hex");
        return {
          evidence_id,
          country: source.country,
          region: countryConfigs[source.country]?.region ?? "",
          publisher: source.name,
          acquisition_method: "Search API · 官方域名限定",
          source_kind: "operations-official",
          title,
          summary: String(item.content ?? ""),
          url,
          published_at: item.published_date,
          authority: "国家级官方来源",
          raw: item,
        } satisfies EvidenceItem;
      });
      return {
        evidence,
        execution: {
          source_line: "运营",
          source_kind: "operations-official",
          country: source.country,
          source_name: source.name,
          request_key: `operations:official:${source.country}:${source.domain}`,
          status: evidence.length ? "success" : "partial",
          item_count: evidence.length,
          request_payload: { query, include_domains: [source.domain], start_date: window.start_date, end_date: window.end_date },
          response_payload: checked,
          error: evidence.length ? undefined
            : checked.received === 0
              ? "Search API 的 news 索引在该官方域名和日期窗口内没有返回公告"
              : `Search API 返回${checked.received}条，其中${checked.rejected}条未通过域名、日期、正文或页面有效性校验`,
        } satisfies SourceExecutionRecord,
      };
    } catch (error) {
      return {
        evidence: [] as EvidenceItem[],
        execution: {
          source_line: "运营",
          source_kind: "operations-official",
          country: source.country,
          source_name: source.name,
          request_key: `operations:official:${source.country}:${source.domain}`,
          status: "failed",
          item_count: 0,
          error: error instanceof Error ? error.message : String(error),
        } satisfies SourceExecutionRecord,
      };
    }
  });
  return { evidence: runs.flatMap((run) => run.evidence), executions: runs.map((run) => run.execution) };
}
