import { AgentOSError } from '../errors';
import { Semaphore } from './semaphore';
import type { WaitForGraph } from './waitfor';

/** 互斥锁：仅持有者可释放 */
export class Mutex {
  private sem: Semaphore;
  private owner?: number;

  constructor(graph?: WaitForGraph) {
    this.sem = new Semaphore(1, graph);
  }

  async acquire(holder: number, timeoutMs?: number): Promise<void> {
    await this.sem.acquire(holder, timeoutMs);
    this.owner = holder;
  }

  release(holder: number): void {
    if (this.owner !== holder) {
      throw new AgentOSError(`pid ${holder} cannot release mutex owned by pid ${this.owner}`, 'EPERM');
    }
    this.owner = undefined;
    this.sem.release(holder);
  }
}
