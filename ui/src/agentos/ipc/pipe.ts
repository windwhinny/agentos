import { PipeClosedError } from '../errors';
import type { AgentRuntime } from '../core/runtime';
import type { IpcMessage, OutputChunk } from '../types';

export interface PipeOptions {
  name?: string;
  mode?: 'stream' | 'batch' | 'tool';
  batchSize?: number;
  filter?: (chunk: OutputChunk) => string | null;
}

/** 默认只转发 assistant 文本：流式中间帧不转发，兼容 string / {text} 两种 data 形态 */
const defaultFilter = (c: OutputChunk): string | null => {
  if (c.type !== 'assistant') return null;
  if (c.id && !c.done) return null;
  if (typeof c.data === 'string') return c.data || null;
  const d = c.data as { text?: string } | undefined;
  return d?.text ? d.text : null;
};

/** 命名管道：from.stdout → to.stdin（或 pipeInbox），串行转发、背压注册、断管 EPIPE */
export class Pipe {
  readonly fromPid: number;
  readonly toPid: number;
  readonly name?: string;
  readonly mode: 'stream' | 'batch' | 'tool';
  closed = false;
  private untap?: () => void;
  private tail: Promise<void> = Promise.resolve();
  private batchBuf: string[] = [];
  private readonly batchSize: number;
  private readonly filter: (chunk: OutputChunk) => string | null;

  constructor(
    private readonly runtime: AgentRuntime,
    fromPid: number,
    toPid: number,
    opts: PipeOptions = {},
  ) {
    this.fromPid = fromPid;
    this.toPid = toPid;
    this.name = opts.name;
    this.mode = opts.mode ?? 'stream';
    this.batchSize = opts.batchSize ?? 5;
    this.filter = opts.filter ?? defaultFilter;
    this.untap = this.runtime.getRequired(fromPid).stdout.tap((chunk) => {
      const text = this.filter(chunk);
      if (text === null) return;
      this.tail = this.tail.then(() => this.forward(text)).catch((e) => this.onError(e));
    });
  }

  private onError(err: unknown): void {
    if (err instanceof PipeClosedError) {
      const writer = this.runtime.get(this.fromPid);
      writer?.stderr.push({ type: 'stderr', data: (err as Error).message, ts: Date.now() });
      this.close();
    }
  }

  private async forward(text: string): Promise<void> {
    if (this.closed) throw new PipeClosedError();
    const target = this.runtime.get(this.toPid);
    if (!target || target.isExited) {
      this.close();
      throw new PipeClosedError(`EPIPE: reader pid ${this.toPid} exited`);
    }
    let payload = text;
    if (this.mode === 'batch') {
      this.batchBuf.push(text);
      if (this.batchBuf.length < this.batchSize) return;
      payload = this.batchBuf.splice(0, this.batchBuf.length).join('\n');
    }
    const msg: IpcMessage = {
      from: this.fromPid,
      to: this.toPid,
      kind: 'pipe',
      payload,
      ts: Date.now(),
    };
    const dest = this.mode === 'tool' ? target.pipeInbox : target.stdin;
    // 背压：写将阻塞时向 wait-for 图注册 from → to 边
    const registerEdge = dest.isFull();
    if (registerEdge) this.runtime.waitFor.addWait(this.fromPid, [this.toPid]);
    try {
      await dest.write(msg);
    } finally {
      if (registerEdge) this.runtime.waitFor.removeWaiter(this.fromPid);
    }
  }

  /** 显式写入（断管时向调用方抛 EPIPE） */
  async send(text: string): Promise<void> {
    return this.forward(text);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.untap?.();
    // 保留在 runtime 注册表中：pipeline() 拓扑视图需要展示已关闭管道的历史
  }
}
