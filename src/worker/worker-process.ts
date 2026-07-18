import { Worker } from 'node:worker_threads';
import { Process } from '../core/process';
import type { AgentRuntime } from '../core/runtime';
import type { ExitResult, SpawnOptions, Usage } from '../types';

const zero = (): Usage => ({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });

/** worker_threads 隔离进程：loop 跑在独立线程，stdio/信号经 MessagePort 桥接 */
export class WorkerProcess extends Process {
  private worker?: Worker;

  constructor(opts: SpawnOptions, runtime: AgentRuntime, parent?: Process) {
    super(opts, runtime, parent);
  }

  override start(): void {
    if (this.started || this.isExited) return;
    this.started = true;
    this.state = 'running';
    const wcfg = this.spawnOptions.worker;
    if (!wcfg) {
      this.finish({
        pid: this.pid,
        status: 'failed',
        reason: 'ERROR',
        exitCode: 1,
        output: '',
        error: 'worker isolation requires SpawnOptions.worker provider config',
        usage: zero(),
        turns: 0,
      });
      return;
    }
    const workerData = {
      task: this.spawnOptions.task,
      systemPrompt: this.spawnOptions.systemPrompt,
      model: {
        model: this.resolvedModel,
        temperature: this.modelParams.temperature,
        maxTokens: this.modelParams.maxTokens,
        topP: this.modelParams.topP,
      },
      budget: this.spawnOptions.budget ?? {},
      worker: wcfg,
      toolModule: this.spawnOptions.toolModule,
    };
    this.worker = new Worker(new URL('./worker-entry.mjs', import.meta.url), { workerData });
    this.stdin.on('write', (msg) => this.worker?.postMessage({ type: 'stdin', msg }));
    this.worker.on(
      'message',
      (m: { type: string; chunk?: never; result?: Partial<ExitResult> }) => {
        if (m.type === 'stdout' && m.chunk) this.stdout.push(m.chunk);
        else if (m.type === 'exit' && m.result) this.onWorkerExit(m.result);
      },
    );
    this.worker.on('error', (err: Error) => {
      this.finish({
        pid: this.pid,
        status: 'failed',
        reason: 'ERROR',
        exitCode: 1,
        output: '',
        error: `worker error: ${err.message}`,
        usage: { ...this.usage },
        turns: this.turns,
      });
    });
    this.worker.on('exit', (code: number) => {
      if (this.isExited) return;
      this.finish({
        pid: this.pid,
        status: code === 0 ? 'done' : 'failed',
        reason: code === 0 ? 'DONE' : 'ERROR',
        exitCode: code,
        output: '',
        error: code === 0 ? undefined : `worker exited with code ${code}`,
        usage: { ...this.usage },
        turns: this.turns,
      });
    });
  }

  private onWorkerExit(result: Partial<ExitResult>): void {
    const u = result.usage ?? zero();
    this.usage.promptTokens += u.promptTokens;
    this.usage.completionTokens += u.completionTokens;
    this.usage.totalTokens += u.totalTokens;
    this.turns += result.turns ?? 0;
    try {
      this.budget.consumeTokens(u.totalTokens);
    } catch {
      /* worker 侧已自控预算 */
    }
    this.finish({
      pid: this.pid,
      status: result.status ?? 'failed',
      reason: result.reason ?? 'ERROR',
      exitCode: result.exitCode ?? 1,
      output: result.output ?? '',
      error: result.error,
      usage: { ...this.usage },
      turns: this.turns,
    });
  }

  override signal(sig: string, payload?: unknown): void {
    if (sig === 'SIGKILL') {
      void this.worker?.terminate();
      this.finish({
        pid: this.pid,
        status: 'killed',
        reason: 'SIGKILL',
        exitCode: 137,
        output: '',
        usage: { ...this.usage },
        turns: this.turns,
      });
    } else {
      this.worker?.postMessage({ type: 'signal', sig });
    }
    super.signal(sig, payload);
  }
}
