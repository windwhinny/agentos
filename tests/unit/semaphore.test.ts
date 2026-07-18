import { describe, it, expect } from 'vitest';
import { Semaphore } from '../../src/sync/semaphore';
import { WaitForGraph } from '../../src/sync/waitfor';
import { TimeoutError } from '../../src/errors';

describe('Semaphore', () => {
  it('并发许可严格不超过 capacity', async () => {
    const sem = new Semaphore(2, new WaitForGraph());
    let active = 0;
    let maxActive = 0;
    const task = async (pid: number) => {
      await sem.acquire(pid);
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      sem.release(pid);
    };
    await Promise.all([task(1), task(2), task(3), task(4), task(5)]);
    expect(maxActive).toBe(2);
  });

  it('FIFO 公平排队', async () => {
    const sem = new Semaphore(1, new WaitForGraph());
    await sem.acquire(1);
    const order: number[] = [];
    const p2 = sem.acquire(2).then(() => {
      order.push(2);
      sem.release(2);
    });
    const p3 = sem.acquire(3).then(() => {
      order.push(3);
      sem.release(3);
    });
    await new Promise((r) => setTimeout(r, 10));
    sem.release(1);
    await Promise.all([p2, p3]);
    expect(order).toEqual([2, 3]);
  });

  it('acquire 超时抛 TimeoutError 并出队', async () => {
    const sem = new Semaphore(1, new WaitForGraph());
    await sem.acquire(1);
    await expect(sem.acquire(2, 50)).rejects.toThrow(TimeoutError);
    expect(sem.waiterCount).toBe(0);
    sem.release(1);
    await sem.acquire(3); // 不受影响
    sem.release(3);
  });

  it('非持有者 release 抛错', async () => {
    const sem = new Semaphore(1, new WaitForGraph());
    await sem.acquire(1);
    expect(() => sem.release(2)).toThrow();
    sem.release(1);
  });
});
