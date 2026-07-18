import { AgentRuntime } from '@/agentos/core/runtime';
import { MockLLMProvider } from '@/agentos/llm/mock';
import { demoResponder } from './demo-script';
import type { AddProviderInput, Driver, ModelsState, ProviderView, SpawnParams } from './driver';
import type { OutputChunk, ProcessSnapshot } from '@/agentos/types';

/** demo 模式：AgentOS 直接在浏览器里跑（Mock 大脑，进程机制全部真实） */
export class LocalDriver implements Driver {
  readonly mode = 'demo' as const;
  private rt: AgentRuntime;
  private listeners = new Set<() => void>();
  private outputListeners = new Set<(pid: number, chunk: OutputChunk) => void>();
  private tapped = new Set<number>();
  /** demo 模式的内存模型注册表（与 live server 同一契约） */
  private modelRegistry: { providers: ProviderView[]; defaultModel: string } = {
    providers: [{ name: 'demo', type: 'mock', models: ['demo-mock-v1'], hasKey: true }],
    defaultModel: 'demo-mock-v1',
  };

  constructor() {
    this.rt = new AgentRuntime({
      providers: [new MockLLMProvider(demoResponder, { streamDelayMs: 40 })],
      defaults: { model: { model: 'demo-mock-v1' } },
      budget: { tokens: 500_000 },
      maxDepth: 4,
    });
    const refresh = () => this.emit();
    this.rt.on('process:created', (snap: ProcessSnapshot) => {
      this.tapProcess(snap.pid);
      refresh();
    });
    this.rt.on('process:state', refresh);
    this.rt.on('process:exit', refresh);
  }

  async init(): Promise<void> {
    const init = this.rt.init({ task: '协调调研与写作团队完成任务', name: 'init·协调者' });
    this.tapProcess(init.pid);
    // 等「调研员」「写手」都出现后建管道（模拟流水线编排）
    const timer = setInterval(() => {
      const snaps = this.rt.ps();
      const researcher = snaps.find((s) => s.name === '调研员');
      const writer = snaps.find((s) => s.name === '写手');
      if (researcher && writer) {
        try {
          this.rt.pipe(researcher.pid, writer.pid);
          this.emit();
        } catch { /* 已建过 */ }
        clearInterval(timer);
      }
    }, 200);
  }

  private tapProcess(pid: number): void {
    if (this.tapped.has(pid)) return;
    this.tapped.add(pid);
    this.rt.getRequired(pid).stdout.tap((chunk) => {
      for (const cb of this.outputListeners) cb(pid, chunk);
    });
  }

  private emit(): void {
    for (const cb of this.listeners) cb();
  }

  ps(): ProcessSnapshot[] {
    return this.rt.ps();
  }

  pipelines() {
    return this.rt.pipeline();
  }

  async spawn(ppid: number, params: SpawnParams): Promise<number> {
    const proc = this.rt.spawn(ppid, {
      task: params.task,
      name: params.name,
      model: params.model ? { model: params.model } : undefined,
      budget: params.budgetTokens ? { tokens: params.budgetTokens } : undefined,
    });
    return proc.pid;
  }

  async fork(pid: number, hint?: string): Promise<number> {
    return this.rt.fork(pid, hint).pid;
  }

  async signal(pid: number, sig: string): Promise<void> {
    this.rt.signal(pid, sig);
  }

  async send(pid: number, text: string, images?: string[]): Promise<void> {
    // 对齐 server 行为:进程已退出则 revive 保留上下文续聊(重开 stdin),注入消息后 start
    // 修复前:demo 模式直接写已关闭的 stdin → EPIPE,用户消息石沉大海
    const proc = this.rt.getRequired(pid);
    if (proc.isExited) proc.revive();
    await this.rt.user.send(pid, text, { images });
    proc.start(); // 已 start/存活时是 no-op
  }

  async interrupt(pid: number): Promise<void> {
    this.rt.getRequired(pid).interrupt();
  }

  async pipe(fromPid: number, toPid: number): Promise<void> {
    this.rt.pipe(fromPid, toPid);
    this.emit();
  }

  output(pid: number): OutputChunk[] {
    return this.rt.getRequired(pid).stdout.read();
  }

  // —— 模型管理（内存实现，与 server REST 同一语义）——

  private modelsView(): ModelsState {
    return {
      defaultModel: this.modelRegistry.defaultModel,
      providers: this.modelRegistry.providers.map((p) => ({ ...p, models: [...p.models] })),
    };
  }

  async getModels(): Promise<ModelsState> {
    return this.modelsView();
  }

  async addProvider(input: AddProviderInput): Promise<ModelsState> {
    const name = input.name.trim();
    if (!name) throw new Error('供应商名称不能为空');
    if (input.type !== 'openai' && input.type !== 'anthropic')
      throw new Error(`不支持的供应商类型: ${input.type}（仅 openai/anthropic）`);
    if (this.modelRegistry.providers.some((p) => p.name === name))
      throw new Error(`供应商已存在: ${name}`);
    const models = input.models.map((m) => m.trim()).filter(Boolean);
    if (models.length === 0) throw new Error('至少需要一个模型');
    this.modelRegistry.providers.push({
      name,
      type: input.type,
      baseUrl: input.baseUrl?.trim() || undefined,
      models,
      hasKey: !!input.apiKey.trim(),
    });
    return this.modelsView();
  }

  async removeProvider(name: string): Promise<ModelsState> {
    const idx = this.modelRegistry.providers.findIndex((p) => p.name === name);
    if (idx < 0) throw new Error(`供应商不存在: ${name}`);
    const [removed] = this.modelRegistry.providers.splice(idx, 1);
    // 默认模型随供应商消失则回退到剩余第一个模型（与 server 一致）
    if (removed.models.includes(this.modelRegistry.defaultModel)) {
      this.modelRegistry.defaultModel = this.modelRegistry.providers[0]?.models[0] ?? '';
    }
    return this.modelsView();
  }

  async setDefaultModel(model: string): Promise<ModelsState> {
    if (!this.modelRegistry.providers.some((p) => p.models.includes(model)))
      throw new Error(`未注册的模型: ${model}`);
    this.modelRegistry.defaultModel = model;
    return this.modelsView();
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  subscribeOutput(cb: (pid: number, chunk: OutputChunk) => void): () => void {
    this.outputListeners.add(cb);
    return () => this.outputListeners.delete(cb);
  }
}
