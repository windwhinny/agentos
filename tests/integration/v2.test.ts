import { describe, it, expect } from 'vitest';
import { AgentRuntime } from '../../src/core/runtime';
import { textOf } from '../../src/types';
import { MockLLMProvider, type MockResponder } from '../../src/llm/mock';
import type { Tool } from '../../src/types';
import { abortableSleep } from '../../src/utils';

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
    defaults: { model: { model: 'deepseek-v4-pro' } },
    ...opts,
  });
  return { rt, mock };
}

describe('V2: fork 分支探索（F-20）', () => {
  it('两个分支独立演化，输出按 hint 路由', async () => {
    const { rt } = makeRuntime((msgs) => {
      const hint = msgs
        .filter((m) => m.role === 'user')
        .map((m) => m.content)
        .join('|');
      if (hint.includes('保守')) return { content: 'branch-conservative' };
      if (hint.includes('激进')) return { content: 'branch-aggressive' };
      return { content: 'base-done' };
    });
    const init = rt.init({ task: '分析方案' });
    await init.join();
    const a = init.fork('走保守路线');
    const b = init.fork('走激进路线');
    const [ra, rb] = await Promise.all([a.join(), b.join()]);
    expect(ra.output).toBe('branch-conservative');
    expect(rb.output).toBe('branch-aggressive');
    expect(init.context.messages.some((m) => textOf(m.content).includes('保守'))).toBe(false);
  });
});

describe('V2: SIGCHLD 与事件总线（F-26/F-28）', () => {
  it('子退出时父收到 SIGCHLD，runtime 事件齐全', async () => {
    const { rt } = makeRuntime(() => ({ content: 'x' }));
    const events: string[] = [];
    rt.on('process:created', () => events.push('created'));
    rt.on('process:exit', () => events.push('exit'));
    const init = rt.init({ task: 'p' });
    const chld: Array<{ pid: number; status?: string }> = [];
    init.on('SIGCHLD', (e: { pid: number; status?: string }) => chld.push(e));
    const child = init.spawn({ task: 'c' });
    await Promise.all([init.join(), child.join()]);
    expect(chld.length).toBe(1);
    expect(chld[0].pid).toBe(child.pid);
    expect(chld[0].status).toBe('done');
    expect(events.filter((e) => e === 'created').length).toBe(2);
    expect(events.filter((e) => e === 'exit').length).toBe(2);
  });
});

describe('V2: 管道（F-24/F-25）', () => {
  it('stream 模式：writer 的 stdout 流入 reader 上下文', async () => {
    const { rt } = makeRuntime((msgs) => {
      const task = textOf(msgs.find((m) => m.role === 'user')?.content ?? '');
      if (task === 'writer') return { content: 'hello-from-writer', delayMs: 100 };
      // reader
      const got = msgs.some(
        (m) => m.role === 'user' && textOf(m.content).includes('hello-from-writer'),
      );
      if (got) return { content: 'echoed:hello-from-writer' };
      if (msgs.filter((m) => m.role === 'tool').length === 0)
        return { content: '', toolCalls: [{ name: 'slow_tool', arguments: { ms: 400 } }] };
      return { content: 'missed' };
    });
    const init = rt.init({ task: 'root', tools: [slowTool] });
    const writer = init.spawn({ task: 'writer' });
    const reader = init.spawn({ task: 'reader', tools: [slowTool] });
    rt.pipe(writer.pid, reader.pid);
    const rr = await reader.join();
    expect(rr.output).toBe('echoed:hello-from-writer');
    await Promise.all([writer.join(), init.join()]);
  });

  it('batch 模式：攒批为一条消息注入', async () => {
    const { rt } = makeRuntime((msgs) => {
      const task = textOf(msgs.find((m) => m.role === 'user')?.content ?? '');
      if (task === 'writer') {
        const k = msgs.filter((m) => m.role === 'tool').length;
        if (k < 3) return { content: `c${k + 1}`, toolCalls: [{ name: 'nop', arguments: {} }] };
        return { content: 'writer-done' };
      }
      const combined = msgs.find(
        (m) => m.role === 'user' && textOf(m.content).includes('c1\nc2\nc3'),
      );
      if (combined) return { content: 'batch-received' };
      if (msgs.filter((m) => m.role === 'tool').length === 0)
        return { content: '', toolCalls: [{ name: 'slow_tool', arguments: { ms: 500 } }] };
      return { content: 'missed' };
    });
    const init = rt.init({ task: 'root', tools: [slowTool] });
    const writer = init.spawn({ task: 'writer', tools: [slowTool] });
    // writer 用未注册工具 nop → 产生 Error 工具结果即可推进轮次
    const reader = init.spawn({ task: 'reader', tools: [slowTool] });
    rt.pipe(writer.pid, reader.pid, { mode: 'batch', batchSize: 3 });
    const rr = await reader.join();
    expect(rr.output).toBe('batch-received');
    await Promise.all([writer.join(), init.join()]);
  });

  it('tool 模式：reader 用 read_pipe 主动拉取', async () => {
    const { rt } = makeRuntime((msgs) => {
      const task = textOf(msgs.find((m) => m.role === 'user')?.content ?? '');
      if (task === 'writer') return { content: 'pipe-data', delayMs: 80 };
      const tools = msgs.filter((m) => m.role === 'tool');
      if (tools.length === 0)
        return { content: '', toolCalls: [{ name: 'slow_tool', arguments: { ms: 250 } }] };
      if (tools.length === 1)
        return { content: '', toolCalls: [{ name: 'read_pipe', arguments: {} }] };
      const payloads = JSON.parse(textOf(tools[1].content))
        .map((m: any) => m.payload)
        .join(',');
      return { content: `got:${payloads}` };
    });
    const init = rt.init({ task: 'root', tools: [slowTool] });
    const writer = init.spawn({ task: 'writer' });
    const reader = init.spawn({ task: 'reader', tools: [slowTool] });
    rt.pipe(writer.pid, reader.pid, { mode: 'tool' });
    const rr = await reader.join();
    expect(rr.output).toBe('got:pipe-data');
    await Promise.all([writer.join(), init.join()]);
  });

  it('EPIPE：读端死亡后显式写抛 PipeClosedError，管道自动关闭', async () => {
    const { rt } = makeRuntime((msgs) => {
      const task = textOf(msgs.find((m) => m.role === 'user')?.content ?? '');
      if (task === 'writer') return { content: 'late-writer', delayMs: 300 };
      return { content: 'reader-quick' };
    });
    const init = rt.init({ task: 'root' });
    const writer = init.spawn({ task: 'writer' });
    const reader = init.spawn({ task: 'reader' });
    const pipe = rt.pipe(writer.pid, reader.pid);
    await reader.join();
    await expect(pipe.send('x')).rejects.toThrow(/EPIPE/);
    await writer.join();
    await new Promise((r) => setTimeout(r, 50));
    expect(pipe.closed).toBe(true);
    await init.join();
  });
});

describe('V2: 信号量集成（F-21）', () => {
  it('进程工具经信号量限流，临界区并发为 1', async () => {
    const { rt } = makeRuntime((msgs) =>
      msgs.filter((m) => m.role === 'tool').length === 0
        ? { content: '', toolCalls: [{ name: 'critical', arguments: {} }] }
        : { content: 'done' },
    );
    const sem = rt.semaphore(1);
    let active = 0;
    let maxActive = 0;
    const critical: Tool = {
      name: 'critical',
      description: 'critical section',
      parameters: { type: 'object', properties: {} },
      execute: async (_args, ctx) => {
        await sem.acquire(ctx.pid);
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 100));
        active--;
        sem.release(ctx.pid);
        return 'ok';
      },
    };
    const init = rt.init({ task: 'p', tools: [critical] });
    const a = init.spawn({ task: 'a', tools: [critical] });
    const b = init.spawn({ task: 'b', tools: [critical] });
    await Promise.all([a.join(), b.join(), init.join()]);
    expect(maxActive).toBe(1);
  });
});
