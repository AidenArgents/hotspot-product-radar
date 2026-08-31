import { isConcreteArticleUrl, mediaPublicationWindow } from "./web_search.ts";
import type { EvidenceItem } from "./types.ts";

export function withinOperationWindow(item: EvidenceItem, currentDate: string, timeRange: string) {
  if (!item.published_at || !isConcreteArticleUrl(item.url)) return false;
  const published = new Date(item.published_at);
  if (!Number.isFinite(published.getTime())) return false;
  const window = mediaPublicationWindow(currentDate, timeRange);
  const start = new Date(`${window.start_date}T00:00:00Z`);
  const end = new Date(`${window.end_date}T23:59:59.999Z`);
  return published >= start && published <= end;
}
