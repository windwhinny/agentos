import { describe, it, expect } from 'vitest';
import { Mutex } from '../../src/sync/mutex';
import { Barrier } from '../../src/sync/barrier';
import { WaitForGraph } from '../../src/sync/waitfor';
import { TimeoutError } from '../../src/errors';

describe('Mutex', () => {
  it('互斥：同时只有一个持有者进入临界区', async () => {
    const mutex = new Mutex(new WaitForGraph());
    let active = 0;
    let maxActive = 0;
    const task = async (pid: number) => {
      await mutex.acquire(pid);
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
      mutex.release(pid);
    };
    await Promise.all([task(1), task(2), task(3)]);
    expect(maxActive).toBe(1);
  });

  it('仅持有者可 release', async () => {
    const mutex = new Mutex(new WaitForGraph());
    await mutex.acquire(1);
    expect(() => mutex.release(2)).toThrow();
    mutex.release(1);
  });
});

describe('Barrier', () => {
  it('N 方全部到达前无一方放行', async () => {
    const barrier = new Barrier(3);
    const released: number[] = [];
    const p1 = barrier.wait().then(() => released.push(1));
    const p2 = barrier.wait().then(() => released.push(2));
    await new Promise((r) => setTimeout(r, 30));
    expect(released).toEqual([]);
    await barrier.wait(); // 第三方到达
    await Promise.all([p1, p2]);
    expect(released.sort()).toEqual([1, 2]);
  });

  it('wait 超时抛 TimeoutError', async () => {
    const barrier = new Barrier(2);
    await expect(barrier.wait(50)).rejects.toThrow(TimeoutError);
  });
});
