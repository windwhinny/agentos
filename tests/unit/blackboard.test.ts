import { describe, it, expect } from 'vitest';
import { Blackboard } from '../../src/ipc/blackboard';

describe('Blackboard（共享黑板）', () => {
  it('write/read 版本递增', () => {
    const bb = new Blackboard();
    expect(bb.write('plan', 'v1')).toBe(true);
    expect(bb.write('plan', 'v2')).toBe(true);
    expect(bb.read('plan')).toEqual({ value: 'v2', version: 2 });
  });

  it('CAS：expectedVersion 不符返回 false', () => {
    const bb = new Blackboard();
    bb.write('k', 'a'); // version 1
    expect(bb.write('k', 'b', 5)).toBe(false); // 过期版本
    expect(bb.read('k')?.value).toBe('a');
    expect(bb.write('k', 'b', 1)).toBe(true);
    expect(bb.read('k')).toEqual({ value: 'b', version: 2 });
  });

  it('新 key 的 expectedVersion 为 0', () => {
    const bb = new Blackboard();
    expect(bb.write('fresh', 1, 0)).toBe(true);
    expect(bb.write('fresh2', 1, 1)).toBe(false);
  });

  it('watch 触发与退订', () => {
    const bb = new Blackboard();
    const seen: unknown[] = [];
    const off = bb.watch('x', (v) => seen.push(v));
    bb.write('x', 'one');
    off();
    bb.write('x', 'two');
    expect(seen).toEqual(['one']);
  });
});
