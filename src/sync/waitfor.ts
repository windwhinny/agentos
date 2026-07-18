/** wait-for 图：边 P→Q 表示 P 正在等待 Q 持有的资源 */
export class WaitForGraph {
  private edges = new Map<number, Set<number>>();

  addWait(waiter: number, holders: Iterable<number>): void {
    for (const h of holders) {
      if (h === waiter) continue;
      const set = this.edges.get(waiter) ?? new Set<number>();
      set.add(h);
      this.edges.set(waiter, set);
    }
  }

  removeWaiter(waiter: number): void {
    this.edges.delete(waiter);
  }

  /** 若加上 waiter→holder 这条边会成环（holder 间接等待 waiter），返回 true */
  wouldCycle(waiter: number, holder: number): boolean {
    if (waiter === holder) return true;
    const visited = new Set<number>();
    const stack = [holder];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === waiter) return true;
      if (visited.has(cur)) continue;
      visited.add(cur);
      for (const next of this.edges.get(cur) ?? []) stack.push(next);
    }
    return false;
  }

  edgeCount(): number {
    let n = 0;
    for (const s of this.edges.values()) n += s.size;
    return n;
  }
}
