import { AgentOSError, DeadlockError, TimeoutError } from '../errors';
import type { WaitForGraph } from './waitfor';

interface Waiter {
  holder: number;
  resolve: () => void;
  reject: (e: Error) => void;
  timer?: NodeJS.Timeout;
}

/** 计数信号量：公平 FIFO；等待方挂 Promise；可选接入 wait-for 图做死锁检测 */
export class Semaphore {
  private available: number;
  private holders = new Map<number, number>();
  private queue: Waiter[] = [];

  constructor(
    readonly capacity: number,
    private readonly graph?: WaitForGraph,
  ) {
    this.available = capacity;
  }

  get waiterCount(): number {
    return this.queue.length;
  }

  get freeCount(): number {
    return this.available;
  }

  async acquire(holder: number, timeoutMs?: number): Promise<void> {
    if (this.available > 0 && this.queue.length === 0) {
      this.available--;
      this.addHolder(holder);
      return;
    }
    if (this.graph) {
      for (const h of this.holders.keys()) {
        if (this.graph.wouldCycle(holder, h)) {
          throw new DeadlockError(`semaphore acquire by pid ${holder} would deadlock with pid ${h}`);
        }
      }
    }
    await new Promise<void>((resolve, reject) => {
      const entry: Waiter = { holder, resolve, reject };
      if (timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          const i = this.queue.indexOf(entry);
          if (i >= 0) this.queue.splice(i, 1);
          this.graph?.removeWaiter(holder);
          reject(new TimeoutError(`semaphore acquire timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this.queue.push(entry);
      this.graph?.addWait(holder, this.holders.keys());
    });
    this.addHolder(holder);
  }

  private addHolder(holder: number): void {
    this.holders.set(holder, (this.holders.get(holder) ?? 0) + 1);
  }

  release(holder: number): void {
    const c = this.holders.get(holder);
    if (!c) throw new AgentOSError(`pid ${holder} does not hold this semaphore`, 'EPERM');
    if (c === 1) this.holders.delete(holder);
    else this.holders.set(holder, c - 1);
    const next = this.queue.shift();
    if (next) {
      this.graph?.removeWaiter(next.holder);
      if (next.timer) clearTimeout(next.timer);
      next.resolve();
    } else {
      this.available++;
    }
  }
}
