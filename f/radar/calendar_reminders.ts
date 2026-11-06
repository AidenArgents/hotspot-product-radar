import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { sendDingTalk } from "./dingtalk.ts";
import { calendarUrl, chinaDate, DEFAULT_CALENDAR_URL, fetchCalendarHtml, parseCalendarFeed, validDate, type CalendarNode } from "./calendar_feed.ts";
import type { RadarConfig } from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS calendar_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS calendar_nodes (
 id TEXT PRIMARY KEY,payload TEXT NOT NULL,due_date TEXT NOT NULL,event_date TEXT NOT NULL,
 active INTEGER NOT NULL DEFAULT 1,done INTEGER NOT NULL DEFAULT 0,snooze_until TEXT,
 revision INTEGER NOT NULL DEFAULT 1,action_revision INTEGER NOT NULL DEFAULT 0,
 previous_due_date TEXT,change_pending INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS calendar_daily (day TEXT PRIMARY KEY,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,retry_at TEXT,error TEXT);
CREATE TABLE IF NOT EXISTS calendar_messages (
 id TEXT PRIMARY KEY,robot_index INTEGER NOT NULL,notices TEXT NOT NULL,status TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0,next_retry_at TEXT,created_at TEXT NOT NULL,sent_at TEXT,error TEXT
);
CREATE TABLE IF NOT EXISTS calendar_receipts (
 robot_index INTEGER NOT NULL,notice_key TEXT NOT NULL,node_id TEXT NOT NULL,message_id TEXT NOT NULL,status TEXT NOT NULL,
 PRIMARY KEY(robot_index,notice_key)
);
`;
type StoredNode = { id: string; payload: string; due_date: string; event_date: string; active: number; done: number; snooze_until: string | null; revision: number; action_revision: number; previous_due_date: string | null; change_pending: number };
type Notice = { key: string; node: CalendarNode; kind: "normal" | "overdue" | "change" | "snooze"; revision: number; previous_due_date?: string | null };
type Message = { id: string; robot_index: number; notices: string; attempts: number };
const parse = <T>(text: string) => JSON.parse(text) as T;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000);
const addDays = (date: string, days: number) => new Date(Date.parse(date) + days * 86_400_000).toISOString().slice(0, 10);
function configuredRobots(config: RadarConfig) {
  return [config.dingtalk_token_1, config.dingtalk_token_2].flatMap((token, index) => token?.trim() && !/^YOUR_/.test(token.trim()) ? [index + 1] : []);
}
export function buildCalendarMessage(notices: Notice[], date: string, url: string, cachedAt?: string) {
  let text = `📦 美国备货行动提醒 · ${date}（北京时间）\n`;
  if (cachedAt) text += `⚠️ 线上同步暂未成功，以下依据上次成功同步的方案：${cachedAt}\n`;
  const groups = new Map<string, Notice[]>();
  for (const notice of notices) {
    const key = `${notice.node.event_id}|${notice.node.stage}|${notice.node.due_date}|${notice.kind}`;
    groups.set(key, [...(groups.get(key) ?? []), notice]);
  }
  for (const group of groups.values()) {
    const { node, kind, previous_due_date: previous } = group[0];
    const days = daysBetween(node.due_date, date);
    text += `\n${kind === "change" ? "🔄 日期变更" : days < 0 ? "⚠️ 已逾期" : days === 0 ? "🔔 今天截止" : "📌 待办"}｜${node.event_name}${node.estimated ? "【预计／规划日期】" : ""}\n`;
    text += `动作：${node.stage_name}\n线路：${group.map((item) => item.node.route_name).join("、")}\n`;
    text += `截止：${node.due_date}${days < 0 ? `（逾期${-days}天）` : days === 0 ? "（今天）" : `（剩余${days}天）`}\n`;
    if (kind === "change") text += `原截止：${previous}\n`;
    text += `对应活动：${node.event_date}\n`;
  }
  return `${text}\n计划节点提醒，不代表物流或入库已实际完成。\n备货看板：${url}`;
}
type Dependencies = {
  now: () => Date;
  fetchHtml: (config: RadarConfig) => Promise<string>;
  send: typeof sendDingTalk;
};
export class CalendarReminders {
  private syncing: Promise<unknown> | null = null;
  private ticking: Promise<void> | null = null;
  private readonly deps: Dependencies;
  constructor(private readonly db: DatabaseSync, private readonly config: RadarConfig, overrides: Partial<Dependencies> = {}) {
    db.exec(SCHEMA);
    this.deps = { now: () => new Date(), fetchHtml: fetchCalendarHtml, send: sendDingTalk, ...overrides };
  }
  private get(key: string) { return String(this.db.prepare("SELECT value FROM calendar_meta WHERE key=?").get(key)?.value ?? ""); }
  private set(key: string, value: string) { this.db.prepare("INSERT INTO calendar_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value); }
  private url() { return calendarUrl(this.config.calendar_url || DEFAULT_CALENDAR_URL); }
  sync(): Promise<unknown> {
    if (this.syncing) return this.syncing;
    this.syncing = this.synchronize().finally(() => { this.syncing = null; });
    return this.syncing;
  }
  private async synchronize() {
    const now = this.deps.now().toISOString(), sourceUrl = this.url();
    this.set("last_sync_attempt", now);
    try {
      const feed = parseCalendarFeed(await this.deps.fetchHtml({ ...this.config, calendar_url: sourceUrl }));
      const hash = crypto.createHash("sha256").update(JSON.stringify([sourceUrl, feed.nodes])).digest("hex");
      const prefix = crypto.createHash("sha256").update(sourceUrl).digest("hex").slice(0, 12);
      let changes = 0;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec("UPDATE calendar_nodes SET active=0");
        for (const original of feed.nodes) {
          const node = { ...original, id: `${prefix}|${original.id}` };
          const old = this.db.prepare("SELECT * FROM calendar_nodes WHERE id=?").get(node.id) as StoredNode | undefined;
          if (!old) {
            this.db.prepare("INSERT INTO calendar_nodes(id,payload,due_date,event_date) VALUES (?,?,?,?)").run(node.id, JSON.stringify(node), node.due_date, node.event_date);
          } else {
            const moved = old.due_date !== node.due_date;
            const notified = Boolean(this.db.prepare("SELECT 1 FROM calendar_receipts WHERE node_id=? AND status='sent' LIMIT 1").get(node.id));
            this.db.prepare(`UPDATE calendar_nodes SET payload=?,due_date=?,event_date=?,active=1,
              revision=revision+?,previous_due_date=CASE WHEN ? THEN ? ELSE previous_due_date END,
              change_pending=CASE WHEN ? THEN 1 ELSE change_pending END WHERE id=?`).run(
              JSON.stringify(node), node.due_date, node.event_date, moved ? 1 : 0, moved ? 1 : 0, old.due_date,
              moved && notified && !old.done ? 1 : 0, node.id);
            if (moved) changes += 1;
          }
        }
        this.set("source_url", sourceUrl); this.set("source_hash", hash);
        this.set("feed_generated_at", feed.generated_at); this.set("last_sync_success", now);
        this.set("last_sync_error", ""); this.set("changed_nodes", String(changes));
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
      return { synced_at: now, node_count: feed.nodes.length, event_count: feed.event_count, route_count: feed.route_count, changed_nodes: changes };
    } catch (error) {
      this.set("last_sync_error", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
  state() {
    const today = chinaDate(this.deps.now());
    const rows = this.db.prepare("SELECT * FROM calendar_nodes WHERE active=1 AND event_date>=? ORDER BY due_date,payload").all(today) as StoredNode[];
    return {
      source_url: this.url(), last_sync_attempt: this.get("last_sync_attempt"), last_sync_success: this.get("last_sync_success"),
      last_sync_error: this.get("last_sync_error"), feed_generated_at: this.get("feed_generated_at"),
      node_count: rows.length, source_hash: this.get("source_hash"),
      nodes: rows.map((row) => ({ ...parse<CalendarNode>(row.payload), done: Boolean(row.done), snooze_until: row.snooze_until })),
      messages: this.db.prepare("SELECT id,robot_index,status,attempts,created_at,sent_at,next_retry_at,error FROM calendar_messages ORDER BY created_at DESC LIMIT 20").all(),
      daily: this.db.prepare("SELECT * FROM calendar_daily ORDER BY day DESC LIMIT 7").all(),
    };
  }
  action(id: string, action: string) {
    const row = this.db.prepare("SELECT id FROM calendar_nodes WHERE id=? AND active=1").get(id);
    if (!row) throw new Error("备货节点不存在或已从线上取消");
    if (action === "done" || action === "undo") {
      this.db.prepare("UPDATE calendar_nodes SET done=?,snooze_until=NULL,action_revision=action_revision+1 WHERE id=?").run(action === "done" ? 1 : 0, id);
    } else if (action === "snooze") {
      this.db.prepare("UPDATE calendar_nodes SET done=0,snooze_until=?,action_revision=action_revision+1 WHERE id=?").run(addDays(chinaDate(this.deps.now()), 1), id);
    } else throw new Error("不支持的备货操作");
  }
  private candidates(date: string): Notice[] {
    const offsets = this.config.calendar_offsets ?? [7, 3, 0];
    const rows = this.db.prepare("SELECT * FROM calendar_nodes WHERE active=1 AND done=0 AND event_date>=? ORDER BY due_date,id").all(date) as StoredNode[];
    return rows.flatMap((row): Notice[] => {
      if (row.snooze_until && row.snooze_until > date) return [];
      const node = parse<CalendarNode>(row.payload), days = daysBetween(node.due_date, date);
      let kind: Notice["kind"] = "normal", suffix: string;
      if (row.change_pending) { kind = "change"; suffix = `change:${row.revision}`; }
      else if (row.snooze_until) { kind = "snooze"; suffix = `snooze:${row.action_revision}`; }
      else if (days < 0) { kind = "overdue"; suffix = "overdue"; }
      else {
        const offset = offsets.filter((value) => value >= days).sort((a, b) => a - b)[0];
        if (offset === undefined) return [];
        suffix = `offset:${offset}`;
      }
      return [{ key: `${row.id}|${node.due_date}|${suffix}`, node, kind, revision: row.revision, previous_due_date: row.previous_due_date }];
    });
  }
  private enqueue(date: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try { this.enqueueWithinTransaction(date); this.db.exec("COMMIT"); }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private enqueueWithinTransaction(date: string) {
    const candidates = this.candidates(date);
    for (const robot of configuredRobots(this.config)) {
      const pending = candidates.filter((notice) => !this.db.prepare("SELECT 1 FROM calendar_receipts WHERE robot_index=? AND notice_key=? AND status<>'cancelled'").get(robot, notice.key));
      const chunks: Notice[][] = [];
      let chunk: Notice[] = [];
      for (const notice of pending) {
        if (chunk.length && Buffer.byteLength(buildCalendarMessage([...chunk, notice], date, this.url()), "utf8") > 14_000) { chunks.push(chunk); chunk = []; }
        chunk.push(notice);
      }
      if (chunk.length) chunks.push(chunk);
      for (const notices of chunks) {
        const id = crypto.randomUUID();
        this.db.prepare("INSERT INTO calendar_messages(id,robot_index,notices,status,created_at) VALUES (?,?,?,'pending',?)")
          .run(id, robot, JSON.stringify(notices), this.deps.now().toISOString());
        for (const notice of notices) {
          this.db.prepare(`INSERT INTO calendar_receipts VALUES (?,?,?,?,'pending') ON CONFLICT(robot_index,notice_key)
            DO UPDATE SET message_id=excluded.message_id,status='pending'`).run(robot, notice.key, notice.node.id, id);
        }
      }
    }
    // 日期变更等标记只在至少一个已配置机器人成功入队后消除。
    if (configuredRobots(this.config).length) {
      for (const notice of candidates) {
        if (notice.kind === "change") this.db.prepare("UPDATE calendar_nodes SET change_pending=0 WHERE id=?").run(notice.node.id);
        if (notice.kind === "snooze") this.db.prepare("UPDATE calendar_nodes SET snooze_until=NULL WHERE id=?").run(notice.node.id);
      }
    }
  }
  private async daily(date: string) {
    const previous = this.db.prepare("SELECT attempts FROM calendar_daily WHERE day=?").get(date);
    const attempts = Number(previous?.attempts ?? 0) + 1;
    this.db.prepare("INSERT INTO calendar_daily(day,status,attempts) VALUES (?,'running',?) ON CONFLICT(day) DO UPDATE SET status='running',attempts=excluded.attempts").run(date, attempts);
    try {
      try { await this.sync(); }
      catch (error) { if (!this.get("last_sync_success") || this.get("source_url") !== this.url()) throw error; }
      if (!configuredRobots(this.config).length) throw new Error("备货提醒没有可用的钉钉机器人，请在设置中配置");
      this.enqueue(date);
      this.db.prepare("UPDATE calendar_daily SET status='success',error=?,retry_at=NULL WHERE day=?").run(this.get("last_sync_error") || null, date);
    } catch (error) {
      this.db.prepare("UPDATE calendar_daily SET status='failed',error=?,retry_at=? WHERE day=?").run(
        error instanceof Error ? error.message : String(error), new Date(this.deps.now().getTime() + 15 * 60_000).toISOString(), date);
    }
  }
  private async deliver() {
    const now = this.deps.now(), date = chinaDate(now), iso = now.toISOString();
    const messages = this.db.prepare("SELECT * FROM calendar_messages WHERE status IN ('pending','failed') AND attempts<4 AND (next_retry_at IS NULL OR next_retry_at<=?) ORDER BY created_at").all(iso) as Message[];
    for (const message of messages) {
      const original = parse<Notice[]>(message.notices);
      const notices = original.filter((notice) => {
        const row = this.db.prepare("SELECT * FROM calendar_nodes WHERE id=?").get(notice.node.id) as StoredNode | undefined;
        return row && row.active && !row.done && row.event_date >= date && row.revision === notice.revision && (!row.snooze_until || row.snooze_until <= date);
      });
      for (const notice of original.filter((item) => !notices.includes(item))) this.db.prepare("UPDATE calendar_receipts SET status='cancelled' WHERE robot_index=? AND notice_key=?").run(message.robot_index, notice.key);
      if (!notices.length) { this.db.prepare("UPDATE calendar_messages SET status='cancelled' WHERE id=?").run(message.id); continue; }
      const body = buildCalendarMessage(notices, date, this.url(), this.get("last_sync_error") ? this.get("last_sync_success") : undefined);
      let error: string | null = null;
      try {
        const results = await this.deps.send(this.config, body, [message.robot_index]);
        const result = results.find((item) => item.robotIndex === message.robot_index);
        if (!result?.ok) error = result?.error ?? "目标机器人未配置或没有返回发送结果";
      } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
      const attempts = message.attempts + 1;
      const retryAt = error && attempts < 4 ? new Date(now.getTime() + [60_000, 300_000, 900_000][attempts - 1]).toISOString() : null;
      this.db.prepare("UPDATE calendar_messages SET status=?,attempts=?,next_retry_at=?,sent_at=?,error=? WHERE id=?")
        .run(error ? "failed" : "sent", attempts, retryAt, error ? null : iso, error, message.id);
      for (const notice of notices) this.db.prepare("UPDATE calendar_receipts SET status=? WHERE robot_index=? AND notice_key=?").run(error ? "failed" : "sent", message.robot_index, notice.key);
    }
  }
  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.runTick().finally(() => { this.ticking = null; });
    return this.ticking;
  }
  private async runTick() {
    if (!this.config.calendar_enabled) return;
    const now = this.deps.now(), date = chinaDate(now);
    if (this.config.calendar_start_date && date < this.config.calendar_start_date) return;
    const clock = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
    const due = `${String(this.config.calendar_hour ?? 9).padStart(2, "0")}:${String(this.config.calendar_minute ?? 0).padStart(2, "0")}`;
    const daily = this.db.prepare("SELECT * FROM calendar_daily WHERE day=?").get(date);
    if (clock >= due && (!daily || (daily.status === "failed" && Number(daily.attempts) < 3 && String(daily.retry_at) <= now.toISOString()) || daily.status === "running")) await this.daily(date);
    await this.deliver();
  }
}
