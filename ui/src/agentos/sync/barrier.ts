import { TimeoutError } from '../errors';

interface Waiter {
  resolve: () => void;
  reject: (e: Error) => void;
  timer?: NodeJS.Timeout;
}

/** 屏障：N 方会合后全部放行 */
export class Barrier {
  private arrived = 0;
  private waiters: Waiter[] = [];

  constructor(readonly parties: number) {}

  async wait(timeoutMs?: number): Promise<void> {
    this.arrived++;
    if (this.arrived >= this.parties) {
      const all = this.waiters.splice(0, this.waiters.length);
      for (const w of all) {
        if (w.timer) clearTimeout(w.timer);
        w.resolve();
      }
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const entry: Waiter = { resolve, reject };
      if (timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          const i = this.waiters.indexOf(entry);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new TimeoutError(`barrier wait timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this.waiters.push(entry);
    });
  }
}
