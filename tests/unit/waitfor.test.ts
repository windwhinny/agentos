import { describe, it, expect } from 'vitest';
import { WaitForGraph } from '../../src/sync/waitfor';

describe('WaitForGraph（wait-for 图）', () => {
  it('无环时 wouldCycle 为 false', () => {
    const g = new WaitForGraph();
    g.addWait(1, [2]); // 1 等 2
    expect(g.wouldCycle(2, 3)).toBe(false);
  });

  it('检测直接环 A↔B', () => {
    const g = new WaitForGraph();
    g.addWait(1, [2]); // 1 等 2
    expect(g.wouldCycle(2, 1)).toBe(true); // 2 再等 1 → 环
  });

  it('检测间接环 A→B→C→A', () => {
    const g = new WaitForGraph();
    g.addWait(1, [2]);
    g.addWait(2, [3]);
    expect(g.wouldCycle(3, 1)).toBe(true);
  });

  it('removeWaiter 清除边后不再误报', () => {
    const g = new WaitForGraph();
    g.addWait(1, [2]);
    g.removeWaiter(1);
    expect(g.wouldCycle(2, 1)).toBe(false);
  });

  it('自等待（重入同一锁）检测为环', () => {
    const g = new WaitForGraph();
    expect(g.wouldCycle(1, 1)).toBe(true);
  });
});
