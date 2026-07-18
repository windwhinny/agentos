import type { AgentRuntime } from './runtime';
import type { OutputChunk, ProcessSnapshot } from '../types';

/** PID 0：用户终端进程适配器 */
export class UserAPI {
  private attached?: number;

  constructor(private readonly runtime: AgentRuntime) {}

  attach(pid: number): void {
    this.runtime.getRequired(pid);
    this.attached = pid;
  }

  detach(): void {
    this.attached = undefined;
  }

  get attachedPid(): number | undefined {
    return this.attached;
  }

  /** pid 省略时发向当前 attach 目标；images 为图片 data URL 列表（多模态） */
  async send(
    pid: number | undefined,
    text: string,
    opts?: { priority?: 'normal' | 'high'; images?: string[] },
  ): Promise<void> {
    const target = pid ?? this.attached;
    if (target === undefined) throw new Error('no attach target: call attach(pid) first or pass pid');
    const proc = this.runtime.getRequired(target);
    await proc.stdin.write({
      from: 0,
      to: target,
      kind: opts?.priority === 'high' ? 'interrupt' : 'user',
      payload: opts?.images?.length ? { text, images: opts.images } : text,
      ts: Date.now(),
    });
  }

  tap(pid: number, cb: (chunk: OutputChunk) => void): () => void {
    return this.runtime.getRequired(pid).stdout.tap(cb);
  }

  ps(): ProcessSnapshot[] {
    return this.runtime.ps();
  }
}
