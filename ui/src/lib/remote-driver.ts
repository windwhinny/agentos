import type { AddProviderInput, Driver, ModelsState, SpawnParams } from './driver';
import type { OutputChunk, ProcessSnapshot } from '@/agentos/types';

/** live 模式：连接本地 AgentOS server（REST + SSE），真实 DeepSeek 模型 */
export class RemoteDriver implements Driver {
  readonly mode = 'live' as const;
  onError: ((msg: string | null) => void) | null = null;
  private base: string;
  private snapshots: ProcessSnapshot[] = [];
  private pipes: Array<{ fromPid: number; toPid: number; mode: string; closed: boolean }> = [];
  private outputs = new Map<number, OutputChunk[]>();
  private listeners = new Set<() => void>();
  private outputListeners = new Set<(pid: number, chunk: OutputChunk) => void>();
  private es?: EventSource;
  private sseDown = false;

  constructor(base: string) {
    this.base = base.replace(/\/$/, '');
  }

  async init(): Promise<void> {
    const res = await fetch(`${this.base}/api/state`);
    const data = await res.json();
    this.snapshots = data.ps;
    this.pipes = data.pipes;
    // 回填各进程 stdout 历史（页面加载前已产出的输出）
    if (data.outputs) {
      for (const [pid, chunks] of Object.entries(data.outputs)) {
        this.outputs.set(Number(pid), (chunks as OutputChunk[]).slice(-500));
      }
    }
    this.es = new EventSource(`${this.base}/api/events`);
    // SSE 断线可见性:backend 挂掉/重启时给出横幅,而不是静默停滞
    this.es.onerror = () => {
      if (this.sseDown) return;
      this.sseDown = true;
      this.onError?.(`SSE 实时通道断开(${this.base}),页面数据已停滞;EventSource 将自动重连`);
    };
    this.es.onopen = () => {
      if (!this.sseDown) return;
      this.sseDown = false;
      this.onError?.(null);
    };
    this.es.onmessage = (e) => {
      const evt = JSON.parse(e.data);
      if (evt.kind === 'state') {
        this.snapshots = evt.ps;
        if (evt.pipes) this.pipes = evt.pipes;
        this.emit();
      } else if (evt.kind === 'output') {
        const chunk = evt.chunk as OutputChunk;
        // 流式帧按 chunk.id 合并（同一条消息的多帧共享 id，末帧 done=true），
        // 否则 attach/切换进程后 output() 会把每一帧中间态都返回，终端被刷满
        const list = [...(this.outputs.get(evt.pid) ?? [])];
        if (chunk.id) {
          const i = list.findIndex((c) => c.id === chunk.id);
          if (i >= 0) list[i] = chunk;
          else list.push(chunk);
        } else {
          list.push(chunk);
        }
        this.outputs.set(evt.pid, list.slice(-500));
        for (const cb of this.outputListeners) cb(evt.pid, chunk);
      }
    };
  }

  private emit(): void {
    for (const cb of this.listeners) cb();
  }

  ps(): ProcessSnapshot[] {
    return this.snapshots;
  }

  pipelines() {
    return this.pipes;
  }

  private async post<T = { pid: number }>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json() as Promise<T>;
  }

  async spawn(ppid: number, params: SpawnParams): Promise<number> {
    const r = await this.post('/api/spawn', { ppid, ...params });
    return r.pid;
  }

  async fork(pid: number, hint?: string): Promise<number> {
    const r = await this.post('/api/fork', { pid, hint });
    return r.pid;
  }

  async signal(pid: number, sig: string): Promise<void> {
    await this.post<{ ok: boolean }>('/api/signal', { pid, sig });
  }

  async send(pid: number, text: string, images?: string[]): Promise<void> {
    await this.post<{ ok: boolean }>('/api/send', { pid, text, images });
  }

  async interrupt(pid: number): Promise<void> {
    await this.post<{ ok: boolean }>('/api/interrupt', { pid });
  }

  async pipe(fromPid: number, toPid: number): Promise<void> {
    await this.post<{ ok: boolean }>('/api/pipe', { fromPid, toPid });
  }

  output(pid: number): OutputChunk[] {
    return this.outputs.get(pid) ?? [];
  }

  // —— 模型管理 REST ——

  /** 通用请求:非 2xx 时读 { error } 抛出;返回体去掉 ok 壳只留 view 部分 */
  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.base}${path}`, init);
    const data = (await res.json().catch(() => ({}))) as { error?: unknown } & T;
    if (!res.ok) {
      throw new Error(typeof data.error === 'string' ? data.error : `HTTP ${res.status}`);
    }
    return data;
  }

  async getModels(): Promise<ModelsState> {
    return this.req<ModelsState>('/api/models');
  }

  async addProvider(input: AddProviderInput): Promise<ModelsState> {
    const { models, ...rest } = input;
    // server 约定 models 为逗号分隔字符串
    return this.req<ModelsState>('/api/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...rest, models: models.join(',') }),
    });
  }

  async removeProvider(name: string): Promise<ModelsState> {
    return this.req<ModelsState>(`/api/providers/${encodeURIComponent(name)}`, { method: 'DELETE' });
  }

  async setDefaultModel(model: string): Promise<ModelsState> {
    return this.req<ModelsState>('/api/default-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    });
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
