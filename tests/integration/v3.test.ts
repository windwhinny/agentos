import { describe, it, expect } from 'vitest';
import { AgentRuntime } from '../../src/core/runtime';
import { MockLLMProvider, type MockResponder } from '../../src/llm/mock';
import { DeadlockError } from '../../src/errors';
import type { Tool } from '../../src/types';
import { abortableSleep } from '../../src/utils';
import { fileURLToPath } from 'node:url';

const slowTool: Tool = {
  name: 'slow_tool',
  description: 'sleep',
  parameters: { type: 'object', properties: { ms: { type: 'number' } } },
  execute: async (args: any, ctx) => {
    await abortableSleep(args?.ms ?? 300, ctx.signal);
    return 'slept';
  },
};

function makeRuntime(responder: MockResponder, opts: Record<string, unknown> = {}) {
  const mock = new MockLLMProvider(responder);
  const rt = new AgentRuntime({
    providers: [mock],
    defaults: { model: { model: 'm1' } },
    ...opts,
  });
  return { rt, mock };
}

async function eventually(cond: () => boolean, timeoutMs = 4000, interval = 20): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`eventually: condition not met within ${timeoutMs}ms`);
}

describe('V3: 死锁检测（F-40）', () => {
  it('信号量循环等待被 wait-for 图检出', async () => {
    const { rt } = makeRuntime(() => ({ content: 'x' }));
    const init = rt.init({ task: 'p' });
    await init.join();
    const s1 = rt.semaphore(1);
    const s2 = rt.semaphore(1);
    await s1.acquire(1); // P1 持 s1
    await s2.acquire(2); // P2 持 s2
    const waiting = s2.acquire(1); // P1 等 s2（边 1→2）
    await expect(s1.acquire(2)).rejects.toThrow(DeadlockError); // P2 等 s1 → 环
    s2.release(2);
    await waiting;
    s2.release(1);
    s1.release(1);
  });

  it('管道背压边注册进 wait-for 图，疏通后删除', async () => {
    const { rt } = makeRuntime((msgs) => {
      const task = msgs.find((m) => m.role === 'user')?.content ?? '';
      if (task === 'writer') {
        const k = msgs.filter((m) => m.role === 'tool').length;
        if (k === 0)
          return { content: 'x1', toolCalls: [{ name: 'slow_tool', arguments: { ms: 100 } }] };
        return { content: 'x2' };
      }
      // reader：长工具，500ms 后才 drain inbox
      if (msgs.filter((m) => m.role === 'tool').length === 0)
        return { content: '', toolCalls: [{ name: 'slow_tool', arguments: { ms: 500 } }] };
      return { content: 'b-done' };
    });
    const init = rt.init({ task: 'root', tools: [slowTool] });
    const writer = init.spawn({ task: 'writer', tools: [slowTool], name: 'W' });
    const reader = init.spawn({ task: 'reader', tools: [slowTool], name: 'R', stdinCapacity: 1 });
    rt.pipe(writer.pid, reader.pid);
    await eventually(() => rt.waitFor.edgeCount() > 0, 2000);
    const rr = await reader.join();
    expect(rr.output).toBe('b-done');
    await writer.join();
    expect(rt.waitFor.edgeCount()).toBe(0);
    await init.join();
  });
});

describe('V3: Supervisor（F-41）', () => {
  it('one-for-one on-failure：崩溃自动重启直至成功', async () => {
    let attempts = 0;
    const { rt } = makeRuntime((msgs) => {
      const task = msgs.find((m) => m.role === 'user')?.content ?? '';
      if (task === 'fragile') {
        attempts++;
        if (attempts === 1) return { error: new Error('boom') };
        return { content: `survived-${attempts}` };
      }
      return { content: 'p-done' };
    });
    const init = rt.init({ task: 'p' });
    const child = init.spawn({
      task: 'fragile',
      name: 'fragile',
      supervision: { strategy: 'one-for-one', restart: 'on-failure', maxRestarts: 3 },
    });
    const r1 = await child.join();
    expect(r1.status).toBe('failed');
    await eventually(() =>
      rt.ps().some((s) => s.pid !== child.pid && s.exit?.status === 'done' && s.pid !== 1),
    );
    const restarted = rt.ps().find((s) => s.pid !== child.pid && s.pid !== 1)!;
    expect(rt.getRequired(restarted.pid).exitResult?.output).toBe('survived-2');
    expect(attempts).toBe(2);
    await init.join();
  });

  it('maxRestarts 超限后停止重启', async () => {
    let attempts = 0;
    const { rt } = makeRuntime((msgs) => {
      const task = msgs.find((m) => m.role === 'user')?.content ?? '';
      if (task === 'always-fail') {
        attempts++;
        return { error: new Error(`boom-${attempts}`) };
      }
      return { content: 'p-done' };
    });
    const init = rt.init({ task: 'p' });
    init.spawn({
      task: 'always-fail',
      name: 'always-fail',
      supervision: { strategy: 'one-for-one', restart: 'on-failure', maxRestarts: 2 },
    });
    await eventually(() => attempts >= 3); // 原 1 次 + 重启 2 次
    await new Promise((r) => setTimeout(r, 150));
    expect(attempts).toBe(3); // 不再有第 4 次
    const failed = rt.ps().filter((s) => s.exit?.status === 'failed');
    expect(failed.length).toBe(3);
    await init.join();
  });

  it('one-for-all：崩溃时整组重启', async () => {
    let aAttempts = 0;
    let bAttempts = 0;
    const { rt } = makeRuntime((msgs) => {
      const task = msgs.find((m) => m.role === 'user')?.content ?? '';
      if (task === 'A') {
        aAttempts++;
        return aAttempts === 1 ? { error: new Error('A-boom') } : { content: 'A-ok' };
      }
      if (task === 'B') {
        bAttempts++;
        return bAttempts === 1 ? { content: 'B-slow', delayMs: 3000 } : { content: 'B-ok' };
      }
      return { content: 'p-done' };
    });
    const init = rt.init({ task: 'p' });
    const spec = {
      strategy: 'one-for-all' as const,
      restart: 'on-failure' as const,
      maxRestarts: 2,
    };
    const a = init.spawn({ task: 'A', name: 'A', supervision: spec });
    init.spawn({ task: 'B', name: 'B', supervision: spec });
    await a.join(); // A 失败 → 触发 one-for-all：B 被 SIGKILL 并整组重启
    await eventually(() => aAttempts >= 2 && bAttempts >= 2);
    // 等重启后的 A/B 真正退出（流式输出让 done 略晚于 attempts 计数）
    await eventually(() => {
      const d = rt.ps().filter((s) => s.exit?.status === 'done' && s.pid !== 1);
      return d.some((s) => s.name === 'A') && d.some((s) => s.name === 'B');
    });
    const done = rt.ps().filter((s) => s.exit?.status === 'done' && s.pid !== 1);
    const outputs = done.map((s) => rt.getRequired(s.pid).exitResult?.output);
    expect(outputs).toContain('A-ok');
    expect(outputs).toContain('B-ok');
    await init.join();
  });
});

describe('V3: worker_threads 隔离（F-43）', () => {
  it('进程在 worker 中运行并返回结果（mock 脚本）', async () => {
    const { rt } = makeRuntime(() => ({ content: 'main-done' }));
    const init = rt.init({ task: 'p' });
    const child = init.spawn({
      task: 'worker-task',
      isolation: 'worker',
      worker: { provider: 'mock', script: [{ content: 'worker-done' }] },
    });
    const result = await child.join();
    expect(result.status).toBe('done');
    expect(result.output).toBe('worker-done');
    expect(result.usage.totalTokens).toBe(15);
    await init.join();
  });

  it('worker 内工具经 toolModule 加载执行', async () => {
    const toolModule = fileURLToPath(new URL('../fixtures/echo-tool.mjs', import.meta.url));
    const { rt } = makeRuntime(() => ({ content: 'main-done' }));
    const init = rt.init({ task: 'p' });
    const child = init.spawn({
      task: 'worker-tool-task',
      isolation: 'worker',
      toolModule,
      worker: {
        provider: 'mock',
        script: [
          { content: '', toolCalls: [{ name: 'echo', arguments: { text: 'ping' } }] },
          { content: 'tool-finished' },
        ],
      },
    });
    const result = await child.join();
    expect(result.status).toBe('done');
    expect(result.output).toBe('tool-finished');
    const toolChunks = child.stdout.read().filter((c) => c.type === 'tool');
    expect(toolChunks.length).toBe(1);
    expect(JSON.stringify(toolChunks[0].data)).toContain('ping');
    await init.join();
  });

  it('worker 崩溃不传染主线程', async () => {
    const { rt } = makeRuntime(() => ({ content: 'main-done' }));
    const init = rt.init({ task: 'p' });
    const child = init.spawn({
      task: 'crash',
      isolation: 'worker',
      toolModule: '/nonexistent/module.mjs', // 动态 import 必失败
      worker: { provider: 'mock', script: [{ content: 'x' }] },
    });
    const result = await child.join();
    expect(result.status).toBe('failed');
    // 主线程健康
    const r = await init.join();
    expect(r.output).toBe('main-done');
    expect(rt.ps().length).toBe(2);
  });
});

describe('V3: exec（F-44）', () => {
  it('复用 PID 重置任务与上下文', async () => {
    const { rt } = makeRuntime((msgs) => {
      const task = msgs.find((m) => m.role === 'user')?.content ?? '';
      if (task === 't1') return { content: 'first' };
      if (task === 't2') return { content: 'second' };
      return { content: '?' };
    });
    const init = rt.init({ task: 't1' });
    const r1 = await init.join();
    expect(r1.output).toBe('first');
    const len1 = init.context.messages.length;
    expect(len1).toBeGreaterThan(0);

    const r2 = await init.exec({ task: 't2' });
    expect(r2.output).toBe('second');
    expect(init.pid).toBe(1); // PID 不变
    expect(init.context.messages.length).toBe(2); // user + assistant，上下文已清空重建
    expect(init.usage.totalTokens).toBe(15); // 用量已重置
  });
});
