import { EventEmitter } from 'node:events';
import { Budget } from './budget';
import { Process } from './process';
import { UserAPI } from './user';
import { makeBuiltinTools } from './builtin-tools';
import {
  restoreCheckpoint,
  takeCheckpoint,
  type RuntimeSnapshot,
  type ProcessSnapshotEntry,
} from './checkpoint';
import { WaitForGraph } from '../sync/waitfor';
import { Semaphore } from '../sync/semaphore';
import { Mutex } from '../sync/mutex';
import { Barrier } from '../sync/barrier';
import { Pipe, type PipeOptions } from '../ipc/pipe';
import { Blackboard } from '../ipc/blackboard';
import { Supervisor } from './supervisor';
import { WorkerProcess } from '../worker/worker-process';
import {
  SessionStore,
  toSerializableSpawnOptions,
  type ProcessRecord,
  type SerializableSpawnOptions,
} from '../store/sqlite-store';
import {
  MaxDepthError,
  MaxWidthError,
  PermissionError,
  ProcessNotFoundError,
  ToolNotAllowedError,
} from '../errors';
import type {
  BudgetQuota,
  LLMProvider,
  ModelConfig,
  OutputChunk,
  ProcessSnapshot,
  SpawnOptions,
  Tool,
} from '../types';

export interface RuntimeOptions {
  providers: LLMProvider[];
  defaultProvider?: string;
  defaults?: { model?: ModelConfig };
  models?: Record<string, string>;
  budget?: BudgetQuota;
  maxDepth?: number;
  maxWidth?: number;
  /** 持久化存储：传入后可通过 attachPersistence/resume 激活 */
  store?: SessionStore;
}

export class AgentRuntime extends EventEmitter {
  private table = new Map<number, Process>();
  private nextPid = 1;
  readonly rootBudget: Budget;
  readonly defaults: { model: ModelConfig };
  readonly models: Record<string, string>;
  private providers = new Map<string, LLMProvider>();
  /** 模型 id → provider 名:多供应商共存时按模型选供应商(registerProvider 时登记) */
  private modelProviders = new Map<string, string>();
  private defaultProviderName: string;
  readonly maxDepth: number;
  readonly maxWidth: number;
  readonly user: UserAPI;
  readonly builtinTools: Map<string, Tool>;
  /** wait-for 图：信号量/管道阻塞边注册于此，用于死锁检测 */
  readonly waitFor = new WaitForGraph();
  /** 共享黑板：CAS KV，全进程树共享 */
  readonly blackboard = new Blackboard();
  readonly supervisor: Supervisor;
  private pipes = new Set<Pipe>();
  /** 持久化存储（可选） */
  private store?: SessionStore;
  private sessionId?: string;
  /** 恢复中标志：恢复期间抑制持久化 hook，避免回写 */
  private restoring = false;

  constructor(opts: RuntimeOptions) {
    super();
    this.rootBudget = new Budget(opts.budget ?? {});
    this.defaults = { model: opts.defaults?.model ?? {} };
    this.models = opts.models ?? {};
    for (const p of opts.providers) this.providers.set(p.name, p);
    this.defaultProviderName = opts.defaultProvider ?? opts.providers[0]?.name ?? '';
    this.maxDepth = opts.maxDepth ?? 4;
    this.maxWidth = opts.maxWidth ?? 16;
    this.builtinTools = makeBuiltinTools();
    this.supervisor = new Supervisor(this);
    this.user = new UserAPI(this);
    this.store = opts.store;
  }

  get activeSessionId(): string | undefined {
    return this.sessionId;
  }

  // —— PID / 注册 ——

  allocPid(preferred?: number): number {
    if (preferred !== undefined) {
      if (preferred >= this.nextPid) this.nextPid = preferred + 1;
      return preferred;
    }
    return this.nextPid++;
  }

  get currentNextPid(): number {
    return this.nextPid;
  }

  restorePids(nextPid: number): void {
    if (nextPid > this.nextPid) this.nextPid = nextPid;
  }

  register(proc: Process): void {
    this.table.set(proc.pid, proc);
    const parent = proc.ppid ? this.table.get(proc.ppid) : undefined;
    parent?.childrenPids.add(proc.pid);
    this.emit('process:created', proc.snapshot());
    // session 已激活则挂持久化 hook 并补存初始消息
    this.wirePersistence(proc);
  }

  allProcesses(): Process[] {
    return [...this.table.values()];
  }

  // —— 创建 ——

  /** PID 1：会话根进程（无特权，只是默认 attach 点） */
  init(opts: SpawnOptions): Process {
    const proc = new Process(opts, this, undefined);
    this.register(proc);
    proc.start();
    return proc;
  }

  spawn(ppid: number, opts: SpawnOptions): Process {
    const parent = this.getRequired(ppid);
    if (parent.depth + 1 > this.maxDepth) {
      throw new MaxDepthError(`max depth ${this.maxDepth} exceeded (parent pid=${ppid})`);
    }
    const aliveSiblings = this.childrenOf(ppid).filter((c) => !c.isExited).length;
    if (aliveSiblings >= this.maxWidth) {
      throw new MaxWidthError(`max width ${this.maxWidth} exceeded (parent pid=${ppid})`);
    }
    const parentTools = new Set(parent.userToolNames());
    for (const t of opts.tools ?? []) {
      if (!parentTools.has(t.name)) throw new ToolNotAllowedError(t.name);
    }
    const proc =
      opts.isolation === 'worker'
        ? new WorkerProcess(opts, this, parent)
        : new Process(opts, this, parent);
    this.register(proc);
    proc.start();
    return proc;
  }

  /** fork：与源进程同级的兄弟分支，COW 共享上下文 */
  fork(pid: number, hint?: string): Process {
    const src = this.getRequired(pid);
    const parent = src.ppid ? this.table.get(src.ppid) : undefined;
    const proc = new Process({ ...src.spawnOptions, mode: 'async' }, this, parent, src);
    if (hint)
      proc.appendMessage({ role: 'user', content: hint, meta: { from: pid, kind: 'fork-hint' } });
    this.register(proc);
    proc.start();
    return proc;
  }

  // —— 查询 ——

  get(pid: number): Process | undefined {
    return this.table.get(pid);
  }

  getRequired(pid: number): Process {
    const p = this.table.get(pid);
    if (!p) throw new ProcessNotFoundError(pid);
    return p;
  }

  childrenOf(pid: number): Process[] {
    return [...this.getRequired(pid).childrenPids]
      .map((c) => this.table.get(c))
      .filter((p): p is Process => p !== undefined);
  }

  descendantsOf(pid: number): Process[] {
    const out: Process[] = [];
    const queue = [...this.childrenOf(pid)];
    while (queue.length) {
      const p = queue.shift()!;
      out.push(p);
      queue.push(...this.childrenOf(p.pid));
    }
    return out;
  }

  // —— 内省（父看子，子树边界校验） ——

  readOutput(requesterPid: number, targetPid: number, since?: number): OutputChunk[] {
    this.assertSubtreeAccess(requesterPid, targetPid);
    return this.getRequired(targetPid).stdout.read(since);
  }

  tap(requesterPid: number, targetPid: number, cb: (chunk: OutputChunk) => void): () => void {
    this.assertSubtreeAccess(requesterPid, targetPid);
    return this.getRequired(targetPid).stdout.tap(cb);
  }

  private assertSubtreeAccess(requesterPid: number, targetPid: number): void {
    if (requesterPid === 0 || requesterPid === targetPid) return;
    const ok = this.descendantsOf(requesterPid).some((p) => p.pid === targetPid);
    if (!ok) {
      throw new PermissionError(
        `pid ${requesterPid} cannot introspect pid ${targetPid} (outside subtree)`,
      );
    }
  }

  // —— 信号 ——

  signal(pid: number, sig: string, opts?: { cascade?: boolean }): void {
    const proc = this.getRequired(pid);
    if (sig === 'SIGKILL' || opts?.cascade) {
      for (const d of this.descendantsOf(pid)) d.signal(sig);
    }
    proc.signal(sig);
  }

  notifyExit(proc: Process): void {
    const parent = proc.ppid ? this.table.get(proc.ppid) : undefined;
    parent?.emit('SIGCHLD', {
      pid: proc.pid,
      status: proc.exitResult?.status,
      reason: proc.exitResult?.reason,
    });
    this.emit('process:exit', proc.snapshot());
    this.supervisor.onChildExit(proc);
    // 退出态落盘
    this.persistProcess(proc);
  }

  // —— 模型解析 ——

  resolveModel(cfg: ModelConfig): { model: string; provider: LLMProvider } {
    const raw = cfg.model ?? '';
    const model = this.models[raw] ?? raw;
    if (!model) throw new Error('no model configured (process/parent/runtime defaults all empty)');
    const providerName = cfg.provider ?? this.modelProviders.get(model) ?? this.defaultProviderName;
    const provider = this.providers.get(providerName);
    if (!provider) throw new Error(`provider not registered: ${providerName}`);
    return { model, provider };
  }

  getProvider(name: string): LLMProvider | undefined {
    return this.providers.get(name);
  }

  /** 动态注册供应商及其模型清单(UI 模型管理用);模型 id 与该供应商绑定 */
  registerProvider(provider: LLMProvider, opts?: { models?: string[] }): void {
    this.providers.set(provider.name, provider);
    for (const m of opts?.models ?? []) this.modelProviders.set(m, provider.name);
  }

  /** 注销供应商并解绑其模型;若它是默认供应商则回退到第一个 */
  removeProvider(name: string): void {
    this.providers.delete(name);
    for (const [m, p] of this.modelProviders) if (p === name) this.modelProviders.delete(m);
    if (this.defaultProviderName === name)
      this.defaultProviderName = this.providers.keys().next().value ?? '';
  }

  /** 切换全局默认模型(新进程/未显式指定模型的进程用它) */
  setDefaultModel(model: string): void {
    this.defaults.model = { ...this.defaults.model, model };
  }

  /** 模型清单(管理面板用):供应商 → 其绑定的模型 id 列表 */
  listProviders(): Array<{ name: string; models: string[] }> {
    const byProvider = new Map<string, string[]>();
    for (const name of this.providers.keys()) byProvider.set(name, []);
    for (const [m, p] of this.modelProviders) byProvider.get(p)?.push(m);
    return [...byProvider.entries()].map(([name, models]) => ({ name, models }));
  }

  // —— 同步原语 ——

  semaphore(count: number): Semaphore {
    return new Semaphore(count, this.waitFor);
  }

  mutex(): Mutex {
    return new Mutex(this.waitFor);
  }

  barrier(parties: number): Barrier {
    return new Barrier(parties);
  }

  // —— 管道 ——

  pipe(fromPid: number, toPid: number, opts?: PipeOptions): Pipe {
    this.getRequired(fromPid);
    this.getRequired(toPid);
    const p = new Pipe(this, fromPid, toPid, opts);
    this.pipes.add(p);
    return p;
  }

  unregisterPipe(p: Pipe): void {
    this.pipes.delete(p);
  }

  pipeline(): Array<{
    fromPid: number;
    toPid: number;
    name?: string;
    mode: string;
    closed: boolean;
  }> {
    return [...this.pipes].map((p) => ({
      fromPid: p.fromPid,
      toPid: p.toPid,
      name: p.name,
      mode: p.mode,
      closed: p.closed,
    }));
  }

  // —— checkpoint ——

  checkpoint(): RuntimeSnapshot {
    return takeCheckpoint(this);
  }

  restore(snap: RuntimeSnapshot): void {
    restoreCheckpoint(this, snap);
  }

  // -- 持久化 --

  /**
   * 激活持久化：新建 session 并自动持久化后续所有进程；
   * 或 resume=true 时从已有 session 恢复进程树。
   * 返回 sessionId。重复调用幂等（返回已激活的 sessionId）。
   */
  attachPersistence(opts?: {
    sessionId?: string;
    title?: string;
    resume?: boolean;
    runtimeMeta?: Record<string, unknown>;
  }): string {
    if (!this.store) throw new Error('no store configured: pass store in RuntimeOptions');
    if (this.sessionId) return this.sessionId;
    if (opts?.resume && opts.sessionId) {
      return this.resume(opts.sessionId);
    }
    this.sessionId = this.store.createSession({
      id: opts?.sessionId,
      title: opts?.title,
      runtimeMeta: opts?.runtimeMeta ?? {
        budget: this.rootBudget.quota,
        maxDepth: this.maxDepth,
        maxWidth: this.maxWidth,
        defaults: this.defaults,
        models: this.models,
      },
    });
    // 为已存在的进程补建持久化（init 可能已先于 attach 创建）
    for (const proc of this.allProcesses()) this.wirePersistence(proc);
    return this.sessionId;
  }

  /**
   * 从 store 恢复整棵进程树：进程拓扑、状态、对话上下文、预算。
   * 工具函数不可序列化，需通过 toolRegistry 按 name 重新绑定。
   */
  resume(sessionId: string, opts?: { toolRegistry?: Map<string, Tool> }): string {
    if (!this.store) throw new Error('no store configured: pass store in RuntimeOptions');
    const snap = this.store.snapshot(sessionId);
    if (!snap) throw new Error(`session not found: ${sessionId}`);
    this.restoring = true;
    try {
      this.restorePids(snap.session.nextPid);
      const entries: ProcessSnapshotEntry[] = snap.processes.map((rec) => ({
        pid: rec.pid,
        ppid: rec.ppid,
        name: rec.name,
        state: rec.state,
        spawnOptions: restoreSpawnOptions(rec.spawnOptions, opts?.toolRegistry),
        modelParams: rec.spawnOptions.model ?? {},
        messages: snap.messagesByPid.get(rec.pid) ?? [],
        usage: rec.usage,
        turns: rec.turns,
        budget: rec.budget,
        exitResult: rec.exitResult,
        createdAt: rec.createdAt,
        exitedAt: rec.exitedAt,
      }));
      restoreCheckpoint(this, { version: 1, nextPid: snap.session.nextPid, processes: entries });
      this.sessionId = sessionId;
    } finally {
      this.restoring = false;
    }
    // 恢复完成后挂 hook，后续变更持续持久化；跳过消息补存（已从 store 加载）
    for (const proc of this.allProcesses()) this.wirePersistence(proc, { skipMessages: true });
    return sessionId;
  }

  /** 取消持久化：摘除所有 hook，但保留已写入数据 */
  detachPersistence(): void {
    for (const proc of this.allProcesses()) {
      proc.onPersistMessage = undefined;
      proc.onPersistOutput = undefined;
    }
    this.sessionId = undefined;
  }

  /** 主动把当前进程树全量快照落盘（不依赖 hook 增量） */
  flush(): void {
    if (!this.store || !this.sessionId) return;
    for (const proc of this.allProcesses()) this.persistProcess(proc);
    this.store.setNextPid(this.sessionId, this.nextPid);
  }

  private wirePersistence(proc: Process, opts?: { skipMessages?: boolean }): void {
    if (!this.store || !this.sessionId || this.restoring) return;
    const sid = this.sessionId;
    proc.onPersistMessage = (msg) => {
      if (this.restoring) return;
      this.store!.appendMessage(sid, proc.pid, msg);
    };
    proc.onPersistOutput = (chunk) => {
      if (this.restoring) return;
      this.store!.appendOutput(sid, proc.pid, chunk);
    };
    this.persistProcess(proc);
    if (!opts?.skipMessages) {
      for (const msg of proc.context.messages) this.store!.appendMessage(sid, proc.pid, msg);
    }
  }

  private persistProcess(proc: Process): void {
    if (!this.store || !this.sessionId) return;
    const rec: ProcessRecord = {
      pid: proc.pid,
      ppid: proc.ppid,
      name: proc.name,
      state: proc.state,
      model: proc.resolvedModel,
      provider: proc.provider.name,
      usage: { ...proc.usage },
      budget: proc.budget.snapshot(),
      turns: proc.turns,
      depth: proc.depth,
      spawnOptions: toSerializableSpawnOptions(proc.spawnOptions),
      createdAt: proc.createdAt,
      exitedAt: proc.exitedAt,
      exitResult: proc.exitResult,
    };
    this.store.upsertProcess(this.sessionId, rec);
  }

  // —— ps ——

  ps(): ProcessSnapshot[] {
    return [...this.table.values()].sort((a, b) => a.pid - b.pid).map((p) => p.snapshot());
  }
}

/** 反序列化 SpawnOptions：toolNames 经 registry 重新绑定回工具函数 */
function restoreSpawnOptions(
  s: SerializableSpawnOptions,
  registry?: Map<string, Tool>,
): SpawnOptions {
  const { toolNames, ...rest } = s;
  const opts: SpawnOptions = { ...rest };
  if (toolNames?.length && registry) {
    const tools = toolNames.map((n) => registry.get(n)).filter((t): t is Tool => !!t);
    if (tools.length) opts.tools = tools;
  }
  return opts;
}
