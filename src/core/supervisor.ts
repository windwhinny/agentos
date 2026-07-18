import type { AgentRuntime } from './runtime';
import type { Process } from './process';

interface Counter {
  count: number;
  windowStart: number;
}

/** Supervisor：监听子进程退出，按策略重启（Erlang OTP 风格） */
export class Supervisor {
  private counters = new Map<string, Counter>();

  constructor(private readonly runtime: AgentRuntime) {}

  onChildExit(proc: Process): void {
    const spec = proc.spawnOptions.supervision;
    if (!spec || spec.restart === 'never') return;
    if (!proc.ppid) return;
    const parent = this.runtime.get(proc.ppid);
    if (!parent) return;
    // 整树被 SIGKILL 强制拆除时不重启；父正常 done/failed 不阻止重启（supervisor 是 runtime 级服务）
    if (parent.exitResult?.reason === 'SIGKILL') return;
    const status = proc.exitResult?.status;
    const shouldRestart =
      spec.restart === 'always' || (spec.restart === 'on-failure' && status === 'failed');
    if (!shouldRestart) return;

    const key = `${proc.ppid}:${proc.name ?? proc.spawnOptions.task}`;
    const now = Date.now();
    let c = this.counters.get(key);
    if (!c || now - c.windowStart > (spec.windowMs ?? 60_000)) {
      c = { count: 0, windowStart: now };
    }
    if (c.count >= (spec.maxRestarts ?? 3)) {
      this.counters.set(key, c);
      return;
    }
    c.count++;
    this.counters.set(key, c);

    if (spec.strategy === 'one-for-all') {
      for (const sib of this.runtime.childrenOf(parent.pid)) {
        if (sib.pid !== proc.pid && !sib.isExited && sib.spawnOptions.supervision) {
          this.runtime.signal(sib.pid, 'SIGKILL');
          void sib.join().finally(() => this.respawn(sib));
        }
      }
    }
    this.respawn(proc);
  }

  private respawn(proc: Process): void {
    if (!proc.ppid) return;
    this.runtime.spawn(proc.ppid, { ...proc.spawnOptions, mode: 'async' });
  }
}
