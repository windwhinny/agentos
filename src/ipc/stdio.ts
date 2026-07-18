import { EventEmitter } from 'node:events';
import { PipeClosedError } from '../errors';
import type { IpcMessage, OutputChunk } from '../types';

/** 有界 stdin 队列：满则背压；interrupt 插队首；close 后写入抛 EPIPE */
export class StdinQueue extends EventEmitter {
  private q: IpcMessage[] = [];
  private fullWaiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  private closed = false;

  constructor(private readonly capacity = 1024) {
    super();
  }

  get size(): number {
    return this.q.length;
  }

  isFull(): boolean {
    return this.q.length >= this.capacity;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async write(msg: IpcMessage): Promise<void> {
    if (this.closed) throw new PipeClosedError();
    while (this.q.length >= this.capacity) {
      await new Promise<void>((resolve, reject) => this.fullWaiters.push({ resolve, reject }));
      if (this.closed) throw new PipeClosedError();
    }
    if (msg.kind === 'interrupt') this.q.unshift(msg);
    else this.q.push(msg);
    this.emit('write', msg);
  }

  drain(): IpcMessage[] {
    const out = this.q.splice(0, this.q.length);
    const waiters = this.fullWaiters.splice(0, this.fullWaiters.length);
    for (const w of waiters) w.resolve();
    return out;
  }

  close(): void {
    this.closed = true;
    const waiters = this.fullWaiters.splice(0, this.fullWaiters.length);
    for (const w of waiters) w.reject(new PipeClosedError());
  }

  /** exec() 复用进程槽位时重开 */
  reopen(): void {
    this.closed = false;
  }
}

/** stdout：环形缓冲 + 订阅 */
export class StdoutStream extends EventEmitter {
  private buf: OutputChunk[] = [];

  constructor(private readonly capacity = 1000) {
    super();
  }

  push(chunk: OutputChunk): void {
    this.buf.push(chunk);
    if (this.buf.length > this.capacity) this.buf.splice(0, this.buf.length - this.capacity);
    this.emit('output', chunk);
  }

  /** 读取（含流式合并：同 id 的连续帧只保留最后一帧） */
  read(since?: number): OutputChunk[] {
    const all = since === undefined ? [...this.buf] : this.buf.filter((c) => c.ts > since);
    const lastById = new Map<string, number>();
    all.forEach((c, i) => {
      if (c.id) lastById.set(c.id, i);
    });
    return all.filter((c, i) => !c.id || lastById.get(c.id) === i);
  }

  tap(cb: (chunk: OutputChunk) => void): () => void {
    this.on('output', cb);
    return () => {
      this.off('output', cb);
    };
  }
}
