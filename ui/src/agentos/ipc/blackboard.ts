type Watcher = (value: unknown, version: number) => void;

/** 共享黑板：KV + CAS 写 + watch 订阅（进程树级共享内存） */
export class Blackboard {
  private store = new Map<string, { value: unknown; version: number }>();
  private watchers = new Map<string, Set<Watcher>>();

  read(key: string): { value: unknown; version: number } | undefined {
    const e = this.store.get(key);
    return e ? { value: e.value, version: e.version } : undefined;
  }

  /** expectedVersion 提供时必须与当前版本一致（新 key 版本为 0），否则返回 false */
  write(key: string, value: unknown, expectedVersion?: number): boolean {
    const cur = this.store.get(key);
    const curVersion = cur?.version ?? 0;
    if (expectedVersion !== undefined && curVersion !== expectedVersion) return false;
    const version = curVersion + 1;
    this.store.set(key, { value, version });
    for (const cb of this.watchers.get(key) ?? []) cb(value, version);
    return true;
  }

  watch(key: string, cb: Watcher): () => void {
    const set = this.watchers.get(key) ?? new Set<Watcher>();
    set.add(cb);
    this.watchers.set(key, set);
    return () => {
      set.delete(cb);
    };
  }
}
