import { forwardRef, useEffect, useImperativeHandle, useMemo, useState, type ChangeEvent } from "react";
import { backend } from "./api";
import sourceCatalog from "../../../config/source_catalog.json";
import CalendarSettingsCard, { type CalendarSettingsValues } from "./CalendarSettingsCard";

type SettingsValues = CalendarSettingsValues & {
  schedule_enabled: boolean;
  schedule_hour: number;
  schedule_minute: number;
  operations_schedule_enabled: boolean;
  operations_schedule_hour: number;
  operations_schedule_minute: number;
  enabled_countries: string[];
  default_target_region: string;
  default_time_range: string;
  default_manual_data_lines: string;
  default_schedule_data_lines: string;
  default_operations_target_region: string;
  default_operations_time_range: string;
  gemini_model: string;
  country_concurrency: number;
  site_concurrency: number;
  request_timeout_ms: number;
  gemini_timeout_ms: number;
  gemini_min_interval_ms: number;
  spreadsheet_id: string;
  google_service_account_email: string;
  google_sheet_name: string;
  operations_google_sheet_name: string;
  product_report_url: string;
  operations_report_url: string;
  dashboard_url: string;
  server_host: string;
  server_port: number;
  database_file: string;
};

type SecretField =
  | "gemini_api_key"
  | "gemini_api_key_2"
  | "tavily_api_key"
  | "google_private_key"
  | "dingtalk_token_1"
  | "dingtalk_secret_1"
  | "dingtalk_token_2"
  | "dingtalk_secret_2"
  | "https_proxy";

type SettingsResponse = {
  values: SettingsValues;
  secret_status: Record<SecretField, boolean>;
  admin_password_configured: boolean;
  local_request: boolean;
  restart_required?: boolean;
};

type SourceHealth = {
  source_line: string;
  source_kind: string;
  country?: string;
  source_name?: string;
  status: "success" | "partial" | "failed" | "skipped";
  item_count: number;
  finished_at?: string;
  run_started_at?: string;
  error?: string;
};

export type SettingsPanelHandle = {
  refresh: () => Promise<boolean>;
};

const dataLineOptions = ["全部", "媒体+网页", "仅假日", "仅媒体", "仅网页", "假日+网页", "假日+媒体"];
const targetCountryGroups = Object.entries(sourceCatalog.regions) as Array<[string, string[]]>;
const targetCountryNames = targetCountryGroups.flatMap(([, countries]) => countries);
const targetCountrySet = new Set(targetCountryNames);

function searchPreview(template: string, range: string) {
  const today = new Date().toISOString().slice(0, 10);
  const end = new Date(`${today}T00:00:00Z`);
  if (range === "今天") end.setUTCDate(end.getUTCDate() + 1);
  else if (range === "近3天") end.setUTCDate(end.getUTCDate() + 3);
  else if (range === "本周") end.setUTCDate(end.getUTCDate() + 7);
  else if (range === "本月") end.setUTCMonth(end.getUTCMonth() + 1);
  else end.setUTCMonth(end.getUTCMonth() + 3);
  return template.replaceAll("${current_year}", today.slice(0, 4))
    .replaceAll("${config.time_range}", range)
    .replaceAll("${start_date}", today)
    .replaceAll("${end_date}", end.toISOString().slice(0, 10));
}

function seconds(milliseconds: number) {
  return Number((milliseconds / 1000).toFixed(1));
}

function sourceTime(value?: string) {
  if (!value) return "";
  const date = new Date(value.includes("Z") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date)
    : value;
}

function SourceHealthBadge({ health }: { health?: SourceHealth }) {
  if (!health) return <span className="source-health source-health-unknown">尚未运行</span>;
  const effectiveStatus = health.status === "success" && health.item_count === 0
    ? "partial"
    : health.status;
  const label = health.status === "success" && health.item_count === 0 ? "无有效结果"
    : effectiveStatus === "success" ? "正常"
    : effectiveStatus === "partial" ? "部分异常"
    : effectiveStatus === "failed" ? "失败"
    : "已跳过";
  return <span className={`source-health source-health-${effectiveStatus}`}>{label} · {health.item_count} 条</span>;
}

function SourceItem({
  name,
  publisher,
  method,
  authority,
  risk,
  health,
  scopeStatus,
  url,
  urlLabel = "官方规则页",
  query,
}: {
  name: string;
  publisher: string;
  method: string;
  authority: string;
  risk: string;
  health?: SourceHealth;
  scopeStatus?: string;
  url?: string;
  urlLabel?: string;
  query?: string;
}) {
  return (
    <article className="source-item">
      <div className="source-item-head">
        <b>{name}</b>
        <div className="source-item-badges">
          {scopeStatus && <span className={`source-scope-status ${scopeStatus === "运行中" ? "source-scope-active" : scopeStatus === "备用配置" ? "source-scope-reserve" : scopeStatus === "部分启用" ? "source-scope-mixed" : "source-scope-paused"}`}>{scopeStatus}</span>}
          <SourceHealthBadge health={health} />
        </div>
      </div>
      <dl>
        <div><dt>内容发布者</dt><dd>{publisher}</dd></div>
        {url && <div><dt>{urlLabel}</dt><dd><a href={url} target="_blank" rel="noreferrer">查看来源页面</a></dd></div>}
        <div><dt>获取方式</dt><dd>{method}</dd></div>
        <div><dt>权威判断</dt><dd>{authority}</dd></div>
        <div><dt>延迟/卡顿/失真风险</dt><dd>{risk}</dd></div>
      </dl>
      {query && <details className="source-query"><summary>查看搜索词</summary><p>{query}</p></details>}
      {health && <p className="source-last-run">最近运行：{sourceTime(health.run_started_at || health.finished_at)}{health.error ? ` · ${health.error}` : ""}</p>}
    </article>
  );
}

const officialMediaDomains = new Set(["channelnewsasia.com", "world.thaipbs.or.th"]);
const officialSportsDomains = new Set(["fifa.com", "the-afc.com", "uefa.com", "formula1.com", "olympics.com"]);

function countryScopeStatus(country: string, enabledCountries: Set<string>) {
  if (!targetCountrySet.has(country)) return "备用配置";
  return enabledCountries.has(country) ? "运行中" : "已暂停";
}

function countriesScopeStatus(countries: string[], enabledCountries: Set<string>) {
  const states = new Set(countries.map((country) => countryScopeStatus(country, enabledCountries)));
  if (states.size > 1) return "部分启用";
  return states.values().next().value ?? "备用配置";
}

const SettingsPanel = forwardRef<SettingsPanelHandle>(function SettingsPanel(_, ref) {
  const [snapshot, setSnapshot] = useState<SettingsResponse | null>(null);
  const [values, setValues] = useState<SettingsValues | null>(null);
  const [secretValues, setSecretValues] = useState<Partial<Record<SecretField, string>>>({});
  const [clearSecrets, setClearSecrets] = useState<SecretField[]>([]);
  const [adminPassword, setAdminPassword] = useState("");
  const [newAdminPassword, setNewAdminPassword] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [sourceHealth, setSourceHealth] = useState<SourceHealth[]>([]);

  async function loadSettings() {
    setLoading(true);
    setError("");
    try {
      const [result, health] = await Promise.all([
        backend.get_settings({}) as Promise<SettingsResponse>,
        backend.query_source_health({}) as Promise<SourceHealth[]>,
      ]);
      setSnapshot(result);
      setValues(result.values);
      setSourceHealth(health);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadSettings(); }, []);
  useImperativeHandle(ref, () => ({ refresh: loadSettings }));

  const scheduleTime = useMemo(() => values
    ? `${String(values.schedule_hour).padStart(2, "0")}:${String(values.schedule_minute).padStart(2, "0")}`
    : "09:10", [values]);
  const operationsScheduleTime = useMemo(() => values
    ? `${String(values.operations_schedule_hour).padStart(2, "0")}:${String(values.operations_schedule_minute).padStart(2, "0")}`
    : "09:30", [values]);

  const healthMap = useMemo(() => new Map(sourceHealth.map((item) => [
    `${item.source_kind}|${item.country ?? ""}|${item.source_name ?? ""}`,
    item,
  ])), [sourceHealth]);
  const sourceStatus = (kind: string, country: string, name: string) =>
    healthMap.get(`${kind}|${country}|${name}`)
    ?? healthMap.get(`${kind}||${name}`);
  const latestSourceStatus = (kind: string, name: string) => sourceHealth
    .filter((item) => item.source_kind === kind && item.source_name === name)
    .sort((a, b) => String(b.run_started_at ?? "").localeCompare(String(a.run_started_at ?? "")))[0];
  const searchLabel = "Tavily Search API";
  const enabledCountries = new Set(values?.enabled_countries ?? targetCountryNames);

  function change<K extends keyof SettingsValues>(field: K, value: SettingsValues[K]) {
    setValues((current) => current ? { ...current, [field]: value } : current);
  }

  function toggleCountry(country: string, checked: boolean) {
    setValues((current) => {
      if (!current) return current;
      const next = new Set(current.enabled_countries);
      if (checked) next.add(country);
      else next.delete(country);
      return {
        ...current,
        enabled_countries: targetCountryNames.filter((name) => next.has(name)),
      };
    });
  }

  function changeSecret(field: SecretField, value: string) {
    setSecretValues((current) => ({ ...current, [field]: value }));
    if (value) setClearSecrets((current) => current.filter((item) => item !== field));
  }

  function toggleClear(field: SecretField) {
    setClearSecrets((current) => current.includes(field)
      ? current.filter((item) => item !== field)
      : [...current, field]);
    setSecretValues((current) => ({ ...current, [field]: "" }));
  }

  async function save() {
    if (!values) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const { database_file: _databaseFile, ...editableValues } = values;
      const result = await backend.save_settings({
        auth_password: adminPassword,
        values: editableValues,
        secret_values: Object.fromEntries(
          Object.entries(secretValues).filter(([, value]) => Boolean(value)),
        ),
        clear_secrets: clearSecrets,
        new_admin_password: newAdminPassword,
      }) as SettingsResponse;
      setSnapshot(result);
      setValues(result.values);
      setSecretValues({});
      setClearSecrets([]);
      if (newAdminPassword) setAdminPassword(newAdminPassword);
      setNewAdminPassword("");
      setNotice(result.restart_required
        ? "设置已保存；监听地址或端口有变化，请运行 重启.bat 后生效。"
        : "设置已保存并立即生效。下一次手动或定时扫描会使用新配置。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  function SecretInput({ field, label, multiline = false }: { field: SecretField; label: string; multiline?: boolean }) {
    const isConfigured = snapshot?.secret_status[field];
    const isCleared = clearSecrets.includes(field);
    const common = {
      value: secretValues[field] ?? "",
      onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => changeSecret(field, event.target.value),
      placeholder: isConfigured ? "已配置；留空保持原值" : "尚未配置",
      disabled: isCleared,
    };
    return (
      <label className="setting-field secret-field">
        <span>{label}<small className={isConfigured ? "configured" : "missing"}>{isConfigured ? "已配置" : "未配置"}</small></span>
        {multiline ? <textarea {...common} rows={4} /> : <input {...common} type="password" autoComplete="new-password" />}
        <button type="button" className={isCleared ? "clear-secret selected" : "clear-secret"} onClick={() => toggleClear(field)}>
          {isCleared ? "将清除（再次点击取消）" : "清除现有值"}
        </button>
      </label>
    );
  }

  if (loading && !values) return <section className="panel settings-loading">正在读取系统设置…</section>;
  if (!values || !snapshot) return <section className="panel settings-loading">{error || "无法读取系统设置"}</section>;

  return (
    <section className="settings-page">
      <div className="settings-heading">
        <div><p className="eyebrow">SYSTEM SETTINGS</p><h2>系统设置</h2><p>日常运行项保存后立即生效；密钥原值不会返回浏览器。</p></div>
        <button className="primary" disabled={saving} onClick={save}>{saving ? "正在保存…" : "保存全部设置"}</button>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="success-banner">{notice}</div>}
      {!snapshot.admin_password_configured && (
        <div className="warning-banner">尚未设置管理员密码。{snapshot.local_request ? "可在本机完成首次设置；远程用户当前不能保存。" : "请先在服务器本机设置，远程页面当前只能查看。"}</div>
      )}

      <div className="settings-grid">
        <CalendarSettingsCard values={values} change={(patch) => setValues((current) => current ? { ...current, ...patch } : current)} password={adminPassword} setPassword={setAdminPassword} needsPassword={snapshot.admin_password_configured} />
        <article className="settings-card">
          <div className="settings-card-title"><span>01</span><div><h3>自动运行</h3><p>产品情报和运营情报分别定时，互不改变对方的分析逻辑。</p></div></div>
          <div className="country-scope-setting">
            <div className="country-scope-head"><b>启用国家</b><small>同时控制产品情报与运营情报；取消后停止后续采集和分析，但不会删除历史数据。</small></div>
            <div className="country-region-groups">
              {targetCountryGroups.map(([region, countries]) => (
                <div className="country-region-group" key={region}>
                  <strong>{region}</strong>
                  <div>
                    {countries.map((country) => {
                      const checked = enabledCountries.has(country);
                      const onlyCountry = checked && values.enabled_countries.length === 1;
                      return (
                        <label className={checked ? "country-choice checked" : "country-choice"} key={country}>
                          <input type="checkbox" checked={checked} disabled={onlyCountry} onChange={(event) => toggleCountry(country, event.target.checked)} />
                          <span>{country}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
            <p>当前运行 {values.enabled_countries.length}/{targetCountryNames.length} 个目标国家；未勾选只会暂停采集，国家配置仍保留并完整显示在下方。</p>
          </div>
          <div className="setting-divider"><span>产品情报</span></div>
          <label className="toggle-field"><span><b>产品情报每日自动扫描</b><small>假日、媒体、网页三条产品线路</small></span><input type="checkbox" checked={values.schedule_enabled} onChange={(event) => change("schedule_enabled", event.target.checked)} /></label>
          <div className="setting-row">
            <label className="setting-field"><span>每天运行时间</span><input type="time" value={scheduleTime} onInput={(event) => { const [hour, minute] = event.currentTarget.value.split(":").map(Number); change("schedule_hour", hour); change("schedule_minute", minute); }} /></label>
            <label className="setting-field"><span>定时扫描线路</span><select value={values.default_schedule_data_lines} onChange={(event) => change("default_schedule_data_lines", event.target.value)}>{dataLineOptions.map((item) => <option key={item}>{item}</option>)}</select></label>
          </div>
          <div className="setting-row three">
            <label className="setting-field"><span>默认区域</span><select value={values.default_target_region} onChange={(event) => change("default_target_region", event.target.value)}>{targetCountryGroups.map(([region]) => <option key={region}>{region}</option>)}<option>全部</option></select></label>
            <label className="setting-field"><span>默认时间范围</span><select value={values.default_time_range} onChange={(event) => change("default_time_range", event.target.value)}><option>今天</option><option>近3天</option><option>本周</option><option>本月</option><option>未来3个月</option></select></label>
            <label className="setting-field"><span>手动扫描线路</span><select value={values.default_manual_data_lines} onChange={(event) => change("default_manual_data_lines", event.target.value)}>{dataLineOptions.map((item) => <option key={item}>{item}</option>)}</select></label>
          </div>
          <div className="setting-divider"><span>运营情报</span></div>
          <label className="toggle-field"><span><b>运营情报每日自动扫描</b><small>优先复用产品情报最近3小时的同一批新闻证据</small></span><input type="checkbox" checked={values.operations_schedule_enabled} onChange={(event) => change("operations_schedule_enabled", event.target.checked)} /></label>
          <div className="setting-row three">
            <label className="setting-field"><span>每天运行时间</span><input type="time" value={operationsScheduleTime} onInput={(event) => { const [hour, minute] = event.currentTarget.value.split(":").map(Number); change("operations_schedule_hour", hour); change("operations_schedule_minute", minute); }} /></label>
            <label className="setting-field"><span>默认区域</span><select value={values.default_operations_target_region} onChange={(event) => change("default_operations_target_region", event.target.value)}>{targetCountryGroups.map(([region]) => <option key={region}>{region}</option>)}<option>全部</option></select></label>
            <label className="setting-field"><span>新闻时间范围</span><select value={values.default_operations_time_range} onChange={(event) => change("default_operations_time_range", event.target.value)}><option>今天</option><option>近3天</option><option>本周</option><option>本月</option></select></label>
          </div>
        </article>

        <article className="settings-card">
          <div className="settings-card-title"><span>02</span><div><h3>AI 与采集性能</h3><p>保留逐国、逐站逻辑，只调整模型、并发和等待时间。</p></div></div>
          <div className="setting-row three">
            <label className="setting-field"><span>Gemini 模型</span><input value={values.gemini_model} onChange={(event) => change("gemini_model", event.target.value)} /></label>
            <label className="setting-field"><span>国家并发数</span><input type="number" min={1} max={16} value={values.country_concurrency} onChange={(event) => change("country_concurrency", Number(event.target.value))} /></label>
            <label className="setting-field"><span>站点并发数</span><input type="number" min={1} max={32} value={values.site_concurrency} onChange={(event) => change("site_concurrency", Number(event.target.value))} /></label>
          </div>
          <div className="setting-row three">
            <label className="setting-field"><span>普通请求超时（秒）</span><input type="number" min={1} max={300} value={seconds(values.request_timeout_ms)} onChange={(event) => change("request_timeout_ms", Math.round(Number(event.target.value) * 1000))} /></label>
            <label className="setting-field"><span>Gemini 超时（秒）</span><input type="number" min={10} max={600} value={seconds(values.gemini_timeout_ms)} onChange={(event) => change("gemini_timeout_ms", Math.round(Number(event.target.value) * 1000))} /></label>
            <label className="setting-field"><span>Gemini 间隔（秒）</span><input type="number" min={0} max={60} step={0.1} value={seconds(values.gemini_min_interval_ms)} onChange={(event) => change("gemini_min_interval_ms", Math.round(Number(event.target.value) * 1000))} /></label>
          </div>
          <div className="setting-row two secrets-row"><SecretInput field="gemini_api_key" label="Gemini API Key 1（主）" /><SecretInput field="gemini_api_key_2" label="Gemini API Key 2（轮换）" /></div>
          <p className="settings-footnote">配置两个不同项目的 Key 后，每次 Gemini 分析会交替使用；某个 Key 遇到 429 会临时冷却并切换另一个。同一 Google 项目的两个 Key 共享配额，轮换不会增加额度。</p>
          <p className="settings-footnote">当前唯一搜索引擎：Tavily Search API。</p>
          <SecretInput field="tavily_api_key" label="Tavily API Key" />
          <SecretInput field="https_proxy" label="HTTPS 代理" />
        </article>

        <article className="settings-card">
          <div className="settings-card-title"><span>03</span><div><h3>Google Sheets 与钉钉</h3><p>一个Google表格文件，产品情报和运营情报分别写入两个Sheet标签页。</p></div></div>
          <div className="setting-row two">
            <label className="setting-field"><span>Google 表格 ID</span><input value={values.spreadsheet_id} onChange={(event) => change("spreadsheet_id", event.target.value)} /></label>
            <label className="setting-field"><span>服务账号邮箱</span><input value={values.google_service_account_email} onChange={(event) => change("google_service_account_email", event.target.value)} /></label>
          </div>
          <div className="setting-row two">
            <label className="setting-field"><span>产品情报 Sheet 名称</span><input value={values.google_sheet_name} onChange={(event) => change("google_sheet_name", event.target.value)} /></label>
            <label className="setting-field"><span>运营情报 Sheet 名称</span><input value={values.operations_google_sheet_name} onChange={(event) => change("operations_google_sheet_name", event.target.value)} /></label>
          </div>
          <div className="setting-row two">
            <label className="setting-field"><span>产品情报钉钉报告地址</span><input value={values.product_report_url} onChange={(event) => change("product_report_url", event.target.value)} /></label>
            <label className="setting-field"><span>运营情报钉钉报告地址</span><input value={values.operations_report_url} onChange={(event) => change("operations_report_url", event.target.value)} /></label>
          </div>
          <SecretInput field="google_private_key" label="Google 服务账号私钥" multiline />
          <div className="setting-row two secrets-row"><SecretInput field="dingtalk_token_1" label="钉钉机器人 1 Token" /><SecretInput field="dingtalk_secret_1" label="钉钉机器人 1 Secret" /></div>
          <div className="setting-row two secrets-row"><SecretInput field="dingtalk_token_2" label="钉钉机器人 2 Token" /><SecretInput field="dingtalk_secret_2" label="钉钉机器人 2 Secret" /></div>
          <p className="settings-footnote">机器人 2 可留空；仅向已配置 Token 的机器人发送。启用了加签的机器人还需配置对应 Secret。</p>
        </article>

        <article className="settings-card">
          <div className="settings-card-title"><span>04</span><div><h3>服务与安全</h3><p>远程修改必须验证管理员密码；端口变更需重启。</p></div></div>
          {snapshot.admin_password_configured && <label className="setting-field"><span>当前管理员密码（用于本次保存）</span><input type="password" value={adminPassword} onChange={(event) => setAdminPassword(event.target.value)} autoComplete="current-password" /></label>}
          <label className="setting-field"><span>{snapshot.admin_password_configured ? "更换管理员密码" : "设置管理员密码"}</span><input type="password" minLength={8} value={newAdminPassword} onChange={(event) => setNewAdminPassword(event.target.value)} placeholder="至少 8 个字符；留空则不修改" autoComplete="new-password" /></label>
          <div className="setting-row three">
            <label className="setting-field"><span>团队看板地址</span><input value={values.dashboard_url} onChange={(event) => change("dashboard_url", event.target.value)} /></label>
            <label className="setting-field"><span>监听地址</span><input value={values.server_host} onChange={(event) => change("server_host", event.target.value)} /></label>
            <label className="setting-field"><span>服务端口</span><input type="number" min={1} max={65535} value={values.server_port} onChange={(event) => change("server_port", Number(event.target.value))} /></label>
          </div>
          <label className="setting-field read-only"><span>数据库文件（页面只读）</span><input value={values.database_file} readOnly /></label>
          <p className="settings-footnote">修改监听地址或端口后，当前服务会继续使用旧地址，运行 <code>重启.bat</code> 后切换。数据库位置为防止误切换历史数据，只允许在本地配置文件中修改。</p>
        </article>
      </div>

      <div className="settings-grid" style={{ marginTop: 14 }}>
        <article className="settings-card">
          <div className="settings-card-title"><span>05</span><div><h3>数据源与获取方式（只读）</h3><p>“内容发布者”决定权威性，“获取方式”决定延迟和卡顿风险；状态来自最近一次真实运行。</p></div></div>
          <div className="source-pipeline">
            <b>数据链路</b><span>内容发布者</span><i>→</i><span>Tavily / RSS / API</span><i>→</i><span>日期、域名、重复校验</span><i>→</i><span>Gemini 选品分析</span>
            <p>Gemini 是分析环节，不是新闻来源。状态“正常”表示最近一次取得了通过校验的证据，不代表事实绝对正确；“部分异常”表示接口有响应但没有有效内容；“失败”表示请求或解析失败。系统会保留来源、运行记录和错误原因。</p>
          </div>
          <div className="source-list-preview">
            <div className="source-preview-row">
              <h4>目标国家媒体配置 <span>Tavily Search API · 启用状态不影响配置显示</span></h4>
              <p className="source-block-note">所有目标国家的媒体配置始终显示。未勾选的国家标记为“已暂停”，只是不参与采集和分析；重新勾选保存后自动恢复。</p>
              {Object.entries(sourceCatalog.countries)
                .filter(([countryName]) => targetCountrySet.has(countryName))
                .map(([countryName, countryInfo]: [string, any]) => (
                <div key={countryName} className="source-country-group">
                  <h5><span>{countryName} · {countryInfo.region}</span><span className={`source-scope-status ${enabledCountries.has(countryName) ? "source-scope-active" : "source-scope-paused"}`}>{countryScopeStatus(countryName, enabledCountries)}</span></h5>
                  <div className="source-items-grid">
                    {countryInfo.media.map(([domain]: string[]) => (
                      <SourceItem
                        key={domain}
                        name={domain}
                        publisher={`${countryName}当地${officialMediaDomains.has(domain) ? "公共/官方媒体" : "主要媒体"}`}
                        method={`${searchLabel} · 单站请求`}
                        authority={officialMediaDomains.has(domain) ? "高：发布者具有公共或官方媒体属性" : "中高：当地主要媒体，重要事实仍需交叉验证"}
                        risk="中：搜索索引可能延迟或漏报；无有效URL、跨域、旧闻和重复结果会被拦截"
                        health={sourceStatus("tavily", countryName, domain)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="source-preview-row source-reserve-row">
              <h4>备用国家媒体配置 <span>保留配置，不参与当前扫描</span></h4>
              <p className="source-block-note">扩展国家的媒体域名也完整保留在这里；当前未接入扫描范围，不会消耗搜索或 Gemini 额度。</p>
              {Object.entries(sourceCatalog.countries).filter(([country]) => !targetCountrySet.has(country)).map(([country, info]: [string, any]) => (
                <div key={country} className="source-country-group">
                  <h5><span>{country} · {info.region}</span><span className="source-scope-status source-scope-reserve">备用配置</span></h5>
                  <div className="source-items-grid">
                    {info.media.map(([domain]: string[]) => <SourceItem key={domain} name={domain}
                      publisher={`${country}当地主要媒体`}
                      method="预留媒体域名（当前不发起搜索）"
                      authority="待接入后按媒体属性判断"
                      risk="当前未参与采集和分析"
                      scopeStatus="备用配置" />)}
                  </div>
                </div>
              ))}
            </div>
            <div className="source-preview-row">
              <h4>体育赛事与产品机会 <span>{searchLabel} · 按国家分析</span></h4>
              <p className="source-block-note">全球赛事每次扫描共享采集一次；本国赛事按勾选国家分别搜索。体育材料与该国媒体一起进入产品情报分析。全球赛事需要本国关联证据；没有明确活动日期或有效来源的内容不会生成机会。</p>
              <p className="source-block-note">启用媒体线路并扫描全部启用国家时：全球共享 {sourceCatalog.sports_searches.length} 次体育搜索，加本国体育 {Object.entries(sourceCatalog.country_sports_searches).filter(([country]) => enabledCountries.has(country)).reduce((count, [, searches]) => count + searches.length, 0)} 次。仅扫描某个地区或国家时，按实际范围减少本国请求。赛事和活动按发生日期筛选。</p>
              <h5>全球赛事 · 采集一次，逐国核实关联</h5>
              <div className="source-items-grid sports-global-grid">
                {sourceCatalog.sports_searches.map(([domain, query]: string[]) => (
                  <SourceItem key={domain} name={domain}
                    publisher={officialSportsDomains.has(domain) ? "赛事组织方官网" : domain === "flashscore.com" ? "比分/赛程聚合平台" : "体育媒体"}
                    method={`${searchLabel} · 单站赛事搜索`}
                    authority={officialSportsDomains.has(domain) ? "高：官方赛历或赛事组织方" : domain === "flashscore.com" ? "中：聚合数据需以赛事官网确认" : "中高：专业体育媒体"}
                    risk="中：赛程更改或索引延迟；系统校验域名、URL和重复结果"
                    query={searchPreview(query, values?.default_time_range ?? "本周")}
                    health={sourceStatus("sports", "", domain)} />
                ))}
              </div>
              {Object.entries(sourceCatalog.country_sports_searches).map(([country, searches]) => (
                <div key={country} className="source-country-group">
                  <h5><span>{country} · 本国体育查询</span><span className={`source-scope-status ${enabledCountries.has(country) ? "source-scope-active" : "source-scope-paused"}`}>{countryScopeStatus(country, enabledCountries)}</span></h5>
                  <div className="source-items-grid">
                    {searches.map(([domain, query]) => <SourceItem key={domain} name={`${country} · ${domain}`}
                      publisher={officialSportsDomains.has(domain) ? "赛事组织方官网" : domain === "flashscore.com" ? "比分/赛程聚合平台" : "体育媒体"}
                      method={`${searchLabel} · 单站单国家搜索`}
                      authority={officialSportsDomains.has(domain) ? "高：赛事组织方发布" : "中：以赛事原文和明确日期核实"}
                      risk="中：搜索可能缺少赛程日期；只向本国分析提供本国查询结果"
                      query={searchPreview(query, values?.default_time_range ?? "本周")}
                      scopeStatus={countryScopeStatus(country, enabledCountries)}
                      health={healthMap.get(`sports|${country}|${domain}`)} />)}
                  </div>
                </div>
              ))}
            </div>
            <div className="source-preview-row">
              <h4>新闻订阅源 <span>RSS / XML接口</span></h4>
              <p className="source-block-note">RSS是网站主动提供的结构化订阅，通常比搜索更快、更少串站。直连官方RSS较稳定；RSSHub多一层代理，可能停更或缓存旧内容。</p>
              <div className="source-items-grid">
                {sourceCatalog.rss_feeds.map((feed: any) => (
                  <SourceItem key={feed.name} name={feed.name}
                    publisher={feed.country ? `${feed.country} · ${feed.official ? "官方/国家通讯社" : "新闻媒体"}` : "中文新闻媒体"}
                    method={feed.url.includes("rsshub") ? "RSSHub第三方代理 → RSS接口" : "发布者直连 RSS/XML接口"}
                    authority={feed.official ? "高：发布者官方订阅" : "中：媒体报道，不等于政府原始公告"}
                    risk={feed.url.includes("rsshub") ? "中高：代理可能卡顿、停更或保留旧缓存；超过14天会被拦截" : "低至中：通常延迟较小；可能临时断连或字段格式变化"}
                    scopeStatus={feed.country ? countryScopeStatus(feed.country, enabledCountries) : undefined}
                    health={sourceStatus("rss", feed.country ?? "", feed.name)} />
                ))}
              </div>
            </div>
            <div className="source-preview-row">
              <h4>官方节庆与活动日历 <span>官方页面 + Tavily</span></h4>
              <p className="source-block-note">内容来自旅游局、文化部门等官方页面，但获取仍通过 Tavily，所以“内容权威”和“获取可能延迟”可以同时成立。</p>
              <div className="source-items-grid">
                {sourceCatalog.official_event_sources.map((source: any) => (
                  <SourceItem key={`${source.country}-${source.domain}`} name={`${source.country} · ${source.name}`}
                    publisher={source.publisher ?? "政府旅游、文化或公共推广机构"}
                    method={`${searchLabel} · 官方域名限定`}
                    authority="高：活动名称、地点和公布日期以官方页面为准"
                    risk="中：动态日历可能未被及时索引；无官方域名和有效页面路径的结果会被拦截"
                    scopeStatus={countryScopeStatus(source.country, enabledCountries)}
                    url={source.url} urlLabel="官方活动入口" query={searchPreview(source.query, values?.default_time_range ?? "本周")}
                    health={sourceStatus("official-event-calendar", source.country, source.name)} />
                ))}
              </div>
            </div>
            <div className="source-preview-row">
              <h4>灾害预警 <span>直连 XML/RSS接口</span></h4>
              <div className="source-items-grid"><SourceItem name={sourceCatalog.gdacs.name}
                publisher="GDACS（联合国与欧盟委员会支持的全球灾害预警系统）"
                method="直连 GDACS XML/RSS接口"
                authority="高：适合确认灾害位置、时间、事件ID和预警等级"
                risk="低至中：数据量大但结构稳定；可能与稍后出现的媒体报道重复，系统按事件ID去重"
                health={sourceStatus("gdacs", "", sourceCatalog.gdacs.name)} /></div>
            </div>
            <div className="source-preview-row">
              <h4>公共假日 <span>REST API + 官方本地兜底</span></h4>
              <p className="source-block-note">先请求 Nager.Date；泰国和马来西亚返回空时才使用按官方公报录入的本地年度表。这里的“本地”指保存在系统配置中，不是随意编写。</p>
              <div className="source-items-grid">
                <SourceItem name="Nager.Date"
                  publisher="第三方开源公共假日聚合项目"
                  method="Nager.Date REST API"
                  authority="中高：结构化且方便，但不是各国政府原始公告"
                  risk="低至中：接口稳定；国家覆盖不完整，泰国和马来西亚当前返回空"
                  health={latestSourceStatus("nager", "Nager.Date")} />
                {Object.entries(sourceCatalog.holiday_fallbacks).map(([country, fallback]: [string, any]) => (
                  <SourceItem key={country} name={`${country} · ${fallback.source_name}`}
                    publisher="对应国家政府、央行或总理署官方公报"
                    method="官方公报人工核对 → 本地年度结构化表"
                    authority="高：日期依据官方文件"
                    risk="运行时不会卡；维护风险是跨年或临时新增假日，需要更新年度表"
                    scopeStatus={countryScopeStatus(country, enabledCountries)}
                    health={sourceStatus("official-holiday-fallback", country, fallback.source_name)} />
                ))}
              </div>
            </div>
            <div className="source-preview-row">
              <h4>运营情报官方经营来源 <span>官方网页 + Tavily</span></h4>
              <p className="source-block-note">按国家监测海关、税务及相关监管机构公告，补足媒体新闻中的关税、进口准入、消费者保护和商品安全政策。它们不进入产品机会分析。</p>
              <div className="source-items-grid">
                {sourceCatalog.operations_official_sources.map((source: any) => (
                  <SourceItem key={`${source.country}-${source.domain}`} name={`${source.country} · ${source.name}`}
                    publisher="国家级监管、海关、税务或贸易主管机构"
                    url={source.url}
                    method={`${searchLabel} · 官方域名限定 · 单站请求`}
                    authority="高：政策内容以官方公告为准"
                    risk="低至中：官方页面可能更新慢或未标发布日期；系统仍校验域名、正文和URL"
                    scopeStatus={countryScopeStatus(source.country, enabledCountries)}
                    health={sourceStatus("operations-official", source.country, source.name)} />
                ))}
              </div>
            </div>
            <div className="source-preview-row">
              <h4>平台官方规则与费用 <span>平台官方页面 + Tavily</span></h4>
              <p className="source-block-note">按国家和配置的平台搜索卖家公告，包括 Amazon、eBay、Walmart、Shopee、Lazada、TikTok Shop 和 Mercado Libre。具体规则以平台原文为准。</p>
              <div className="source-items-grid">
                {sourceCatalog.platform_official_sources.map((source: any) => (
                  <SourceItem key={`${source.country}-${source.platform}-${source.domain}`} name={`${source.country} · ${source.platform}`}
                    publisher={source.name}
                    url={source.url}
                    method={`${searchLabel} · 平台官方域名限定 · 单站请求`}
                    authority="高：平台自己发布的卖家规则或帮助中心公告"
                    risk="低至中：部分卖家中心为动态页面或需要登录，可能未被搜索及时索引；系统会保留零结果和失败原因"
                    scopeStatus={countryScopeStatus(source.country, enabledCountries)}
                    health={sourceStatus("platform-official", source.country, source.name)} />
                ))}
              </div>
            </div>
            <div className="source-preview-row">
              <h4>跨境电商行业媒体 <span>发现线索 + 交叉验证</span></h4>
              <p className="source-block-note">每个网站按已启用区域单独查询；北美使用美国市场和平台词，东南亚、拉美保留各自查询。一级线索优先；聚合转载属于二级线索。单一媒体只能标记“待核实”，不会进入钉钉正式播报。</p>
              <div className="source-items-grid">
                {sourceCatalog.platform_industry_media_sources.flatMap((source: any) => {
                  const scopes = source.countries?.length
                    ? [source.countries.join("、")]
                    : source.regions;
                  return scopes.map((scope: string) => {
                    const scopedCountries: string[] = source.countries?.length
                      ? source.countries
                      : (sourceCatalog.regions as Record<string, string[]>)[scope] ?? [];
                    const activeCountries = scopedCountries.filter((country) => enabledCountries.has(country));
                    const scopeTerms = (activeCountries.length ? activeCountries : scopedCountries).join(" ");
                    const queryTemplate = source.queries_by_region?.[scope] ?? source.query;
                    return (
                    <SourceItem key={`${source.domain}-${scope}`} name={`${source.name} · ${scope}`}
                      publisher={source.tier === "A" ? "跨境行业专业/垂直媒体" : "跨境行业聚合/转载媒体"}
                      method={`${searchLabel} · ${source.countries?.length ? "单站指定国家" : "单站单区域"}请求`}
                      authority={source.tier === "A" ? "中高：一级发现线索，仍优先寻找平台官方原文" : "中：二级发现线索，不能单独作为确定结论"}
                      risk="中：可能转载同一原稿、标题改写或缺少官方链接；系统按国家、平台、政策类型、生效日和费率变化合并"
                      scopeStatus={countriesScopeStatus(scopedCountries, enabledCountries)}
                      query={searchPreview(queryTemplate.replaceAll("${scope_terms}", scopeTerms), values?.default_operations_time_range ?? "近3天")}
                      health={latestSourceStatus("platform-media", `${source.name}·${scope}`)} />
                    );
                  });
                })}
              </div>
            </div>
            <div className="source-preview-row">
              <h4>待授权需求数据 <span>当前不运行</span></h4>
              <div className="source-items-grid">
                {sourceCatalog.optional_sources.map((source) => (
                  <SourceItem key={source.name} name={source.name}
                    publisher="平台内部趋势数据"
                    method="官方 OAuth/API（尚未获得权限）"
                    authority="高：属于真实平台行为数据，不是新闻推测"
                    risk={`当前不发请求、不产生数据。${source.status}`} />
                ))}
              </div>
            </div>
          </div>
        </article>
      </div>
    </section>
  );
});

export default SettingsPanel;
