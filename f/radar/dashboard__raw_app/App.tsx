import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { backend, backendAsync, waitJob } from "./api";
import SettingsPanel, { type SettingsPanelHandle } from "./SettingsPanel";
import OperationsPanel, { type OperationsPanelHandle } from "./OperationsPanel";
import sourceCatalog from "../../../config/source_catalog.json";

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
  stats?: { high: number; countries: number };
  facets?: { regions?: string[]; countries?: string[]; stages?: string[] };
};

const initialFilters = {
  region: "",
  country: "",
  source_line: "",
  stage: "",
  min_score: 0,
  search: "",
  date_range: "7d",
  sort_by: "event_date",
  sort_order: "desc",
};

function formatTime(value?: string) {
  if (!value) return "—";
  // Convert SQLite timestamp (UTC) to a valid ISO string so the browser localizes it
  const dateStr = value.includes("Z") ? value : value.replace(" ", "T") + "Z";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(dateStr));
}

function namedProducts(products?: Product[]) {
  return (products ?? []).filter((product) => product.name?.trim());
}

function StatusPill({ status }: { status: string }) {
  const text = status === "success" ? "成功" : status === "partial" ? "部分异常" : status === "running" ? "运行中" : "失败";
  return <span className={`status status-${status}`}>{text}</span>;
}

export default function App() {
  const [module, setModule] = useState<"product" | "operations">("product");
  const [filters, setFilters] = useState(initialFilters);
  const [result, setResult] = useState<QueryResult>({ items: [], total: 0 });
  const [runs, setRuns] = useState<RunItem[]>([]);
  const [selected, setSelected] = useState<EventItem | null>(null);
  const [runDetail, setRunDetail] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"events" | "runs" | "settings">("events");
  const [operationsTab, setOperationsTab] = useState<"intelligence" | "runs" | "settings">("intelligence");
  const [scanOpen, setScanOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState("扫描运行中，请保持页面打开...");
  const [scanForm, setScanForm] = useState({
    target_region: "全部",
    time_range: "未来3个月",
    data_lines: "全部",
  });
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNotice, setRefreshNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const settingsRef = useRef<SettingsPanelHandle>(null);
  const operationsRef = useRef<OperationsPanelHandle>(null);
  const refreshNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const buildQueryParams = (offset: number) => {
    const queryParams: any = { ...filters, limit: 20, offset };
    if (filters.date_range) {
      const d = new Date();
      if (filters.date_range === "7d") d.setDate(d.getDate() - 7);
      else if (filters.date_range === "30d") d.setDate(d.getDate() - 30);
      else if (filters.date_range === "90d") d.setDate(d.getDate() - 90);
      if (filters.date_range !== "all") {
        queryParams.date_from = d.toISOString().split("T")[0];
      }
    }
    return queryParams;
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [eventsData, runsData] = await Promise.all([
        backend.query_events(buildQueryParams(0)),
        backend.query_runs({ limit: 30 }),
      ]);
      const res = eventsData as QueryResult;
      setResult(res);
      setHasMore(res.items.length < res.total);
      setRuns(runsData as RunItem[]);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setLoading(false);
    }
  }, [filters]);

  async function loadMore() {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const eventsData = await backend.query_events(buildQueryParams(result.items.length)) as QueryResult;
      setResult({
        ...eventsData,
        items: [...result.items, ...eventsData.items],
      });
      setHasMore(result.items.length + eventsData.items.length < eventsData.total);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    const timer = setTimeout(load, 180);
    return () => clearTimeout(timer);
  }, [load]);

  useEffect(() => () => {
    if (refreshNoticeTimer.current) clearTimeout(refreshNoticeTimer.current);
  }, []);

  const stats = useMemo(() => {
    const high = result.stats?.high ?? result.items.filter((item) => item.ecommerce_score >= 80).length;
    const countries = result.stats?.countries ?? new Set(result.items.map((item) => item.country).filter(Boolean)).size;
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
    setScanProgress("正在初始化...");
    setError("");
    try {
      const jobId = await backendAsync.run_scan(scanForm);
      await waitJob(jobId, setScanProgress);
      setScanOpen(false);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setScanning(false);
    }
  }

  async function openScan() {
    try {
      const settings = await backend.get_settings({});
      setScanForm({
        target_region: String(settings.values.default_target_region),
        time_range: String(settings.values.default_time_range),
        data_lines: String(settings.values.default_manual_data_lines),
      });
    } catch {
      // Existing defaults remain usable when settings cannot be loaded.
    }
    setScanOpen(true);
  }

  function openOperationsScan() {
    if (operationsTab !== "settings") {
      operationsRef.current?.openScan();
      return;
    }
    setOperationsTab("intelligence");
    window.setTimeout(() => operationsRef.current?.openScan(), 0);
  }

  async function refreshCurrentPage() {
    if (refreshing) return;
    const minimumProgressTime = new Promise((resolve) => setTimeout(resolve, 450));
    setRefreshing(true);
    setRefreshNotice(null);
    setError("");

    let succeeded = false;
    let pageName = "当前页面";
    try {
      if (module === "operations") {
        if (operationsTab === "settings") {
          pageName = "运营情报设置";
          succeeded = await (settingsRef.current?.refresh() ?? Promise.resolve(false));
        } else {
          pageName = operationsTab === "runs" ? "运营运行记录" : "运营情报库";
          succeeded = await (operationsRef.current?.refresh() ?? Promise.resolve(false));
        }
      } else if (tab === "settings") {
        pageName = "系统设置";
        succeeded = await (settingsRef.current?.refresh() ?? Promise.resolve(false));
      } else if (tab === "runs") {
        pageName = "运行记录";
        const runsData = await backend.query_runs({ limit: 30 });
        setRuns(runsData as RunItem[]);
        succeeded = true;
      } else {
        pageName = "机会库";
        setLoading(true);
        const eventsData = await backend.query_events(buildQueryParams(0));
        const res = eventsData as QueryResult;
        setResult(res);
        setHasMore(res.items.length < res.total);
        succeeded = true;
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      await minimumProgressTime;
      setLoading(false);
      setRefreshing(false);
    }

    const completedAt = new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(new Date());
    setRefreshNotice({
      kind: succeeded ? "success" : "error",
      text: succeeded ? `${pageName}已刷新 · ${completedAt}` : `${pageName}刷新失败，请查看错误提示`,
    });
    if (refreshNoticeTimer.current) clearTimeout(refreshNoticeTimer.current);
    refreshNoticeTimer.current = setTimeout(() => setRefreshNotice(null), 3200);
  }

  return (
    <div className="app-shell">
      <aside className="module-rail">
        <div className="module-rail-mark">R</div>
        <button className={module === "product" ? "active" : ""} onClick={() => setModule("product")}><span>◇</span><b>产品情报</b></button>
        <button className={module === "operations" ? "active" : ""} onClick={() => setModule("operations")}><span>▦</span><b>运营情报</b></button>
        <a className="calendar-rail-link" href="https://aidenargents.github.io/Tools/%E7%BE%8E%E5%9B%BD%E7%94%B5%E5%95%86%E5%A4%87%E8%B4%A7%E6%97%A5%E5%8E%86.html" target="_blank" rel="noreferrer"><span>▣</span><b>备货看板 ↗</b></a>
      </aside>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">R</span>
          <div>
            <strong>{module === "product" ? "产品情报" : "运营情报"}</strong>
            <small>SEA · LATAM INTELLIGENCE</small>
          </div>
        </div>
        {module === "product" ? <nav>
          <button className={tab === "events" ? "nav-active" : ""} onClick={() => setTab("events")}>机会库</button>
          <button className={tab === "runs" ? "nav-active" : ""} onClick={() => setTab("runs")}>运行记录</button>
          <button className={tab === "settings" ? "nav-active" : ""} onClick={() => setTab("settings")}>系统设置</button>
        </nav> : <nav>
          <button className={operationsTab === "intelligence" ? "nav-active" : ""} onClick={() => setOperationsTab("intelligence")}>情报库</button>
          <button className={operationsTab === "runs" ? "nav-active" : ""} onClick={() => setOperationsTab("runs")}>运行记录</button>
          <button className={operationsTab === "settings" ? "nav-active" : ""} onClick={() => setOperationsTab("settings")}>系统设置</button>
        </nav>}
        <div className="header-actions">
          <button className="ghost refresh-button" onClick={refreshCurrentPage} disabled={refreshing} aria-busy={refreshing}>
            {refreshing && <span className="refresh-spinner">↻</span>}
            {refreshing ? "刷新中…" : "刷新"}
          </button>
          <button className="primary" onClick={module === "product" ? openScan : openOperationsScan}>＋ 立即扫描</button>
        </div>
      </header>

      {refreshNotice && <div className={`refresh-toast refresh-toast-${refreshNotice.kind}`} role="status" aria-live="polite">{refreshNotice.text}</div>}

      <main>
        {module === "operations" ? (
          operationsTab === "settings"
            ? <SettingsPanel ref={settingsRef} />
            : <OperationsPanel ref={operationsRef} view={operationsTab} />
        ) : <>
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
                {Object.keys(sourceCatalog.regions).map((region) => <option key={region}>{region}</option>)}<option value="">全部区域</option>
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
              <select value={filters.date_range} onChange={(e) => setFilters({ ...filters, date_range: e.target.value })}>
                <option value="all">所有时间</option><option value="7d">最近7天</option><option value="30d">最近30天</option><option value="90d">最近90天</option>
              </select>
              <select value={`${filters.sort_by}-${filters.sort_order}`} onChange={(e) => {
                const [sort_by, sort_order] = e.target.value.split("-");
                setFilters({ ...filters, sort_by, sort_order });
              }}>
                <option value="event_date-desc">事件时间倒序</option>
                <option value="event_date-asc">事件时间正序</option>
                <option value="first_seen_at-desc">拉取时间倒序</option>
                <option value="first_seen_at-asc">拉取时间正序</option>
                <option value="ecommerce_score-desc">分数倒序</option>
                <option value="ecommerce_score-asc">分数正序</option>
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
                      <div className="meta"><span>◉ {item.country || "未知"}</span><span>事件: {item.date || "待定"}</span><span>拉取: {formatTime(item.first_seen_at)}</span><span>{item.stage || "待分析"}</span><span>{item.source}</span></div>
                    </div>
                    <div className="products-preview">
                      {namedProducts(item.products).slice(0, 3).map((product, index) => <span key={`${product.name}-${index}`}>{product.name}</span>)}
                      {namedProducts(item.products).length === 0 && <span>暂无有效选品</span>}
                    </div>
                    <span className="chevron">›</span>
                  </button>
                ))}
                {hasMore && (
                  <button className="load-more ghost" onClick={loadMore} disabled={loadingMore} style={{ width: "100%", padding: "16px", marginTop: "8px", border: "1px dashed var(--border)" }}>
                    {loadingMore ? "正在加载..." : "加载更多"}
                  </button>
                )}
              </div>
            </section>
          </>
        ) : tab === "runs" ? (
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
                  {runDetail.sports.length > 0 && <div className="sports-block"><h3>体育搜索与国家归属</h3><p>本国材料送入对应国家分析；全球材料需本国证据佐证。搜到线索不等于一定生成产品机会。</p>{runDetail.sports.map((sport: any, index: number) => <article key={`${sport.country ?? "global"}-${sport.query}-${index}`}><b>{sport.country || "全球共享"} · {sport.source_name}</b><p>{sport.answer || sport.query}</p>{sport.results.map((item: any, resultIndex: number) => <p key={`${item.url}-${resultIndex}`}><a href={item.url} target="_blank" rel="noreferrer">{item.title || item.url}</a>{item.content && <span> · {item.content}</span>}</p>)}</article>)}</div>}
                </>
              )}
            </div>
          </section>
        ) : (
          <SettingsPanel ref={settingsRef} />
        )}
        </>}
      </main>

      {module === "product" && selected && (
        <div className="modal-backdrop" onMouseDown={() => setSelected(null)}>
          <aside className="drawer" onMouseDown={(e) => e.stopPropagation()}>
            <button className="close" onClick={() => setSelected(null)}>×</button>
            <div className="drawer-score"><span>电商机会分</span><strong>{selected.ecommerce_score}</strong></div>
            <span className={`line line-${selected.source_line}`}>{selected.source_line}线路</span>
            <h2>{selected.event_name}</h2>
            <div className="meta large"><span>📍 {selected.country}</span><span className="divider">|</span><span>📅 {selected.date}</span><span className="divider">|</span><span>{selected.stage}</span></div>
            <div className="insight"><span>💡 为什么值得卖</span><p>{selected.why_sellable || "暂无"}</p></div>
            <h3 className="section-head">🛒 推荐选品</h3>
            <div className="product-cards">{namedProducts(selected.products).map((product, index) => <article key={`${product.name}-${index}`}><span>{String(index + 1).padStart(2, "0")}</span><div className="product-info-rich"><b>{product.name} <em>({product.category})</em></b><div className="product-price"><span>💰</span> {product.price_range}</div><div className="product-keys"><span>🔑</span> {[...(product.keywords_en ?? []), ...(product.keywords_local ?? [])].filter(Boolean).join(", ")}</div></div></article>)}{namedProducts(selected.products).length === 0 && <div className="empty">暂无有效选品</div>}</div>
            <div className="listing-time"><span>⏰ 最佳上架时间</span><b>{selected.best_listing_time || "待分析"}</b></div>
          </aside>
        </div>
      )}

      {module === "product" && scanOpen && (
        <div className="modal-backdrop" onMouseDown={() => !scanning && setScanOpen(false)}>
          <section className="scan-modal" onMouseDown={(e) => e.stopPropagation()}>
            <button className="close" onClick={() => setScanOpen(false)} disabled={scanning}>×</button>
            <p className="eyebrow">MANUAL RUN</p><h2>启动一次完整扫描</h2><p>会按原流程运行所选线路，并继续写 Google Sheets、发送对应的独立钉钉消息。</p>
            <label>目标区域<select value={scanForm.target_region} onChange={(e) => setScanForm({ ...scanForm, target_region: e.target.value })}>{Object.keys(sourceCatalog.regions).map((region) => <option key={region}>{region}</option>)}<option>全部</option></select></label>
            <label>时间范围<select value={scanForm.time_range} onChange={(e) => setScanForm({ ...scanForm, time_range: e.target.value })}><option>今天</option><option>近3天</option><option>本周</option><option>本月</option><option>未来3个月</option></select></label>
            <label>数据线路<select value={scanForm.data_lines} onChange={(e) => setScanForm({ ...scanForm, data_lines: e.target.value })}><option>全部</option><option>媒体+网页</option><option>仅假日</option><option>仅媒体</option><option>仅网页</option><option>假日+网页</option><option>假日+媒体</option></select></label>
            <button className="primary scan-submit" disabled={scanning} onClick={startScan}>{scanning ? scanProgress : "开始扫描"}</button>
          </section>
        </div>
      )}
    </div>
  );
}
