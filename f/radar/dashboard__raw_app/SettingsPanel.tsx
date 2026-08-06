import { forwardRef, useEffect, useImperativeHandle, useMemo, useState, type ChangeEvent } from "react";
import { backend } from "./api";

type SettingsValues = {
  schedule_enabled: boolean;
  schedule_hour: number;
  schedule_minute: number;
  default_target_region: string;
  default_time_range: string;
  default_manual_data_lines: string;
  default_schedule_data_lines: string;
  gemini_model: string;
  country_concurrency: number;
  site_concurrency: number;
  request_timeout_ms: number;
  gemini_timeout_ms: number;
  gemini_min_interval_ms: number;
  spreadsheet_id: string;
  google_service_account_email: string;
  google_sheet_name: string;
  dashboard_url: string;
  server_host: string;
  server_port: number;
  database_file: string;
};

type SecretField =
  | "gemini_api_key"
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

export type SettingsPanelHandle = {
  refresh: () => Promise<boolean>;
};

const dataLineOptions = ["全部", "媒体+网页", "仅假日", "仅媒体", "仅网页", "假日+网页", "假日+媒体"];

function seconds(milliseconds: number) {
  return Number((milliseconds / 1000).toFixed(1));
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

  async function loadSettings() {
    setLoading(true);
    setError("");
    try {
      const result = await backend.get_settings({}) as SettingsResponse;
      setSnapshot(result);
      setValues(result.values);
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

  function change<K extends keyof SettingsValues>(field: K, value: SettingsValues[K]) {
    setValues((current) => current ? { ...current, [field]: value } : current);
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
        ? "设置已保存；监听地址或端口有变化，请运行 restart.bat 后生效。"
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
        <article className="settings-card">
          <div className="settings-card-title"><span>01</span><div><h3>自动运行</h3><p>控制每天何时执行哪几条线路。</p></div></div>
          <label className="toggle-field"><span><b>每日自动扫描</b><small>关闭后仍可手动运行</small></span><input type="checkbox" checked={values.schedule_enabled} onChange={(event) => change("schedule_enabled", event.target.checked)} /></label>
          <div className="setting-row">
            <label className="setting-field"><span>每天运行时间</span><input type="time" value={scheduleTime} onInput={(event) => { const [hour, minute] = event.currentTarget.value.split(":").map(Number); change("schedule_hour", hour); change("schedule_minute", minute); }} /></label>
            <label className="setting-field"><span>定时扫描线路</span><select value={values.default_schedule_data_lines} onChange={(event) => change("default_schedule_data_lines", event.target.value)}>{dataLineOptions.map((item) => <option key={item}>{item}</option>)}</select></label>
          </div>
          <div className="setting-row three">
            <label className="setting-field"><span>默认区域</span><select value={values.default_target_region} onChange={(event) => change("default_target_region", event.target.value)}><option>全部</option><option>东南亚</option><option>拉美</option></select></label>
            <label className="setting-field"><span>默认时间范围</span><select value={values.default_time_range} onChange={(event) => change("default_time_range", event.target.value)}><option>今天</option><option>近3天</option><option>本周</option><option>本月</option><option>未来3个月</option></select></label>
            <label className="setting-field"><span>手动扫描线路</span><select value={values.default_manual_data_lines} onChange={(event) => change("default_manual_data_lines", event.target.value)}>{dataLineOptions.map((item) => <option key={item}>{item}</option>)}</select></label>
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
          <div className="setting-row three secrets-row"><SecretInput field="gemini_api_key" label="Gemini API Key" /><SecretInput field="tavily_api_key" label="Tavily API Key" /><SecretInput field="https_proxy" label="HTTPS 代理" /></div>
        </article>

        <article className="settings-card">
          <div className="settings-card-title"><span>03</span><div><h3>Google Sheets 与钉钉</h3><p>继续沿用原流程的写表和两组机器人分发。</p></div></div>
          <div className="setting-row three">
            <label className="setting-field"><span>Google 表格 ID</span><input value={values.spreadsheet_id} onChange={(event) => change("spreadsheet_id", event.target.value)} /></label>
            <label className="setting-field"><span>服务账号邮箱</span><input value={values.google_service_account_email} onChange={(event) => change("google_service_account_email", event.target.value)} /></label>
            <label className="setting-field"><span>工作表名称</span><input value={values.google_sheet_name} onChange={(event) => change("google_sheet_name", event.target.value)} /></label>
          </div>
          <SecretInput field="google_private_key" label="Google 服务账号私钥" multiline />
          <div className="setting-row two secrets-row"><SecretInput field="dingtalk_token_1" label="钉钉机器人 1 Token" /><SecretInput field="dingtalk_secret_1" label="钉钉机器人 1 Secret" /></div>
          <div className="setting-row two secrets-row"><SecretInput field="dingtalk_token_2" label="钉钉机器人 2 Token" /><SecretInput field="dingtalk_secret_2" label="钉钉机器人 2 Secret" /></div>
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
          <p className="settings-footnote">修改监听地址或端口后，当前服务会继续使用旧地址，运行 <code>restart.bat</code> 后切换。数据库位置为防止误切换历史数据，只允许在本地配置文件中修改。</p>
        </article>
      </div>
    </section>
  );
});

export default SettingsPanel;
