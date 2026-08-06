import { useCallback, useEffect, useMemo, useState } from "react";
import { backend, backendAsync, waitJob } from "./api";

type Product = {
  name?: string;
  category?: string;
  price_range?: string;
  keywords_en?: string[];
  keywords_local?: string[];
};

type EventItem = {
  event_id: string;
  event_name: string;
  event_type?: string;
  country?: string;
  region?: string;
  date?: string;
  stage?: string;
  source?: string;
  source_line: "假日" | "媒体" | "网页";
  ecommerce_score: number;
  products?: Product[];
  best_listing_time?: string;
  why_sellable?: string;
  first_seen_at?: string;
};

type RunItem = {
  id: string;
  trigger_type: string;
  target_region: string;
  time_range: string;
  data_lines: string;
  status: string;
  started_at: string;
  event_count: number;
  error_count: number;
};

type QueryResult = {
  items: EventItem[];
  total: number;
  facets?: { regions?: string[]; countries?: string[]; stages?: string[] };
};

const initialFilters = {
  region: "",
  country: "",
  source_line: "",
  stage: "",
  min_score: 0,
  search: "",
};

function formatTime(value?: string) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function StatusPill({ status }: { status: string }) {
  const text = status === "success" ? "成功" : status === "partial" ? "部分异常" : status === "running" ? "运行中" : "失败";
  return <span className={`status status-${status}`}>{text}</span>;
}

export default function App() {
  const [filters, setFilters] = useState(initialFilters);
  const [result, setResult] = useState<QueryResult>({ items: [], total: 0 });
  const [runs, setRuns] = useState<RunItem[]>([]);
  const [selected, setSelected] = useState<EventItem | null>(null);
  const [runDetail, setRunDetail] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"events" | "runs">("events");
  const [scanOpen, setScanOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanForm, setScanForm] = useState({
    target_region: "全部",
    time_range: "未来3个月",
    data_lines: "全部",
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [eventsData, runsData] = await Promise.all([
        backend.query_events({ ...filters, limit: 200, offset: 0 }),
        backend.query_runs({ limit: 30 }),
      ]);
      setResult(eventsData as QueryResult);
      setRuns(runsData as RunItem[]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    const timer = setTimeout(load, 180);
    return () => clearTimeout(timer);
  }, [load]);

  const stats = useMemo(() => {
    const high = result.items.filter((item) => item.ecommerce_score >= 80).length;
    const countries = new Set(result.items.map((item) => item.country).filter(Boolean)).size;
    const latest = runs[0];
    return { high, countries, latest };
  }, [result.items, runs]);

  async function openRun(runId: string) {
    setRunDetail(null);
    setError("");
    try {
      setRunDetail(await backend.query_run_detail({ run_id: runId }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function startScan() {
    setScanning(true);
    setError("");
    try {
      const jobId = await backendAsync.run_scan(scanForm);
      await waitJob(jobId);
      setScanOpen(false);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setScanning(false);
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">R</span>
          <div>
            <strong>热点选品雷达</strong>
            <small>SEA · LATAM intelligence</small>
          </div>
        </div>
        <nav>
          <button className={tab === "events" ? "nav-active" : ""} onClick={() => setTab("events")}>机会库</button>
          <button className={tab === "runs" ? "nav-active" : ""} onClick={() => setTab("runs")}>运行记录</button>
        </nav>
        <div className="header-actions">
          <button className="ghost" onClick={load}>刷新</button>
          <button className="primary" onClick={() => setScanOpen(true)}>＋ 立即扫描</button>
        </div>
      </header>

      <main>
        <section className="hero">
          <div>
            <p className="eyebrow">PRODUCT SIGNALS / V8</p>
            <h1>把新闻、节日和赛事，变成可上架的商品机会。</h1>
            <p>逐站采集、逐国分析，保留每条证据链。团队在同一个页面查看结果与运行健康度。</p>
          </div>
          <div className="run-health">
            <span>最近任务</span>
            {stats.latest ? <><StatusPill status={stats.latest.status} /><b>{formatTime(stats.latest.started_at)}</b></> : <b>暂无记录</b>}
          </div>
        </section>

        {error && <div className="error-banner">{error}</div>}

        <section className="stat-grid">
          <article><span>筛选结果</span><strong>{result.total}</strong><small>个选品事件</small></article>
          <article><span>高潜机会</span><strong>{stats.high}</strong><small>评分 ≥ 80</small></article>
          <article><span>覆盖市场</span><strong>{stats.countries}</strong><small>个国家</small></article>
          <article><span>采集设计</span><strong>3</strong><small>条独立线路</small></article>
        </section>

        {tab === "events" ? (
          <>
            <section className="filters">
              <label className="search"><span>⌕</span><input value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })} placeholder="搜索事件或推荐理由" /></label>
              <select value={filters.region} onChange={(e) => setFilters({ ...filters, region: e.target.value, country: "" })}>
                <option value="">全部区域</option><option>东南亚</option><option>拉美</option>
              </select>
              <select value={filters.country} onChange={(e) => setFilters({ ...filters, country: e.target.value })}>
                <option value="">全部国家</option>
                {(result.facets?.countries ?? []).sort().map((country) => <option key={country}>{country}</option>)}
              </select>
              <select value={filters.source_line} onChange={(e) => setFilters({ ...filters, source_line: e.target.value })}>
                <option value="">全部线路</option><option>假日</option><option>媒体</option><option>网页</option>
              </select>
              <select value={filters.min_score} onChange={(e) => setFilters({ ...filters, min_score: Number(e.target.value) })}>
                <option value={0}>全部评分</option><option value={60}>60 分以上</option><option value={80}>80 分以上</option>
              </select>
              <button className="clear" onClick={() => setFilters(initialFilters)}>清除</button>
            </section>

            <section className="panel">
              <div className="panel-title"><div><span className="live-dot" />实时机会库</div><small>{loading ? "正在读取…" : `当前显示 ${result.items.length} 条`}</small></div>
              <div className="event-list">
                {!loading && result.items.length === 0 && <div className="empty">还没有匹配结果。可以点击“立即扫描”生成第一批数据。</div>}
                {result.items.map((item) => (
                  <button className="event-row" key={item.event_id} onClick={() => setSelected(item)}>
                    <div className={`score score-${item.ecommerce_score >= 80 ? "hot" : item.ecommerce_score >= 60 ? "warm" : "normal"}`}>
                      <strong>{item.ecommerce_score}</strong><span>分</span>
                    </div>
                    <div className="event-main">
                      <div className="event-heading"><h3>{item.event_name}</h3><span className={`line line-${item.source_line}`}>{item.source_line}</span></div>
                      <p>{item.why_sellable || "暂无推荐理由"}</p>
                      <div className="meta"><span>◉ {item.country || "未知"}</span><span>◷ {item.date || "待定"}</span><span>{item.stage || "待分析"}</span><span>{item.source}</span></div>
                    </div>
                    <div className="products-preview">
                      {(item.products ?? []).slice(0, 2).map((product, index) => <span key={`${product.name}-${index}`}>{product.name}</span>)}
                    </div>
                    <span className="chevron">›</span>
                  </button>
                ))}
              </div>
            </section>
          </>
        ) : (
          <section className="runs-layout">
            <div className="panel run-list-panel">
              <div className="panel-title"><div>扫描运行</div><small>最近 {runs.length} 次</small></div>
              {runs.map((run) => (
                <button className={`run-row ${runDetail?.run?.id === run.id ? "selected" : ""}`} key={run.id} onClick={() => openRun(run.id)}>
                  <div><StatusPill status={run.status} /><strong>{formatTime(run.started_at)}</strong></div>
                  <p>{run.target_region} · {run.time_range} · {run.data_lines}</p>
                  <small>{run.event_count} 个新事件 · {run.error_count} 个异常</small>
                </button>
              ))}
            </div>
            <div className="panel run-detail">
              {!runDetail ? <div className="empty">选择一次运行，查看每个国家、站点、Gemini、体育搜索和消息发送状态。</div> : (
                <>
                  <div className="panel-title"><div>证据链与运行健康</div><StatusPill status={runDetail.run.status} /></div>
                  <div className="detail-summary"><span>来源请求 <b>{runDetail.sources.length}</b></span><span>体育专题 <b>{runDetail.sports.length}</b></span><span>新增事件 <b>{runDetail.events.length}</b></span></div>
                  <div className="source-table">
                    <div className="source-head"><span>线路 / 类型</span><span>国家或来源</span><span>条数</span><span>状态</span></div>
                    {runDetail.sources.map((source: any, index: number) => (
                      <div className="source-row" key={`${source.request_key}-${index}`}>
                        <span>{source.source_line} · {source.source_kind}</span>
                        <span>{source.country || source.source_name || "—"}</span>
                        <span>{source.item_count}</span>
                        <StatusPill status={source.status} />
                        {source.error && <small>{source.error}</small>}
                      </div>
                    ))}
                  </div>
                  {runDetail.sports.length > 0 && <div className="sports-block"><h3>体育搜索保留结果</h3>{runDetail.sports.map((sport: any) => <article key={sport.query}><b>{sport.source_name}</b><p>{sport.answer || sport.query}</p></article>)}</div>}
                </>
              )}
            </div>
          </section>
        )}
      </main>

      {selected && (
        <div className="modal-backdrop" onMouseDown={() => setSelected(null)}>
          <aside className="drawer" onMouseDown={(e) => e.stopPropagation()}>
            <button className="close" onClick={() => setSelected(null)}>×</button>
            <div className="drawer-score"><span>电商机会分</span><strong>{selected.ecommerce_score}</strong></div>
            <span className={`line line-${selected.source_line}`}>{selected.source_line}线路</span>
            <h2>{selected.event_name}</h2>
            <div className="meta large"><span>◉ {selected.country}</span><span>◷ {selected.date}</span><span>{selected.stage}</span></div>
            <div className="insight"><span>为什么值得卖</span><p>{selected.why_sellable || "暂无"}</p></div>
            <h3>推荐选品</h3>
            <div className="product-cards">{(selected.products ?? []).map((product, index) => <article key={`${product.name}-${index}`}><span>{String(index + 1).padStart(2, "0")}</span><div><b>{product.name}</b><small>{product.category} · {product.price_range}</small><p>{[...(product.keywords_en ?? []), ...(product.keywords_local ?? [])].slice(0, 5).map((keyword) => `#${keyword}`).join("  ")}</p></div></article>)}</div>
            <div className="listing-time"><span>最佳上架时间</span><b>{selected.best_listing_time || "待分析"}</b></div>
          </aside>
        </div>
      )}

      {scanOpen && (
        <div className="modal-backdrop" onMouseDown={() => !scanning && setScanOpen(false)}>
          <section className="scan-modal" onMouseDown={(e) => e.stopPropagation()}>
            <button className="close" onClick={() => setScanOpen(false)} disabled={scanning}>×</button>
            <p className="eyebrow">MANUAL RUN</p><h2>启动一次完整扫描</h2><p>会按原流程运行所选线路，并继续写 Google Sheets、发送对应的独立钉钉消息。</p>
            <label>目标区域<select value={scanForm.target_region} onChange={(e) => setScanForm({ ...scanForm, target_region: e.target.value })}><option>全部</option><option>东南亚</option><option>拉美</option></select></label>
            <label>时间范围<select value={scanForm.time_range} onChange={(e) => setScanForm({ ...scanForm, time_range: e.target.value })}><option>今天</option><option>近3天</option><option>本周</option><option>本月</option><option>未来3个月</option></select></label>
            <label>数据线路<select value={scanForm.data_lines} onChange={(e) => setScanForm({ ...scanForm, data_lines: e.target.value })}><option>全部</option><option>媒体+网页</option><option>仅假日</option><option>仅媒体</option><option>仅网页</option><option>假日+网页</option><option>假日+媒体</option></select></label>
            <button className="primary scan-submit" disabled={scanning} onClick={startScan}>{scanning ? "扫描运行中，请保持页面打开…" : "开始扫描"}</button>
          </section>
        </div>
      )}
    </div>
  );
}
