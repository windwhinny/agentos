import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type {
  BudgetQuota,
  ChatMessage,
  ExitResult,
  OutputChunk,
  ProcessState,
  SpawnOptions,
  Usage,
} from '../types';

/**
 * SQLite 持久化存储：对齐 opencode 的 session/message/part 三表结构，
 * 扩展 process 表存进程树拓扑，使整棵运行时可序列化恢复。
 *
 * 语义映射：
 * - session  → 一次 Runtime 会话（含整棵进程树）
 * - process  → 进程树拓扑与状态（AgentOS 特色，OS 进程模型对齐）
 * - message  → 对话上下文 ChatMessage（对齐 opencode message.data.role）
 * - part     → 输出流 OutputChunk（对齐 opencode part.data.type）
 */

// -- 可序列化类型 --

/** SpawnOptions 中 tools 是函数，不可序列化；持久化时降级为 toolNames */
export type SerializableSpawnOptions = Omit<SpawnOptions, 'tools'> & { toolNames?: string[] };

export interface BudgetSnapshot {
  quota: BudgetQuota;
  usedTokens: number;
  usedTurns: number;
  startedAt: number;
}

export interface ProcessRecord {
  pid: number;
  ppid: number;
  name?: string;
  state: ProcessState;
  model: string;
  provider: string;
  usage: Usage;
  budget: BudgetSnapshot;
  turns: number;
  depth: number;
  spawnOptions: SerializableSpawnOptions;
  createdAt: number;
  exitedAt?: number;
  exitResult?: ExitResult;
}

export interface SessionMeta {
  id: string;
  title?: string;
  timeCreated: number;
  timeUpdated: number;
  nextPid: number;
  runtimeMeta: Record<string, unknown>;
}

export interface SessionSnapshot {
  session: SessionMeta;
  processes: ProcessRecord[];
  /** 按 pid 分组的对话上下文 */
  messagesByPid: Map<number, ChatMessage[]>;
}

export interface MessageRow {
  id: string;
  pid: number;
  message: ChatMessage;
  timeCreated: number;
}

// -- 工具函数 --

/** 把 SpawnOptions 转成可序列化形式：tools 函数 → toolNames */
export function toSerializableSpawnOptions(opts: SpawnOptions): SerializableSpawnOptions {
  const { tools, ...rest } = opts;
  return { ...rest, toolNames: tools?.map((t) => t.name) };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS session (
  id            TEXT PRIMARY KEY,
  title         TEXT,
  time_created  INTEGER NOT NULL,
  time_updated  INTEGER NOT NULL,
  next_pid      INTEGER NOT NULL DEFAULT 1,
  runtime_meta  TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS process (
  session_id    TEXT NOT NULL,
  pid           INTEGER NOT NULL,
  ppid          INTEGER NOT NULL,
  name          TEXT,
  state         TEXT NOT NULL,
  model         TEXT,
  provider      TEXT,
  usage         TEXT NOT NULL,
  budget        TEXT NOT NULL,
  turns         INTEGER NOT NULL,
  depth         INTEGER NOT NULL,
  spawn_options TEXT,
  created_at    INTEGER NOT NULL,
  exited_at     INTEGER,
  exit_result   TEXT,
  PRIMARY KEY (session_id, pid)
);
CREATE TABLE IF NOT EXISTS message (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  pid           INTEGER NOT NULL,
  role          TEXT NOT NULL,
  time_created  INTEGER NOT NULL,
  data          TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS part (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  message_id    TEXT,
  pid           INTEGER NOT NULL,
  type          TEXT NOT NULL,
  time_created  INTEGER NOT NULL,
  data          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_process_session ON process(session_id);
CREATE INDEX IF NOT EXISTS idx_message_session_pid ON message(session_id, pid, time_created);
CREATE INDEX IF NOT EXISTS idx_part_session_pid ON part(session_id, pid, time_created);
CREATE INDEX IF NOT EXISTS idx_part_message ON part(message_id);
`;

/**
 * 会话级 SQLite 存储。WAL 模式；批量写走事务。
 *
 * 一个实例绑定一个 db 文件，可承载多个 session。
 */
export class SessionStore {
  readonly db: DB;
  private open = true;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  private get writable(): boolean {
    return this.open;
  }

  // -- session --

  createSession(opts?: {
    id?: string;
    title?: string;
    runtimeMeta?: Record<string, unknown>;
  }): string {
    const id = opts?.id ?? `ses_${randomUUID()}`;
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO session (id, title, time_created, time_updated, next_pid, runtime_meta) VALUES (?,?,?,?,?,?)',
      )
      .run(id, opts?.title ?? null, now, now, 1, JSON.stringify(opts?.runtimeMeta ?? {}));
    return id;
  }

  getSession(id: string): SessionMeta | undefined {
    const row = this.db.prepare('SELECT * FROM session WHERE id = ?').get(id) as
      | {
          id: string;
          title: string | null;
          time_created: number;
          time_updated: number;
          next_pid: number;
          runtime_meta: string;
        }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      title: row.title ?? undefined,
      timeCreated: row.time_created,
      timeUpdated: row.time_updated,
      nextPid: row.next_pid,
      runtimeMeta: JSON.parse(row.runtime_meta ?? '{}'),
    };
  }

  listSessions(): SessionMeta[] {
    const rows = this.db
      .prepare('SELECT * FROM session ORDER BY time_updated DESC, rowid DESC')
      .all() as Array<{
      id: string;
      title: string | null;
      time_created: number;
      time_updated: number;
      next_pid: number;
      runtime_meta: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      title: row.title ?? undefined,
      timeCreated: row.time_created,
      timeUpdated: row.time_updated,
      nextPid: row.next_pid,
      runtimeMeta: JSON.parse(row.runtime_meta ?? '{}'),
    }));
  }

  updateSessionTitle(id: string, title: string): void {
    this.db
      .prepare('UPDATE session SET title = ?, time_updated = ? WHERE id = ?')
      .run(title, Date.now(), id);
  }

  setNextPid(id: string, nextPid: number): void {
    this.db
      .prepare('UPDATE session SET next_pid = ?, time_updated = ? WHERE id = ?')
      .run(nextPid, Date.now(), id);
  }

  deleteSession(id: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM part WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM message WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM process WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM session WHERE id = ?').run(id);
    })();
  }

  // -- process --

  upsertProcess(sessionId: string, rec: ProcessRecord): void {
    if (!this.writable) return;
    this.db
      .prepare(
        `INSERT INTO process (session_id, pid, ppid, name, state, model, provider, usage, budget,
                             turns, depth, spawn_options, created_at, exited_at, exit_result)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(session_id, pid) DO UPDATE SET
           state=excluded.state, usage=excluded.usage, budget=excluded.budget,
           turns=excluded.turns, exited_at=excluded.exited_at, exit_result=excluded.exit_result`,
      )
      .run(
        sessionId,
        rec.pid,
        rec.ppid,
        rec.name ?? null,
        rec.state,
        rec.model,
        rec.provider,
        JSON.stringify(rec.usage),
        JSON.stringify(rec.budget),
        rec.turns,
        rec.depth,
        JSON.stringify(rec.spawnOptions),
        rec.createdAt,
        rec.exitedAt ?? null,
        rec.exitResult ? JSON.stringify(rec.exitResult) : null,
      );
  }

  getProcesses(sessionId: string): ProcessRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM process WHERE session_id = ? ORDER BY pid')
      .all(sessionId) as Array<{
      pid: number;
      ppid: number;
      name: string | null;
      state: string;
      model: string | null;
      provider: string | null;
      usage: string;
      budget: string;
      turns: number;
      depth: number;
      spawn_options: string | null;
      created_at: number;
      exited_at: number | null;
      exit_result: string | null;
    }>;
    return rows.map((row) => ({
      pid: row.pid,
      ppid: row.ppid,
      name: row.name ?? undefined,
      state: row.state as ProcessState,
      model: row.model ?? '',
      provider: row.provider ?? '',
      usage: JSON.parse(row.usage),
      budget: JSON.parse(row.budget),
      turns: row.turns,
      depth: row.depth,
      spawnOptions: row.spawn_options ? JSON.parse(row.spawn_options) : {},
      createdAt: row.created_at,
      exitedAt: row.exited_at ?? undefined,
      exitResult: row.exit_result ? JSON.parse(row.exit_result) : undefined,
    }));
  }

  // -- message（对话上下文）--

  appendMessage(sessionId: string, pid: number, msg: ChatMessage): string {
    if (!this.writable) return '';
    const id = `msg_${randomUUID()}`;
    this.db
      .prepare(
        'INSERT INTO message (id, session_id, pid, role, time_created, data) VALUES (?,?,?,?,?,?)',
      )
      .run(id, sessionId, pid, msg.role, Date.now(), JSON.stringify(msg));
    this.touchSession(sessionId);
    return id;
  }

  getMessages(sessionId: string, pid?: number): MessageRow[] {
    const stmt = pid
      ? this.db.prepare('SELECT * FROM message WHERE session_id = ? AND pid = ? ORDER BY rowid')
      : this.db.prepare('SELECT * FROM message WHERE session_id = ? ORDER BY pid, rowid');
    const rows = (pid ? stmt.all(sessionId, pid) : stmt.all(sessionId)) as Array<{
      id: string;
      pid: number;
      role: string;
      time_created: number;
      data: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      pid: row.pid,
      message: JSON.parse(row.data) as ChatMessage,
      timeCreated: row.time_created,
    }));
  }

  // -- part（输出流 chunk）--

  appendOutput(sessionId: string, pid: number, chunk: OutputChunk, messageId?: string): string {
    if (!this.writable) return '';
    const id = `prt_${randomUUID()}`;
    this.db
      .prepare(
        'INSERT INTO part (id, session_id, message_id, pid, type, time_created, data) VALUES (?,?,?,?,?,?,?)',
      )
      .run(id, sessionId, messageId ?? null, pid, chunk.type, chunk.ts, JSON.stringify(chunk.data));
    return id;
  }

  getOutput(sessionId: string, pid: number): OutputChunk[] {
    const rows = this.db
      .prepare('SELECT * FROM part WHERE session_id = ? AND pid = ? ORDER BY rowid')
      .all(sessionId, pid) as Array<{ type: string; data: string; time_created: number }>;
    return rows.map((row) => ({
      type: row.type as OutputChunk['type'],
      data: JSON.parse(row.data),
      ts: row.time_created,
    }));
  }

  // -- 批量快照与恢复 --

  /** 整 session 快照：进程树 + 对话上下文（不含输出流，输出流按需单独取） */
  snapshot(sessionId: string): SessionSnapshot | undefined {
    const session = this.getSession(sessionId);
    if (!session) return undefined;
    const processes = this.getProcesses(sessionId);
    const messagesByPid = new Map<number, ChatMessage[]>();
    for (const row of this.getMessages(sessionId)) {
      const list = messagesByPid.get(row.pid) ?? [];
      list.push(row.message);
      messagesByPid.set(row.pid, list);
    }
    return { session, processes, messagesByPid };
  }

  /** 统计信息（调试/内省用） */
  stats(sessionId: string): { processes: number; messages: number; parts: number } {
    const processes = (
      this.db.prepare('SELECT COUNT(*) as n FROM process WHERE session_id = ?').get(sessionId) as {
        n: number;
      }
    ).n;
    const messages = (
      this.db.prepare('SELECT COUNT(*) as n FROM message WHERE session_id = ?').get(sessionId) as {
        n: number;
      }
    ).n;
    const parts = (
      this.db.prepare('SELECT COUNT(*) as n FROM part WHERE session_id = ?').get(sessionId) as {
        n: number;
      }
    ).n;
    return { processes, messages, parts };
  }

  private touchSession(id: string): void {
    this.db.prepare('UPDATE session SET time_updated = ? WHERE id = ?').run(Date.now(), id);
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.db.close();
  }
}
