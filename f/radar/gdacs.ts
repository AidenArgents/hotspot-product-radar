export interface GdacsAlert {
  event_id: string;
  event_type: string;
  alert_level: string;
  country: string;
  title: string;
  description: string;
  severity: string;
  url: string;
  from_date?: string;
  modified_at?: string;
  line: string;
}

const TARGET_ISO3: Record<string, string> = {
  USA: "美国",
  VNM: "越南",
  THA: "泰国",
  IDN: "印尼",
  PHL: "菲律宾",
  MYS: "马来西亚",
  SGP: "新加坡",
  BRA: "巴西",
  MEX: "墨西哥",
};

function decodeXml(value: string) {
  return value
    .replace(/^<!\[CDATA\[|\]\]>$/g, "")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return decodeXml(block.match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, "i"))?.[1] ?? "");
}

function isoDate(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

export function parseGdacs(
  xml: string,
  options: { currentDate: string; maxAgeDays: number; maxItems: number },
) {
  const cutoff = new Date(`${options.currentDate}T23:59:59Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - options.maxAgeDays);
  const seen = new Set<string>();
  const alerts: GdacsAlert[] = [];
  let targetItems = 0;
  let stale = 0;
  let duplicate = 0;
  for (const block of xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) ?? []) {
    const iso3 = tag(block, "gdacs:iso3").toUpperCase();
    const country = TARGET_ISO3[iso3];
    if (!country) continue;
    targetItems += 1;
    if (tag(block, "gdacs:iscurrent").toLowerCase() === "false") continue;
    const modifiedAt = isoDate(tag(block, "gdacs:datemodified") || tag(block, "pubDate"));
    if (modifiedAt && new Date(modifiedAt) < cutoff) {
      stale += 1;
      continue;
    }
    const eventType = tag(block, "gdacs:eventtype") || "UNKNOWN";
    const eventId = tag(block, "gdacs:eventid") || tag(block, "guid");
    const key = `${eventType}:${eventId}`;
    if (!eventId || seen.has(key)) {
      duplicate += 1;
      continue;
    }
    seen.add(key);
    const alertLevel = tag(block, "gdacs:alertlevel") || "Green";
    const title = tag(block, "title");
    const description = tag(block, "description").slice(0, 360);
    const severity = tag(block, "gdacs:severity");
    const url = tag(block, "link");
    const fromDate = isoDate(tag(block, "gdacs:fromdate"));
    alerts.push({
      event_id: key,
      event_type: eventType,
      alert_level: alertLevel,
      country,
      title,
      description,
      severity,
      url,
      from_date: fromDate,
      modified_at: modifiedAt,
      line: `[GDACS·${country}·${alertLevel}·${eventType}] ${title}` +
        `${severity ? ` - ${severity}` : ""}${description ? `；${description}` : ""}` +
        `${url ? ` | ${url}` : ""}`,
    });
  }
  const levelRank: Record<string, number> = { Red: 3, Orange: 2, Green: 1 };
  alerts.sort((a, b) =>
    (levelRank[b.alert_level] ?? 0) - (levelRank[a.alert_level] ?? 0)
    || String(b.modified_at ?? "").localeCompare(String(a.modified_at ?? "")));
  return {
    alerts: alerts.slice(0, options.maxItems),
    target_items: targetItems,
    stale,
    duplicate,
  };
}
