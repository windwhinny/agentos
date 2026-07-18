import { EventEmitter } from 'node:events';
import { Budget } from './budget';
import { Process } from './process';
import { UserAPI } from './user';
import { makeBuiltinTools } from './builtin-tools';
import { restoreCheckpoint, takeCheckpoint, type RuntimeSnapshot } from './checkpoint';
import { WaitForGraph } from '../sync/waitfor';
import { Semaphore } from '../sync/semaphore';
import { Mutex } from '../sync/mutex';
import { Barrier } from '../sync/barrier';
import { Pipe, type PipeOptions } from '../ipc/pipe';
import { Blackboard } from '../ipc/blackboard';
import { Supervisor } from './supervisor';
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
    if (opts.isolation === 'worker') throw new Error('worker isolation is only available on the server runtime');
    const proc = new Process(opts, this, parent);
    this.register(proc);
    proc.start();
    return proc;
  }

  /** fork：与源进程同级的兄弟分支，COW 共享上下文 */
  fork(pid: number, hint?: string): Process {
    const src = this.getRequired(pid);
    const parent = src.ppid ? this.table.get(src.ppid) : undefined;
    const proc = new Process({ ...src.spawnOptions, mode: 'async' }, this, parent, src);
    if (hint) proc.appendMessage({ role: 'user', content: hint, meta: { from: pid, kind: 'fork-hint' } });
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
      throw new PermissionError(`pid ${requesterPid} cannot introspect pid ${targetPid} (outside subtree)`);
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

  pipeline(): Array<{ fromPid: number; toPid: number; name?: string; mode: string; closed: boolean }> {
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

  // —— ps ——

  ps(): ProcessSnapshot[] {
    return [...this.table.values()].sort((a, b) => a.pid - b.pid).map((p) => p.snapshot());
  }
}
