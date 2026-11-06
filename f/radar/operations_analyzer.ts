import crypto from "node:crypto";
import { callGeminiResponse, geminiFailurePayload, parseGeminiArray } from "./gemini_client.ts";
import { mapLimit, normalizeDate } from "./lib.ts";
import { isConcreteArticleUrl } from "./web_search.ts";
import type {
  EvidenceItem,
  OperationDirection,
  OperationIntelligence,
  OperationUrgency,
  RadarConfig,
  SourceExecutionRecord,
} from "./types.ts";

const directions = new Set<OperationDirection>(["利好", "利空", "混合", "中性"]);
const urgencies = new Set<OperationUrgency>(["立即处理", "近期关注", "长期观察"]);
const categories = new Set([
  "平台规则与费用",
  "关税与海关",
  "税务与财政",
  "法规与合规",
  "宏观经济",
  "汇率与支付",
  "消费与零售",
  "物流与履约",
  "供应链",
  "政治与经营安全",
  "电商基础设施",
  "其他经营环境",
]);
const platforms = new Set(["Shopee", "Lazada", "TikTok Shop", "Mercado Libre", "Walmart", "Amazon", "其他平台"]);
const policyTypes = new Set([
  "佣金与交易费", "支付方式", "物流与履约", "促销与流量", "商品与合规",
  "账户与处罚", "入驻与店铺", "平台服务", "其他平台变化",
]);

function strings(value: unknown, max = 8): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item).trim()).filter(Boolean).slice(0, max)
    : [];
}

function legacyStableId(country: string, title: string, effectiveDate: string) {
  const digest = crypto.createHash("sha256")
    .update(`${country}|${title.toLowerCase().replace(/\s+/g, " ").trim()}|${effectiveDate}`)
    .digest("hex").slice(0, 16);
  return `OPS_${digest.toUpperCase()}`;
}

function normalizedKey(value: string) {
  return value.toLowerCase().replace(/[^\p{L}\p{N}%]+/gu, " ").replace(/\s+/g, " ").trim();
}

function percentSignature(value: string) {
  return [...new Set((value.match(/\d+(?:\.\d+)?\s*%/g) ?? [])
    .map((item) => item.replace(/\s+/g, "")))]
    .sort((a, b) => Number.parseFloat(a) - Number.parseFloat(b))
    .join(",");
}

export function platformIntelligenceId(
  country: string,
  platform: string,
  policyType: string,
  effectiveDate: string,
  policySubject: string,
  detailText: string,
) {
  const changeSignature = percentSignature(detailText) || normalizedKey(policySubject).slice(0, 120);
  const digest = crypto.createHash("sha256")
    .update(`${country}|${platform}|${policyType}|${effectiveDate}|${changeSignature}`)
    .digest("hex").slice(0, 16);
  return `OPS_${digest.toUpperCase()}`;
}

export function verificationForEvidence(evidence: EvidenceItem[]) {
  const official = evidence.some((item) =>
    ["platform-official", "operations-official", "gdacs"].includes(item.source_kind));
  const publisherCount = new Set(evidence.map((item) => item.publisher)).size;
  if (official) return "已确认" as const;
  if (publisherCount >= 2) return "多源佐证" as const;
  return "待核实" as const;
}

export function normalizeOperationItems(
  rawItems: Array<Record<string, unknown>>,
  country: string,
  region: string,
  evidence: EvidenceItem[],
  historyIds: Set<string>,
): OperationIntelligence[] {
  const evidenceByUrl = new Map(evidence.map((item) => [item.url, item]));
  const seen = new Set<string>();
  const output: OperationIntelligence[] = [];
  for (const raw of rawItems) {
    const title = String(raw.title ?? "").trim();
    const sourceUrls = [...new Set([
      ...strings(raw.source_urls, 8),
      String(raw.source_url ?? "").trim(),
    ].filter(Boolean))];
    const relatedSources = sourceUrls
      .map((url) => evidenceByUrl.get(url))
      .filter((item): item is EvidenceItem => Boolean(item))
      .filter((item) => Boolean(item.published_at) && isConcreteArticleUrl(item.url));
    const sortedSources = relatedSources.sort((a, b) => {
      const rank = (item: EvidenceItem) => item.source_kind === "platform-official" ? 0
        : item.authority.includes("一级线索") ? 1 : item.authority.includes("二级线索") ? 3 : 2;
      return rank(a) - rank(b);
    });
    const source = sortedSources[0];
    const businessImpact = String(raw.business_impact ?? "").trim();
    if (title.length < 6 || !source || businessImpact.length < 12) continue;
    const direction = directions.has(raw.direction as OperationDirection)
      ? raw.direction as OperationDirection : "中性";
    const urgency = urgencies.has(raw.urgency as OperationUrgency)
      ? raw.urgency as OperationUrgency : "长期观察";
    const effectiveDate = normalizeDate(raw.effective_date) ?? "";
    const platform = platforms.has(String(raw.platform ?? "")) ? String(raw.platform) : "";
    const policyType = policyTypes.has(String(raw.policy_type ?? ""))
      ? String(raw.policy_type) : "其他平台变化";
    const policySubject = String(raw.policy_subject ?? "").trim() || title;
    const intelligence_id = platform
      ? platformIntelligenceId(country, platform, policyType, effectiveDate, policySubject, `${title} ${businessImpact}`)
      : legacyStableId(country, title, effectiveDate);
    if (historyIds.has(intelligence_id) || seen.has(intelligence_id)) continue;
    seen.add(intelligence_id);
    const verificationStatus = verificationForEvidence(sortedSources);
    const confidenceCap = verificationStatus === "已确认" ? 100
      : verificationStatus === "多源佐证" ? 85 : 65;
    output.push({
      ...raw,
      intelligence_id,
      title,
      country,
      region,
      platform: platform || undefined,
      policy_type: platform ? policyType : undefined,
      policy_subject: platform ? policySubject : undefined,
      category: categories.has(String(raw.category ?? ""))
        ? String(raw.category)
        : "其他经营环境",
      direction,
      impact_score: Math.max(0, Math.min(100, Number(raw.impact_score ?? 0))),
      urgency,
      effective_date: effectiveDate || undefined,
      impact_scope: String(raw.impact_scope ?? "").trim() || undefined,
      affected_dimensions: [...new Set([
        ...(platform ? [platform] : []),
        ...strings(raw.affected_dimensions),
      ])].slice(0, 8),
      affected_categories: strings(raw.affected_categories),
      business_impact: businessImpact,
      recommended_actions: strings(raw.recommended_actions, 6),
      source_name: [...new Set(sortedSources.map((item) => item.publisher))].join("、"),
      source_url: source.url,
      source_urls: sortedSources.map((item) => item.url),
      source_date: source.published_at?.slice(0, 10),
      authority: `${verificationStatus} · ${source.authority}`,
      verification_status: verificationStatus,
      confidence: Math.max(0, Math.min(confidenceCap, Number(raw.confidence ?? 0))),
      evidence_count: sortedSources.length,
    });
  }
  return output.sort((a, b) => b.impact_score - a.impact_score).slice(0, 12);
}

export async function analyzeOperations(
  config: RadarConfig,
  input: {
    currentDate: string;
    targetCountries: string[];
    evidence: EvidenceItem[];
    historyIds: string[];
    onProgress?: (message: string) => void;
  },
): Promise<{ items: OperationIntelligence[]; executions: SourceExecutionRecord[] }> {
  const historyIds = new Set(input.historyIds);
  const runs = await mapLimit(input.targetCountries, config.country_concurrency, async (country) => {
    const countryEvidence = input.evidence.filter((item) => item.country === country).slice(0, 60);
    const region = countryEvidence[0]?.region ?? "";
    if (!countryEvidence.length) {
      return {
        items: [] as OperationIntelligence[],
        execution: {
          source_line: "运营",
          source_kind: "gemini-operations",
          country,
          source_name: config.gemini_model,
          request_key: `operations:gemini:${country}`,
          status: "partial",
          item_count: 0,
          error: "该国家没有近期共享新闻证据",
        } satisfies SourceExecutionRecord,
      };
    }
    input.onProgress?.(`正在分析运营环境：${country}`);
    const evidenceText = countryEvidence.map((item, index) =>
      `${index + 1}. [${item.authority}/${item.publisher}/${item.acquisition_method}]` +
      `${item.published_at ? ` ${item.published_at.slice(0, 10)}` : ""} ${item.title} - ${item.summary.slice(0, 420)} | ${item.url}`,
    ).join("\n");
    const prompt = `你是跨境电商运营情报分析师。今天是${input.currentDate}，分析国家：${country}。

只保留会明确影响该国跨境电商经营环境的已发生事实或已公布政策：平台佣金和交易费、卖家规则、支付方式、物流履约、商品合规、关税与海关、税务、进出口准入、法规合规、宏观经济、通胀与汇率、消费能力、跨境支付、物流港口、供应链、政治或社会事件造成的经营影响、电商基础设施。普通政治新闻、官员讲话、个股新闻、没有明确电商因果关系的GDP报道全部忽略。

不要推荐商品。不要补充证据中没有的事实。没有明确近期发布日期、生效日期或具体变化内容的帮助中心常驻页面只能作为背景，不能单独生成情报。同一平台、国家、政策类型、生效日期和费率变化必须合并成一条，不能因为不同网站标题不同而重复输出。转载同一篇原稿不能假装成独立证据。source_url和source_urls中的每个URL都必须逐字复制下方证据URL；优先把平台官方URL放在source_url，无法找到可验证URL就不要输出。category只能是：平台规则与费用、关税与海关、税务与财政、法规与合规、宏观经济、汇率与支付、消费与零售、物流与履约、供应链、政治与经营安全、电商基础设施、其他经营环境。若属于平台变化，platform只能是Shopee、Lazada、TikTok Shop、Mercado Libre、Walmart、Amazon、其他平台；policy_type只能是佣金与交易费、支付方式、物流与履约、促销与流量、商品与合规、账户与处罚、入驻与店铺、平台服务、其他平台变化；policy_subject填写稳定简短的变化主题。每条输出：title, category, platform(不属于平台变化则空), policy_type, policy_subject, direction(利好/利空/混合/中性), impact_score(0-100), urgency(立即处理/近期关注/长期观察), effective_date(YYYY-MM-DD或空), impact_scope, affected_dimensions(数组), affected_categories(数组), business_impact, recommended_actions(数组), source_url, source_urls(同一事实的独立证据URL数组), confidence(0-100)。只输出纯JSON：{"intelligence":[]}，最多12条，影响分低于40不要输出。

新闻证据：
${evidenceText.slice(0, 18000)}`;
    try {
      const response = await callGeminiResponse(config, prompt, { arrayField: "intelligence", onProgress: input.onProgress });
      const rawText = response.text;
      const rawItems = parseGeminiArray(rawText, "intelligence");
      const items = normalizeOperationItems(rawItems, country, region, countryEvidence, historyIds);
      return {
        items,
        execution: {
          source_line: "运营",
          source_kind: "gemini-operations",
          country,
          source_name: config.gemini_model,
          request_key: `operations:gemini:${country}`,
          status: items.length ? "success" : "partial",
          item_count: items.length,
          request_payload: { evidence_count: countryEvidence.length },
          response_payload: { text: rawText, metadata: response.metadata },
          error: items.length ? undefined
            : rawItems.length
              ? "Gemini输出了候选内容，但没有通过来源URL或必填字段校验"
              : "Gemini判断现有证据没有明确的跨境电商经营影响",
        } satisfies SourceExecutionRecord,
      };
    } catch (error) {
      return {
        items: [] as OperationIntelligence[],
        execution: {
          source_line: "运营",
          source_kind: "gemini-operations",
          country,
          source_name: config.gemini_model,
          request_key: `operations:gemini:${country}`,
          status: "failed",
          response_payload: geminiFailurePayload(error),
          item_count: 0,
          error: error instanceof Error ? error.message : String(error),
        } satisfies SourceExecutionRecord,
      };
    }
  });
  return {
    items: runs.flatMap((run) => run.items),
    executions: runs.map((run) => run.execution),
  };
}
