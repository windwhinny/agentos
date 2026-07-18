import { EventEmitter } from 'node:events';
import { Budget } from './budget';
import { StdinQueue, StdoutStream } from '../ipc/stdio';
import {
  BudgetExceededError,
  InterruptedError,
  KilledError,
  TermExit,
  TimeoutError,
} from '../errors';
import { AbortError } from '../utils';
import { textOf } from '../types';
import type { AgentRuntime } from './runtime';
import type { ProcessSnapshotEntry } from './checkpoint';
import type {
  BlockedReason,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ContentPart,
  ExitResult,
  LLMProvider,
  ModelConfig,
  OutputChunk,
  ProcessSnapshot,
  ProcessState,
  SpawnOptions,
  Tool,
  ToolCall,
  Usage,
} from '../types';

const zeroUsage = (): Usage => ({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });

export class Process extends EventEmitter {
  readonly pid: number;
  readonly ppid: number;
  readonly name?: string;
  state: ProcessState = 'created';
  blockedReason?: BlockedReason;
  readonly childrenPids = new Set<number>();
  context: { messages: ChatMessage[]; shared: boolean } = { messages: [], shared: false };
  modelParams: ModelConfig;
  resolvedModel: string;
  provider: LLMProvider;
  budget: Budget;
  readonly usage: Usage = zeroUsage();
  turns = 0;
  stdin: StdinQueue;
  stdout: StdoutStream;
  stderr: StdoutStream;
  /** pipe mode='tool' 的待取消息 */
  pipeInbox: StdinQueue;
  readonly depth: number;
  readonly createdAt: number = Date.now();
  exitedAt?: number;
  exitResult?: ExitResult;
  spawnOptions: SpawnOptions;
  protected abort: AbortController = new AbortController();
  private flags = { term: false, stop: false, interrupt: false };
  private pauseWaiter?: () => void;
  /** 当前 LLM 调用的独立取消器（中断只取消本轮生成，不杀进程） */
  private callAbort?: AbortController;
  private lastOutput = '';
  private exitDeferred!: { promise: Promise<ExitResult>; resolve: (r: ExitResult) => void };
  protected started = false;
  private userTools = new Map<string, Tool>();
  private allTools = new Map<string, Tool>();
  private signalHandlers = new Map<string, Array<(proc: Process) => void>>();
  /** 持久化 hook：由 runtime 在 attachPersistence 后注入，appendMessage/emitOutput 时回调 */
  onPersistMessage?: (msg: ChatMessage) => void;
  onPersistOutput?: (chunk: OutputChunk) => void;

  constructor(
    opts: SpawnOptions,
    readonly runtime: AgentRuntime,
    readonly parent?: Process,
    forkOf?: Process,
    preferredPid?: number,
  ) {
    super();
    this.spawnOptions = opts;
    this.pid = runtime.allocPid(preferredPid);
    this.ppid = parent?.pid ?? 0;
    this.name = opts.name;
    this.depth = (parent?.depth ?? -1) + 1;
    this.stdin = new StdinQueue(opts.stdinCapacity ?? 1024);
    this.stdout = new StdoutStream(opts.stdoutCapacity ?? 1000);
    this.stderr = new StdoutStream(200);
    this.pipeInbox = new StdinQueue(1024);
    this.budget = new Budget(opts.budget ?? {}, parent?.budget ?? runtime.rootBudget);
    // 模型配置三级继承：进程 > 父 > runtime 默认
    this.modelParams = { ...runtime.defaults.model, ...parent?.modelParams, ...opts.model };
    const resolved = runtime.resolveModel(this.modelParams);
    this.resolvedModel = resolved.model;
    this.provider = resolved.provider;
    // 取消链：父 abort → 子 abort
    parent?.abort.signal.addEventListener('abort', () => this.abort.abort(), { once: true });
    // 工具：内置系统调用 + 用户白名单
    for (const t of opts.tools ?? []) this.userTools.set(t.name, t);
    this.allTools = new Map([...runtime.builtinTools, ...this.userTools]);
    // 上下文：fork 走 COW 共享；否则初始化 system + task
    if (forkOf) {
      this.context = { messages: forkOf.context.messages, shared: true };
      forkOf.context.shared = true;
    } else {
      if (opts.systemPrompt) this.appendMessage({ role: 'system', content: opts.systemPrompt });
      this.appendMessage({ role: 'user', content: opts.task });
    }
    this.resetExitDeferred();
    this.state = 'ready';
  }

  // —— 基础 ——

  get isExited(): boolean {
    return this.state === 'done' || this.state === 'failed' || this.state === 'killed';
  }

  userToolNames(): string[] {
    return [...this.userTools.keys()];
  }

  appendMessage(msg: ChatMessage): void {
    if (this.context.shared) {
      this.context = { messages: this.context.messages.slice(), shared: false };
    }
    const frozen = Object.freeze(msg);
    this.context.messages.push(frozen);
    this.onPersistMessage?.(frozen);
  }

  /** 结构化输出：推入 stdout 环形缓冲，并触发持久化 hook */
  protected emitOutput(chunk: OutputChunk): void {
    this.stdout.push(chunk);
    this.onPersistOutput?.(chunk);
  }

  private resetExitDeferred(): void {
    let resolve!: (r: ExitResult) => void;
    const promise = new Promise<ExitResult>((r) => {
      resolve = r;
    });
    this.exitDeferred = { promise, resolve };
  }

  protected emitState(): void {
    this.runtime.emit('process:state', this.snapshot());
  }

  protected setBlocked(reason: BlockedReason): void {
    this.state = 'blocked';
    this.blockedReason = reason;
    this.emitState();
  }

  protected setRunning(): void {
    if (this.isExited) return;
    this.state = 'running';
    this.blockedReason = undefined;
    this.emitState();
  }

  // —— 生命周期 ——

  start(): void {
    if (this.started || this.isExited) return;
    this.started = true;
    this.state = 'running';
    this.emitState();
    void this.runLoop();
  }

  /**
   * 恢复已退出的进程：重开 stdin、重置退出态，保留对话上下文。
   * 不自动 start--调用方应在注入消息后调用 start()。
   */
  revive(): void {
    if (!this.isExited) return;
    this.state = 'ready';
    this.exitResult = undefined;
    this.exitedAt = undefined;
    this.abort = new AbortController();
    this.flags = { term: false, stop: false, interrupt: false };
    this.callAbort = undefined;
    this.started = false;
    this.stdin.reopen();
    this.pipeInbox.reopen();
    this.resetExitDeferred();
    this.emitState();
  }

  protected async runLoop(): Promise<void> {
    try {
      const output = await this.loop();
      this.finish({
        pid: this.pid,
        status: 'done',
        reason: 'DONE',
        exitCode: 0,
        output,
        usage: { ...this.usage },
        turns: this.turns,
      });
    } catch (err) {
      this.finish(this.toExit(err));
    }
  }

  private toExit(err: unknown): ExitResult {
    const base = {
      pid: this.pid,
      output: this.lastOutput,
      usage: { ...this.usage },
      turns: this.turns,
    };
    if (err instanceof TermExit)
      return { ...base, status: 'done' as const, reason: 'SIGTERM', exitCode: 0 };
    if (err instanceof BudgetExceededError) {
      const reason =
        err.kind === 'turns' ? 'MAX_TURNS' : err.kind === 'wall' ? 'TIMEOUT' : 'BUDGET_EXCEEDED';
      return { ...base, status: 'killed' as const, reason, exitCode: 125, error: err.message };
    }
    if (
      err instanceof KilledError ||
      this.abort.signal.aborted ||
      (err as Error)?.name === 'AbortError'
    ) {
      return {
        ...base,
        status: 'killed' as const,
        reason: 'SIGKILL',
        exitCode: 137,
        error: 'killed',
      };
    }
    const e = err as Error;
    return {
      ...base,
      status: 'failed' as const,
      reason: 'ERROR',
      exitCode: 1,
      error: e?.message ?? String(err),
    };
  }

  protected finish(result: ExitResult): void {
    if (this.isExited) return;
    this.exitResult = result;
    this.state = result.status;
    this.exitedAt = Date.now();
    this.emitOutput({ type: 'result', data: result.output, ts: Date.now() });
    this.stdin.close();
    this.pipeInbox.close();
    this.exitDeferred.resolve(result);
    this.emitState();
    this.runtime.notifyExit(this);
  }

  // —— 运行循环 ——

  private async loop(): Promise<string> {
    while (true) {
      await this.stepBoundary();
      this.drainInbox();
      this.setBlocked('ON_LLM');
      let res: ChatResponse;
      try {
        res = await this.callModel();
      } catch (e) {
        if (e instanceof InterruptedError) {
          await this.onInterrupted(e);
          continue;
        }
        throw e;
      }
      this.setRunning();
      this.budget.consumeTokens(res.usage.totalTokens);
      this.usage.promptTokens += res.usage.promptTokens;
      this.usage.completionTokens += res.usage.completionTokens;
      this.usage.totalTokens += res.usage.totalTokens;
      this.turns += 1;
      this.budget.consumeTurn();
      const msg: ChatMessage = {
        role: 'assistant',
        content: res.message.content ?? '',
        ...(res.message.reasoning ? { reasoning: res.message.reasoning } : {}),
        ...(res.message.tool_calls?.length ? { tool_calls: res.message.tool_calls } : {}),
      };
      this.appendMessage(msg);
      if (msg.content) this.lastOutput = textOf(msg.content);
      if (!msg.tool_calls?.length) return this.lastOutput;
      const results = await Promise.all(msg.tool_calls.map((call) => this.execTool(call)));
      for (const { call, out } of results) {
        this.appendMessage({ role: 'tool', content: out, tool_call_id: call.id, name: call.name });
        this.emitOutput({
          type: 'tool',
          data: { name: call.name, args: call.arguments, output: out },
          ts: Date.now(),
        });
      }
    }
  }

  /** 调模型：流式优先（中间帧实时上屏），每轮调用独立取消器以支持「中断生成但不杀进程」 */
  private async callModel(): Promise<ChatResponse> {
    const req: ChatRequest = {
      model: this.resolvedModel,
      messages: [...this.context.messages],
      tools: this.allTools.size
        ? [...this.allTools.values()].map(({ name, description, parameters }) => ({
            name,
            description,
            parameters,
          }))
        : undefined,
      temperature: this.modelParams.temperature,
      maxTokens: this.modelParams.maxTokens,
      topP: this.modelParams.topP,
    };
    if (!this.provider.chatStream) {
      const res = await this.provider.chat({ ...req, signal: this.abort.signal });
      if (res.message.content || res.message.reasoning) {
        this.emitOutput({
          type: 'assistant',
          data: {
            text: res.message.content ?? '',
            ...(res.message.reasoning ? { thinking: res.message.reasoning } : {}),
          },
          ts: Date.now(),
        });
      }
      return res;
    }
    this.flags.interrupt = false;
    const id = `p${this.pid}_t${this.turns + 1}_${Date.now()}`;
    const callAbort = new AbortController();
    this.callAbort = callAbort;
    const onKill = () => callAbort.abort();
    this.abort.signal.addEventListener('abort', onKill, { once: true });
    let text = '';
    let thinking = '';
    try {
      const res = await this.provider.chatStream(
        { ...req, signal: callAbort.signal },
        {
          onThinking: (acc) => {
            thinking = acc;
            this.pushStream(id, text, thinking, false);
          },
          onText: (acc) => {
            text = acc;
            this.pushStream(id, text, thinking, false);
          },
        },
      );
      text = res.message.content ?? text;
      thinking = res.message.reasoning ?? thinking;
      this.pushStream(id, text, thinking, true);
      // 生成刚结束的一瞬间按下的中断：同样按中断处理（保留完整输出，转 ON_INBOX）
      if (this.flags.interrupt && !this.abort.signal.aborted)
        throw new InterruptedError(text, thinking);
      return res;
    } catch (e) {
      if (this.flags.interrupt && !this.abort.signal.aborted) {
        this.pushStream(id, text, thinking, true);
        throw new InterruptedError(text, thinking);
      }
      throw e;
    } finally {
      this.abort.signal.removeEventListener('abort', onKill);
      this.callAbort = undefined;
    }
  }

  /** 流式中间帧：同 id 覆盖，读取方（stdout.read / UI）按 id 取最后一帧 */
  private pushStream(id: string, text: string, thinking: string, done: boolean): void {
    if (!text && !thinking) return;
    this.emitOutput({
      type: 'assistant',
      id,
      done,
      data: { text, ...(thinking ? { thinking } : {}) },
      ts: Date.now(),
    });
  }

  /** 中断语义（Codex Esc）：部分输出落账、注入中断标记、转 ON_INBOX 等用户下一步 */
  private async onInterrupted(e: InterruptedError): Promise<void> {
    this.flags.interrupt = false;
    if (e.partialText || e.partialThinking) {
      this.appendMessage({
        role: 'assistant',
        content: e.partialText,
        ...(e.partialThinking ? { reasoning: e.partialThinking } : {}),
      });
      if (e.partialText) this.lastOutput = e.partialText;
    }
    this.appendMessage({
      role: 'user',
      content: '（生成被用户中断）',
      meta: { from: 0, kind: 'interrupt' },
    });
    this.emitOutput({ type: 'stderr', data: '⏹ 生成被用户中断', ts: Date.now() });
    this.setBlocked('ON_INBOX');
    await this.waitInbox();
    this.setRunning();
  }

  /** ON_INBOX 等待：stdin 来消息 / 信号唤醒 / SIGKILL 中止 */
  private waitInbox(): Promise<void> {
    if (this.stdin.size > 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.stdin.off('write', onWrite);
        this.abort.signal.removeEventListener('abort', onAbort);
        if (this.pauseWaiter === wake) this.pauseWaiter = undefined;
      };
      const onWrite = () => {
        cleanup();
        resolve();
      };
      const onAbort = () => {
        cleanup();
        reject(new AbortError());
      };
      const wake = () => {
        cleanup();
        resolve();
      };
      this.pauseWaiter = wake;
      this.stdin.on('write', onWrite);
      this.abort.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private async execTool(call: ToolCall): Promise<{ call: ToolCall; out: string }> {
    this.setBlocked('ON_TOOL');
    try {
      const tool = this.allTools.get(call.name);
      if (!tool) return { call, out: `Error: tool '${call.name}' not allowed` };
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.arguments || '{}');
      } catch {
        args = {};
      }
      const out = await tool.execute(args, {
        pid: this.pid,
        runtime: this.runtime,
        process: this,
        signal: this.abort.signal,
      });
      return { call, out: typeof out === 'string' ? out : JSON.stringify(out) };
    } catch (e) {
      if ((e as Error)?.name === 'AbortError' || this.abort.signal.aborted) throw e;
      return { call, out: `Error: ${(e as Error).message}` };
    } finally {
      this.setRunning();
    }
  }

  /** step 边界：信号 / 暂停 / 预算检查点 */
  private async stepBoundary(): Promise<void> {
    if (this.abort.signal.aborted) throw new KilledError('SIGKILL');
    if (this.flags.term) throw new TermExit();
    if (this.flags.stop) {
      this.state = 'paused';
      this.emitState();
      await new Promise<void>((resolve) => {
        this.pauseWaiter = resolve;
      });
      this.pauseWaiter = undefined;
      this.setRunning();
    }
    this.budget.checkWall();
  }

  private drainInbox(): void {
    for (const m of this.stdin.drain()) {
      let content: ChatMessage['content'];
      if (typeof m.payload === 'string') {
        content = m.payload;
      } else {
        const parts: ContentPart[] = (m.payload.images ?? []).map((url) => ({
          type: 'image_url',
          image_url: { url },
        }));
        parts.push({ type: 'text', text: m.payload.text });
        content = parts;
      }
      this.appendMessage({ role: 'user', content, meta: { from: m.from, kind: m.kind } });
    }
  }

  // —— 信号 ——

  /** 用户中断（Codex Esc 语义）：仅中止当前 LLM 生成，保留部分输出，进程转 ON_INBOX 等待 */
  interrupt(): void {
    if (this.isExited || !this.callAbort) return; // 仅在生成中有意义
    this.flags.interrupt = true;
    this.callAbort.abort();
  }

  signal(sig: string, payload?: unknown): void {
    switch (sig) {
      case 'SIGTERM':
        this.flags.term = true;
        this.pauseWaiter?.();
        break;
      case 'SIGKILL':
        this.abort.abort();
        this.pauseWaiter?.();
        break;
      case 'SIGSTOP':
        this.flags.stop = true;
        break;
      case 'SIGCONT':
        this.flags.stop = false;
        this.pauseWaiter?.();
        if (!this.started && !this.isExited) this.start();
        break;
      default:
        for (const h of this.signalHandlers.get(sig) ?? []) h(this);
    }
    this.emit('signal', sig, payload);
  }

  onSignal(sig: string, handler: (proc: Process) => void): void {
    const list = this.signalHandlers.get(sig) ?? [];
    list.push(handler);
    this.signalHandlers.set(sig, list);
  }

  // —— 等待 / spawn / fork ——

  join(opts?: { timeoutMs?: number }): Promise<ExitResult> {
    if (!opts?.timeoutMs) return this.exitDeferred.promise;
    return Promise.race([
      this.exitDeferred.promise,
      new Promise<ExitResult>((_, reject) =>
        setTimeout(
          () => reject(new TimeoutError(`join timeout after ${opts.timeoutMs}ms`)),
          opts.timeoutMs,
        ),
      ),
    ]);
  }

  spawn(opts: SpawnOptions & { mode: 'blocking' }): Promise<ExitResult>;
  spawn(opts: SpawnOptions): Process;
  spawn(opts: SpawnOptions): Process | Promise<ExitResult> {
    if (opts.mode === 'blocking') {
      const child = this.runtime.spawn(this.pid, { ...opts, mode: 'async' });
      const prevState = this.state;
      const prevReason = this.blockedReason;
      if (!this.isExited) {
        this.state = 'blocked';
        this.blockedReason = 'ON_CHILD';
        this.emitState();
      }
      return child.join().finally(() => {
        if (this.state === 'blocked' && this.blockedReason === 'ON_CHILD') {
          this.state = prevState;
          this.blockedReason = prevReason;
          this.emitState();
        }
      });
    }
    return this.runtime.spawn(this.pid, opts);
  }

  fork(hint?: string): Process {
    return this.runtime.fork(this.pid, hint);
  }

  /** exec：复用 PID 槽位，清空上下文，以新配置重跑 */
  async exec(opts: SpawnOptions): Promise<ExitResult> {
    if (!this.isExited) {
      this.signal('SIGTERM');
      try {
        await this.join({ timeoutMs: 2000 });
      } catch {
        this.signal('SIGKILL');
        await this.join().catch(() => undefined);
      }
    }
    this.context = { messages: [], shared: false };
    this.spawnOptions = opts;
    this.modelParams = {
      ...this.runtime.defaults.model,
      ...this.parent?.modelParams,
      ...opts.model,
    };
    const resolved = this.runtime.resolveModel(this.modelParams);
    this.resolvedModel = resolved.model;
    this.provider = resolved.provider;
    this.userTools = new Map((opts.tools ?? []).map((t) => [t.name, t]));
    this.allTools = new Map([...this.runtime.builtinTools, ...this.userTools]);
    this.usage.promptTokens = 0;
    this.usage.completionTokens = 0;
    this.usage.totalTokens = 0;
    this.turns = 0;
    this.budget = new Budget(opts.budget ?? {}, this.parent?.budget ?? this.runtime.rootBudget);
    this.abort = new AbortController();
    this.parent?.abort.signal.addEventListener('abort', () => this.abort.abort(), { once: true });
    this.flags = { term: false, stop: false, interrupt: false };
    this.callAbort = undefined;
    this.exitResult = undefined;
    this.exitedAt = undefined;
    this.lastOutput = '';
    this.stdin.reopen();
    this.pipeInbox.reopen();
    if (opts.systemPrompt) this.appendMessage({ role: 'system', content: opts.systemPrompt });
    this.appendMessage({ role: 'user', content: opts.task });
    this.resetExitDeferred();
    this.state = 'ready';
    this.started = false;
    this.start();
    return this.join();
  }

  children(): Process[] {
    return this.runtime.childrenOf(this.pid);
  }

  descendants(): Process[] {
    return this.runtime.descendantsOf(this.pid);
  }

  /** checkpoint 恢复（仅供 runtime.restore 调用） */
  static restore(entry: ProcessSnapshotEntry, runtime: AgentRuntime): Process {
    const parent = entry.ppid ? runtime.get(entry.ppid) : undefined;
    const proc = new Process(entry.spawnOptions, runtime, parent, undefined, entry.pid);
    proc.context = { messages: [...entry.messages], shared: false };
    proc.usage.promptTokens = entry.usage.promptTokens;
    proc.usage.completionTokens = entry.usage.completionTokens;
    proc.usage.totalTokens = entry.usage.totalTokens;
    proc.turns = entry.turns;
    proc.budget = Budget.restore(entry.budget, parent?.budget ?? runtime.rootBudget);
    (proc as unknown as { createdAt: number }).createdAt = entry.createdAt;
    if (entry.state === 'done' || entry.state === 'failed' || entry.state === 'killed') {
      proc.state = entry.state;
      proc.exitResult = entry.exitResult;
      proc.exitedAt = entry.exitedAt;
      proc.stdin.close();
      proc.pipeInbox.close();
      if (entry.exitResult) proc.exitDeferred.resolve(entry.exitResult);
    } else {
      // running/blocked/paused/ready 统一恢复为 paused，待 SIGCONT 从当前上下文继续
      proc.state = 'paused';
      proc.flags.stop = true;
      proc.started = false;
    }
    // 修补悬挂的 tool_calls（checkpoint 发生在工具执行中）：补注入中断结果闭合轮次
    proc.repairDanglingToolCalls();
    runtime.register(proc);
    return proc;
  }

  /** 为没有结果的 tool_call 补一条中断 tool 消息（恢复健壮性） */
  private repairDanglingToolCalls(): void {
    const answered = new Set(
      this.context.messages
        .filter((m) => m.role === 'tool' && m.tool_call_id)
        .map((m) => m.tool_call_id),
    );
    for (const m of this.context.messages) {
      if (m.role !== 'assistant' || !m.tool_calls) continue;
      for (const call of m.tool_calls) {
        if (!answered.has(call.id)) {
          this.appendMessage({
            role: 'tool',
            content: 'Error: tool execution was interrupted by checkpoint/restore',
            tool_call_id: call.id,
            name: call.name,
          });
        }
      }
    }
  }

  // —— 快照 ——

  snapshot(): ProcessSnapshot {
    return {
      pid: this.pid,
      ppid: this.ppid,
      name: this.name,
      state: this.state,
      blockedReason: this.blockedReason,
      depth: this.depth,
      model: this.resolvedModel,
      provider: this.provider.name,
      usage: { ...this.usage },
      budgetUsed: { tokens: this.budget.usedTokens, turns: this.budget.usedTurns },
      turns: this.turns,
      children: [...this.childrenPids],
      createdAt: this.createdAt,
      uptimeMs: (this.exitedAt ?? Date.now()) - this.createdAt,
      exit: this.exitResult
        ? { status: this.exitResult.status, reason: this.exitResult.reason }
        : undefined,
    };
  }
}
