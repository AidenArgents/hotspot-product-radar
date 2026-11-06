import crypto from "node:crypto";
import { SOURCE_CATALOG } from "./source_catalog.ts";
import type { BranchResult, EvidenceItem } from "./types.ts";

const officialMediaDomains = new Set(["channelnewsasia.com", "world.thaipbs.or.th"]);
const rssFeeds = new Map(
  (SOURCE_CATALOG.rss_feeds as Array<{ name: string; official?: boolean }>).map((feed) => [feed.name, feed]),
);
const countries = SOURCE_CATALOG.countries as unknown as Record<string, { region: string }>;

function fingerprint(country: string, url: string, title: string) {
  return crypto.createHash("sha256")
    .update(`${country}|${url.trim().toLowerCase()}|${title.trim().toLowerCase()}`)
    .digest("hex");
}

function addEvidence(
  output: Map<string, EvidenceItem>,
  item: Omit<EvidenceItem, "evidence_id" | "region">,
) {
  if (!item.country || !countries[item.country] || !item.title || !item.url) return;
  const evidence_id = fingerprint(item.country, item.url, item.title);
  output.set(evidence_id, {
    ...item,
    evidence_id,
    region: countries[item.country].region,
  });
}

export function extractEvidence(branches: BranchResult[]): EvidenceItem[] {
  const output = new Map<string, EvidenceItem>();
  for (const branch of branches) {
    for (const execution of branch.executions) {
      const payload = execution.response_payload as Record<string, unknown> | undefined;
      if (!payload || execution.status === "failed") continue;
      if (execution.source_kind === "tavily" && execution.country) {
        const results = Array.isArray(payload.valid) ? payload.valid : Array.isArray(payload.results) ? payload.results : [];
        for (const raw of results) {
          const item = raw as Record<string, unknown>;
          addEvidence(output, {
            country: execution.country,
            publisher: execution.source_name ?? "当地媒体",
            acquisition_method: "Tavily Search API",
            source_kind: execution.source_kind,
            title: String(item.title ?? ""),
            summary: String(item.content ?? ""),
            url: String(item.url ?? ""),
            published_at: item.published_date ? String(item.published_date) : undefined,
            authority: officialMediaDomains.has(execution.source_name ?? "") ? "官方/公共媒体" : "当地主要媒体",
            raw: item,
          });
        }
      } else if (execution.source_kind === "rss" && execution.country) {
        const feed = rssFeeds.get(execution.source_name ?? "");
        for (const raw of Array.isArray(payload.articles) ? payload.articles : []) {
          const item = raw as Record<string, unknown>;
          addEvidence(output, {
            country: execution.country,
            publisher: execution.source_name ?? "RSS媒体",
            acquisition_method: "发布者直连 RSS/XML接口",
            source_kind: "rss",
            title: String(item.title ?? ""),
            summary: String(item.description ?? ""),
            url: String(item.url ?? ""),
            published_at: item.published_at ? String(item.published_at) : undefined,
            authority: feed?.official ? "官方/国家通讯社" : "新闻媒体",
            raw: item,
          });
        }
      } else if (execution.source_kind === "gdacs") {
        for (const raw of Array.isArray(payload.alerts) ? payload.alerts : []) {
          const item = raw as Record<string, unknown>;
          addEvidence(output, {
            country: String(item.country ?? ""),
            publisher: "GDACS",
            acquisition_method: "直连 XML/RSS接口",
            source_kind: "gdacs",
            title: String(item.title ?? ""),
            summary: `${String(item.description ?? "")} ${String(item.severity ?? "")}`.trim(),
            url: String(item.url ?? ""),
            published_at: item.modified_at ? String(item.modified_at) : undefined,
            authority: "国际官方灾害预警",
            raw: item,
          });
        }
      }
    }
  }
  return [...output.values()];
}
