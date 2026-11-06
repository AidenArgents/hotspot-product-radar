import { useEffect, useState } from "react";
import { backend } from "./api";

export type CalendarSettingsValues = {
  calendar_enabled: boolean; calendar_url: string; calendar_hour: number; calendar_minute: number;
  calendar_start_date: string; calendar_offsets: number[];
};
type Node = { id: string; event_name: string; event_date: string; route_name: string; stage_name: string; due_date: string; estimated: boolean; done: boolean; snooze_until: string | null };
type State = {
  source_url: string; last_sync_success: string; last_sync_error: string; feed_generated_at: string; node_count: number;
  nodes: Node[]; messages: Array<{ id: string; robot_index: number; status: string; attempts: number; created_at: string; sent_at: string | null; error: string | null }>;
};
function localTime(value?: string | null) {
  return value ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : "尚未同步";
}
export default function CalendarSettingsCard({ values, change, password, setPassword, needsPassword }: {
  values: CalendarSettingsValues; change: (patch: Partial<CalendarSettingsValues>) => void;
  password: string; setPassword: (password: string) => void; needsPassword: boolean;
}) {
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [horizon, setHorizon] = useState(30), [showDone, setShowDone] = useState(false), [count, setCount] = useState(12);
  const [offsetText, setOffsetText] = useState(values.calendar_offsets.join(", "));
  useEffect(() => { setOffsetText(values.calendar_offsets.join(", ")); }, [values.calendar_offsets]);
  async function load() { setState(await backend.calendar_state({}) as State); }
  useEffect(() => { void load().catch((cause) => setError(String(cause))); }, []);
  async function sync() {
    setBusy(true); setError(""); setNotice("");
    try {
      if (state && state.source_url !== values.calendar_url) throw new Error("请先保存全部设置，再同步新的看板链接");
      const result = await backend.calendar_sync({ auth_password: password });
      await load(); setNotice(`已同步线上方案：${result.event_count}个事件，${result.route_count}条启用线路，${result.node_count}个行动节点；本次没有发送钉钉。`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); await load().catch(() => {}); }
    finally { setBusy(false); }
  }
  async function act(id: string, action: string) {
    setBusy(true); setError("");
    try { setState(await backend.calendar_action({ id, action, auth_password: password }) as State); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const end = new Date(Date.parse(today) + horizon * 86_400_000).toISOString().slice(0, 10);
  const nodes = (state?.nodes ?? []).filter((node) => (showDone || !node.done) && (horizon === 9999 || node.due_date <= end));
  return <article className="settings-card calendar-settings-card">
    <div className="settings-card-title"><span>📦</span><div><h3>线上备货看板与提醒</h3><p>沿用原页面的计划，只在每日发送前或手动操作时同步。</p></div></div>
    <label className="toggle-field"><span><b>每日备货行动提醒</b><small>复用已配置的钉钉机器人，独立于产品和运营扫描</small></span><input type="checkbox" checked={values.calendar_enabled} onChange={(event) => change({ calendar_enabled: event.target.checked })} /></label>
    <label className="setting-field"><span>原线上看板链接</span><input value={values.calendar_url} onChange={(event) => change({ calendar_url: event.target.value })} /></label>
    <div className="setting-row three">
      <label className="setting-field"><span>每天提醒时间（北京时间）</span><input type="time" value={`${String(values.calendar_hour).padStart(2, "0")}:${String(values.calendar_minute).padStart(2, "0")}`} onChange={(event) => {
        const [hour, minute] = event.target.value.split(":").map(Number); change({ calendar_hour: hour, calendar_minute: minute });
      }} /></label>
      <label className="setting-field"><span>开始提醒日期</span><input type="date" value={values.calendar_start_date} onChange={(event) => change({ calendar_start_date: event.target.value })} /></label>
      <label className="setting-field"><span>提前提醒天数（0为当天）</span><input value={offsetText} onChange={(event) => setOffsetText(event.target.value)} onBlur={() => {
        const offsets = offsetText.split(/[,，、\s]+/).filter(Boolean).map(Number);
        if (!offsets.length || offsets.some((value) => !Number.isInteger(value) || value < 0 || value > 365)) { setError("提前提醒天数请填写0至365的整数，以逗号分隔"); return; }
        change({ calendar_offsets: [...new Set(offsets)].sort((a, b) => b - a) }); setError("");
      }} /></label>
    </div>
    {needsPassword && <label className="setting-field"><span>管理员密码（用于同步和标记待办）</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /></label>}
    <div className="calendar-actions"><a className="ghost" href={values.calendar_url} target="_blank" rel="noreferrer">打开原备货看板 ↗</a><button className="primary" disabled={busy} onClick={sync}>{busy ? "正在处理…" : "立即同步"}</button></div>
    <p className="settings-footnote">线上发布后才能同步。开始选品、完成选品、最迟发货三个节点按线路分别提醒；同一事项合并展示并去重。参数修改后点击上方“保存全部设置”。</p>
    {error && <div className="error-banner">{error}</div>}{notice && <div className="success-banner">{notice}</div>}
    {state?.last_sync_error && <div className="warning-banner">最近同步异常：{state.last_sync_error}。保留上次成功方案。</div>}
    <div className="calendar-sync-status"><span>成功同步：<b>{localTime(state?.last_sync_success)}</b></span><span>线上方案：<b>{localTime(state?.feed_generated_at)}</b></span><span>行动节点：<b>{state?.node_count ?? 0}</b></span></div>
    <div className="calendar-list-tools"><b>备货待办</b><select aria-label="备货待办时间范围" value={horizon} onChange={(event) => { setHorizon(Number(event.target.value)); setCount(12); }}><option value={7}>未来7天及逾期</option><option value={30}>未来30天及逾期</option><option value={90}>未来90天及逾期</option><option value={9999}>全部节点</option></select><label><input type="checkbox" checked={showDone} onChange={(event) => setShowDone(event.target.checked)} />显示已完成</label></div>
    <div className="calendar-task-list">{nodes.slice(0, count).map((node) => <div className={`calendar-task${node.done ? " calendar-task-done" : ""}`} key={node.id}>
      <div><b>{node.event_name}{node.estimated && <small>预计／规划</small>}</b><p>{node.route_name} · {node.stage_name}</p><span className={node.due_date < today && !node.done ? "calendar-overdue" : ""}>截止 {node.due_date} · 活动 {node.event_date}{node.snooze_until ? ` · 暂缓至${node.snooze_until}` : ""}</span></div>
      <div className="calendar-task-actions"><button disabled={busy} onClick={() => act(node.id, node.done ? "undo" : "done")}>{node.done ? "恢复待办" : "已完成"}</button>{!node.done && <button disabled={busy} onClick={() => act(node.id, "snooze")}>稍后一天</button>}</div>
    </div>)}</div>
    {!nodes.length && <p className="settings-footnote">{state?.last_sync_success ? "当前范围没有待办节点。" : "点击“立即同步”读取线上计划。"}</p>}
    {nodes.length > count && <button className="ghost" onClick={() => setCount(count + 20)}>显示更多（共{nodes.length}个）</button>}
    <details className="calendar-send-log"><summary>提醒发送记录</summary>{state?.messages.length ? state.messages.map((message) => <p key={message.id}>{localTime(message.sent_at || message.created_at)} · 机器人{message.robot_index} · {({ sent: "已发送", failed: "发送失败", pending: "待发送", cancelled: "已取消" } as Record<string, string>)[message.status] ?? message.status} · 尝试{message.attempts}次{message.error ? ` · ${message.error}` : ""}</p>) : <p>尚未发送提醒</p>}</details>
  </article>;
}
