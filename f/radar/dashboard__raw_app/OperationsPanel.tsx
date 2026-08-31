import { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from "react";
import { backend, backendAsync, waitJob } from "./api";

type OperationItem = {
  intelligence_id: string; title: string; country: string; region: string; category: string;
  platform?: string; policy_type?: string; policy_subject?: string;
  direction: "利好" | "利空" | "混合" | "中性"; impact_score: number; urgency: string;
  effective_date?: string; impact_scope?: string; affected_dimensions?: string[];
  affected_categories?: string[]; business_impact: string; recommended_actions?: string[];
  source_name: string; source_url?: string; source_urls?: string[]; source_date?: string; authority?: string;
  verification_status?: "已确认" | "多源佐证" | "待核实";
  confidence?: number; evidence_count?: number; first_seen_at?: string; sheet_synced_at?: string;
};

type OperationResult = {
  items: OperationItem[]; total: number;
  stats?: { high: number; urgent_risk: number; countries: number };
  facets?: { countries?: string[]; categories?: string[]; directions?: string[]; urgencies?: string[] };
};

type OperationRun = {
  id: string; trigger_type: string; target_region: string; time_range: string;
  evidence_mode: string; status: string; started_at: string; intelligence_count: number; error_count: number;
};

export type OperationsPanelHandle = { refresh: () => Promise<boolean>; openScan: () => void };

function formatTime(value?: string) {
  if (!value) return "—";
  const date = new Date(value.includes("Z") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date)
    : value;
}

function Status({ status }: { status: string }) {
  const text = status === "success" ? "成功" : status === "partial" ? "部分异常" : status === "running" ? "运行中" : "失败";
  return <span className={`status status-${status}`}>{text}</span>;
}

function sourceKindLabel(kind: string) {
  return ({
    "platform-official": "平台官方公告",
    "platform-media": "跨境行业媒体",
    "platform-evidence-cache": "平台证据缓存",
    "operations-official": "国家经营官网",
    "gemini-operations": "Gemini运营分析",
    "evidence-cache": "共享新闻缓存",
    tavily: "Tavily当地媒体",
    rss: "RSS新闻订阅",
    gdacs: "GDACS灾害预警",
    "google-sheets": "Google表格写入",
    "google-sheets-history": "Google表格去重",
    dingtalk: "钉钉播报",
  } as Record<string, string>)[kind] ?? kind;
}

const initialFilters = {
  region: "", country: "", category: "", direction: "", urgency: "", min_score: 0,
  search: "", date_range: "7d", sort_by: "first_seen_at", sort_order: "desc",
};

const OperationsPanel = forwardRef<OperationsPanelHandle, { view: "intelligence" | "runs" }>(
  function OperationsPanel({ view }, ref) {
    const [filters, setFilters] = useState(initialFilters);
    const [result, setResult] = useState<OperationResult>({ items: [], total: 0 });
    const [runs, setRuns] = useState<OperationRun[]>([]);
    const [runDetail, setRunDetail] = useState<any>(null);
    const [selected, setSelected] = useState<OperationItem | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState("");
    const [scanOpen, setScanOpen] = useState(false);
    const [scanning, setScanning] = useState(false);
    const [scanProgress, setScanProgress] = useState("正在初始化...");
    const [scanForm, setScanForm] = useState({ target_region: "全部", time_range: "近3天", force_refresh: false });

    const params = (offset: number) => {
      const query: Record<string, unknown> = { ...filters, limit: 20, offset };
      if (filters.date_range !== "all") {
        const date = new Date();
        date.setDate(date.getDate() - Number(filters.date_range.replace("d", "")));
        query.date_from = date.toISOString().slice(0, 10);
      }
      return query;
    };

    const load = useCallback(async () => {
      setLoading(true); setError("");
      try {
        if (view === "runs") {
          setRuns(await backend.query_operation_runs({ limit: 30 }) as OperationRun[]);
        } else {
          const [items, recentRuns] = await Promise.all([
            backend.query_operations(params(0)) as Promise<OperationResult>,
            backend.query_operation_runs({ limit: 30 }) as Promise<OperationRun[]>,
          ]);
          setResult(items); setRuns(recentRuns);
        }
        return true;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause)); return false;
      } finally { setLoading(false); }
    }, [view, filters]);

    useEffect(() => { const timer = setTimeout(() => void load(), 160); return () => clearTimeout(timer); }, [load]);
    useImperativeHandle(ref, () => ({ refresh: load, openScan: () => void openScan() }));

    async function openScan() {
      try {
        const settings = await backend.get_settings({});
        setScanForm({
          target_region: String(settings.values.default_operations_target_region ?? "全部"),
          time_range: String(settings.values.default_operations_time_range ?? "近3天"),
          force_refresh: false,
        });
      } catch { /* 使用当前默认值 */ }
      setScanOpen(true);
    }

    async function startScan() {
      setScanning(true); setError(""); setScanProgress("正在初始化运营情报...");
      try {
        const jobId = await backendAsync.run_operations_scan(scanForm);
        await waitJob(jobId, setScanProgress);
        setScanOpen(false); await load();
      } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { setScanning(false); }
    }

    async function loadMore() {
      if (loadingMore) return;
      setLoadingMore(true);
      try {
        const next = await backend.query_operations(params(result.items.length)) as OperationResult;
        setResult({ ...next, items: [...result.items, ...next.items] });
      } finally { setLoadingMore(false); }
    }

    async function openRun(runId: string) {
      setRunDetail(null);
      try { setRunDetail(await backend.query_operation_run_detail({ run_id: runId })); }
      catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    }

    const latest = runs[0];
    return (
      <>
        <section className="hero operations-hero">
          <div><p className="eyebrow">OPERATIONS INTELLIGENCE</p><h1>看清国家电商经营环境的变化。</h1><p>聚合平台规则、费用、支付、政策、财经、税务、海关与物流变化，明确证据等级、影响和行动建议。</p></div>
          <div className="run-health"><span>最近运营任务</span>{latest ? <><Status status={latest.status} /><b>{formatTime(latest.started_at)}</b></> : <b>暂无记录</b>}</div>
        </section>
        {error && <div className="error-banner">{error}</div>}

        {view === "intelligence" ? <>
          <section className="stat-grid operations-stats">
            <article><span>筛选结果</span><strong>{result.total}</strong><small>条经营情报</small></article>
            <article><span>重大影响</span><strong>{result.stats?.high ?? 0}</strong><small>影响分 ≥ 80</small></article>
            <article><span>紧急风险</span><strong>{result.stats?.urgent_risk ?? 0}</strong><small>利空且立即处理</small></article>
            <article><span>覆盖市场</span><strong>{result.stats?.countries ?? 0}</strong><small>个国家</small></article>
          </section>
          <section className="operation-filters">
            <label className="search"><span>⌕</span><input value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })} placeholder="搜索政策、影响或建议动作" /></label>
            <select value={filters.country} onChange={(e) => setFilters({ ...filters, country: e.target.value })}><option value="">全部国家</option>{(result.facets?.countries ?? []).map((item) => <option key={item}>{item}</option>)}</select>
            <select value={filters.category} onChange={(e) => setFilters({ ...filters, category: e.target.value })}><option value="">全部类型</option>{(result.facets?.categories ?? []).map((item) => <option key={item}>{item}</option>)}</select>
            <select value={filters.direction} onChange={(e) => setFilters({ ...filters, direction: e.target.value })}><option value="">全部方向</option><option>利好</option><option>利空</option><option>混合</option><option>中性</option></select>
            <select value={filters.urgency} onChange={(e) => setFilters({ ...filters, urgency: e.target.value })}><option value="">全部紧急度</option><option>立即处理</option><option>近期关注</option><option>长期观察</option></select>
            <select value={filters.min_score} onChange={(e) => setFilters({ ...filters, min_score: Number(e.target.value) })}><option value={0}>全部影响分</option><option value={60}>60分以上</option><option value={80}>80分以上</option></select>
            <select value={filters.date_range} onChange={(e) => setFilters({ ...filters, date_range: e.target.value })}><option value="all">所有时间</option><option value="7d">最近7天</option><option value="30d">最近30天</option><option value="90d">最近90天</option></select>
            <button className="clear" onClick={() => setFilters(initialFilters)}>清除</button>
          </section>
          <section className="panel">
            <div className="panel-title"><div><span className="live-dot" />运营情报库</div><small>{loading ? "正在读取…" : `当前显示 ${result.items.length} 条`}</small></div>
            {!loading && !result.items.length && <div className="empty">还没有运营情报。点击右上角“立即扫描”生成第一批数据。</div>}
            {result.items.map((item) => <button className="operation-row" key={item.intelligence_id} onClick={() => setSelected(item)}>
              <div className={`operation-score direction-${item.direction}`}><strong>{item.impact_score}</strong><span>影响分</span></div>
              <div className="operation-main"><div className="operation-heading"><h3>{item.title}</h3><span className={`direction-pill direction-${item.direction}`}>{item.direction}</span>{item.platform && <span className="platform-pill">{item.platform}</span>}<span className="category-pill">{item.category}</span>{item.verification_status && <span className={`verification-pill verification-${item.verification_status}`}>{item.verification_status}</span>}</div><p>{item.business_impact}</p><div className="meta"><span>◉ {item.country}</span><span>{item.urgency}</span><span>{item.effective_date ? `生效：${item.effective_date}` : "持续观察"}</span><span>{item.source_name}</span></div></div>
              <div className="operation-actions-preview">{(item.recommended_actions ?? []).slice(0, 2).map((action, index) => <span key={index}>{action}</span>)}</div><span className="chevron">›</span>
            </button>)}
            {result.items.length < result.total && <button className="load-more ghost" onClick={loadMore} disabled={loadingMore}>{loadingMore ? "正在加载…" : "加载更多"}</button>}
          </section>
        </> : <section className="runs-layout">
          <div className="panel run-list-panel"><div className="panel-title"><div>运营情报扫描</div><small>最近 {runs.length} 次</small></div>{runs.map((run) => <button className={`run-row ${runDetail?.run?.id === run.id ? "selected" : ""}`} key={run.id} onClick={() => openRun(run.id)}><div><Status status={run.status} /><strong>{formatTime(run.started_at)}</strong></div><p>{run.target_region} · {run.time_range} · {run.evidence_mode === "reused" ? "复用证据" : "重新采集"}</p><small>{run.intelligence_count}条新情报 · {run.error_count}个异常</small></button>)}</div>
          <div className="panel run-detail">{!runDetail ? <div className="empty">选择一次运行，查看证据采集、逐国分析及同步状态。</div> : <><div className="panel-title"><div>运营证据链与运行健康</div><Status status={runDetail.run.status} /></div><div className="detail-summary"><span>来源步骤 <b>{runDetail.sources.length}</b></span><span>新增情报 <b>{runDetail.items.length}</b></span><span>证据模式 <b>{runDetail.run.evidence_mode === "reused" ? "复用" : "新采"}</b></span></div><div className="source-table"><div className="source-head"><span>类型</span><span>国家或来源</span><span>条数</span><span>状态</span></div>{runDetail.sources.map((source: any, index: number) => <div className="source-row" key={`${source.request_key}-${index}`}><span>{sourceKindLabel(source.source_kind)}</span><span>{source.country || source.source_name || "—"}</span><span>{source.item_count}</span><Status status={source.status} />{source.error && <small>{source.error}</small>}</div>)}</div></>}</div>
        </section>}

        {selected && <div className="modal-backdrop" onMouseDown={() => setSelected(null)}><aside className="drawer operation-drawer" onMouseDown={(e) => e.stopPropagation()}><button className="close" onClick={() => setSelected(null)}>×</button><div className="drawer-score"><span>运营影响分</span><strong>{selected.impact_score}</strong></div><div className="operation-badges"><span className={`direction-pill direction-${selected.direction}`}>{selected.direction}</span>{selected.platform && <span className="platform-pill">{selected.platform}</span>}<span className="category-pill">{selected.category}</span><span className="urgency-pill">{selected.urgency}</span>{selected.verification_status && <span className={`verification-pill verification-${selected.verification_status}`}>{selected.verification_status}</span>}</div><h2>{selected.title}</h2><div className="meta large"><span>📍 {selected.country}</span><span className="divider">|</span><span>{selected.effective_date ? `📅 ${selected.effective_date}` : "📅 持续观察"}</span>{selected.policy_type && <><span className="divider">|</span><span>{selected.policy_type}</span></>}</div><div className="insight"><span>💼 对经营的影响</span><p>{selected.business_impact}</p></div><h3 className="section-head">✅ 建议行动</h3><ol className="action-list">{(selected.recommended_actions ?? []).map((action, index) => <li key={index}>{action}</li>)}</ol><h3 className="section-head">影响范围</h3><p className="operation-detail-text">{selected.impact_scope || "未限定"}</p><div className="tag-list">{[...(selected.affected_dimensions ?? []), ...(selected.affected_categories ?? [])].map((tag) => <span key={tag}>{tag}</span>)}</div><div className="source-proof"><b>证据来源</b><span>{selected.source_name} · {selected.authority || "待判断"} · 可信度{selected.confidence ?? 0}</span>{[...new Set(selected.source_urls?.length ? selected.source_urls : selected.source_url ? [selected.source_url] : [])].map((url, index) => <a key={url} href={url} target="_blank" rel="noreferrer">{index === 0 ? "查看主证据" : `查看佐证 ${index + 1}`}</a>)}</div></aside></div>}

        {scanOpen && <div className="modal-backdrop" onMouseDown={() => !scanning && setScanOpen(false)}><section className="scan-modal" onMouseDown={(e) => e.stopPropagation()}><button className="close" onClick={() => setScanOpen(false)} disabled={scanning}>×</button><p className="eyebrow">OPERATIONS RUN</p><h2>扫描运营情报</h2><p>同时采集国家经营环境和平台规则变化；平台官方公告优先，行业媒体负责发现与交叉佐证。</p><label>目标区域<select value={scanForm.target_region} onChange={(e) => setScanForm({ ...scanForm, target_region: e.target.value })}><option>全部</option><option>东南亚</option><option>拉美</option></select></label><label>新闻时间范围<select value={scanForm.time_range} onChange={(e) => setScanForm({ ...scanForm, time_range: e.target.value })}><option>今天</option><option>近3天</option><option>本周</option><option>本月</option></select></label><label className="toggle-field compact-toggle"><span><b>强制重新采集</b><small>开启后不复用证据，会重新请求Tavily、RSS、平台官方页和行业媒体</small></span><input type="checkbox" checked={scanForm.force_refresh} onChange={(e) => setScanForm({ ...scanForm, force_refresh: e.target.checked })} /></label><button className="primary scan-submit" disabled={scanning} onClick={startScan}>{scanning ? scanProgress : "开始扫描"}</button></section></div>}
      </>
    );
  },
);

export default OperationsPanel;
