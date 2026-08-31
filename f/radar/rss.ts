export interface ParsedRssArticle {
  title: string;
  description: string;
  url: string;
  published_at?: string;
  line: string;
}

function decodeXml(value: string) {
  return value
    .replace(/^<!\[CDATA\[|\]\]>$/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .trim();
}

function tagValue(block: string, names: string[]) {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = block.match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, "i"));
    if (match?.[1]) return decodeXml(match[1]);
  }
  return "";
}

function linkValue(block: string) {
  const text = tagValue(block, ["link"]);
  if (/^https?:\/\//i.test(text)) return text;
  return decodeXml(block.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\/?\s*>/i)?.[1] ?? "");
}

function cleanText(value: string, maxLength: number) {
  return decodeXml(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function dateIso(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function titleKey(value: string) {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function parseRss(
  xml: string,
  options: {
    sourceName: string;
    country?: string;
    currentDate: string;
    maxAgeDays: number;
    seenTitles: Set<string>;
    maxItems?: number;
  },
) {
  const itemBlocks = xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi)
    ?? xml.match(/<entry\b[^>]*>[\s\S]*?<\/entry>/gi)
    ?? [];
  const cutoff = new Date(`${options.currentDate}T23:59:59Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - options.maxAgeDays);
  const articles: ParsedRssArticle[] = [];
  let stale = 0;
  let invalid = 0;
  let duplicate = 0;
  for (const block of itemBlocks) {
    const title = cleanText(tagValue(block, ["title"]), 300);
    const description = cleanText(
      tagValue(block, ["description", "summary", "content:encoded", "content"]),
      320,
    );
    const url = linkValue(block) || tagValue(block, ["guid", "id"]);
    const published = dateIso(tagValue(block, ["pubDate", "published", "updated", "dc:date"]));
    if (published && new Date(published) < cutoff) {
      stale += 1;
      continue;
    }
    const key = titleKey(title);
    if (title.length < 6 || !key) {
      invalid += 1;
      continue;
    }
    if (options.seenTitles.has(key)) {
      duplicate += 1;
      continue;
    }
    options.seenTitles.add(key);
    const metadata = [options.country, published?.slice(0, 10)].filter(Boolean).join("/");
    articles.push({
      title,
      description,
      url,
      published_at: published,
      line: `[${options.sourceName}${metadata ? `·${metadata}` : ""}] ${title}` +
        `${description ? ` - ${description}` : ""}${url ? ` | ${url}` : ""}`,
    });
    if (articles.length >= (options.maxItems ?? 50)) break;
  }
  return { articles, total: itemBlocks.length, stale, invalid, duplicate };
}
