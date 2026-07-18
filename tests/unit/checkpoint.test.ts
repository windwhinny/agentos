import { describe, it, expect } from 'vitest';
import { AgentRuntime } from '../../src/core/runtime';
import { MockLLMProvider, type MockResponder } from '../../src/llm/mock';
import type { Tool } from '../../src/types';
import { abortableSleep } from '../../src/utils';

const slowTool: Tool = {
  name: 'slow_tool',
  description: 'sleep',
  parameters: { type: 'object', properties: { ms: { type: 'number' } } },
  execute: async (args: any, ctx) => {
    await abortableSleep(args?.ms ?? 200, ctx.signal);
    return 'slept';
  },
};

const responder: MockResponder = (msgs) => {
  const task = msgs.find((m) => m.role === 'user')?.content ?? '';
  if (task === 'p') return { content: 'p-done' };
  if (task === 'p2') return { content: 'p2-done' };
  // child：第一步调 slow_tool（400ms，checkpoint 时仍处于运行中），第二步收尾
  return msgs.filter((m) => m.role === 'tool').length === 0
    ? { content: '', toolCalls: [{ name: 'slow_tool', arguments: { ms: 400 } }] }
    : { content: 'c-done' };
};

describe('checkpoint / restore（F-27）', () => {
  it('快照-恢复后进程树结构、上下文、预算一致，暂停进程可继续', async () => {
    const mock = new MockLLMProvider(responder);
    const rt = new AgentRuntime({ providers: [mock], defaults: { model: { model: 'm1' } } });
    const init = rt.init({ task: 'p', tools: [slowTool], budget: { tokens: 500 } });
    const child = init.spawn({ task: 'c', tools: [slowTool], budget: { tokens: 200 } });
    await init.join();
    // 等 child 进入 ON_TOOL（blocked，非终态）
    await new Promise((r) => setTimeout(r, 200));

    const snap = rt.checkpoint();
    expect(snap.processes.length).toBe(2);

    // 恢复到新 runtime（共享同一 mock provider）
    const rt2 = new AgentRuntime({ providers: [mock], defaults: { model: { model: 'm1' } } });
    rt2.restore(snap);
    const ps2 = rt2.ps();
    expect(ps2.map((p) => p.pid)).toEqual([1, 2]);
    expect(ps2[1].ppid).toBe(1);
    expect(ps2[1].state).toBe('paused');
    // checkpoint 时子进程工具在执行中（悬挂 tool_calls），恢复时应补一条中断 tool 消息闭合轮次
    expect(rt2.getRequired(2).context.messages.length).toBe(
      rt.getRequired(2).context.messages.length + 1,
    );
    const lastMsg = rt2.getRequired(2).context.messages.at(-1)!;
    expect(lastMsg.role).toBe('tool');
    expect(lastMsg.content).toContain('interrupted');
    expect(rt2.getRequired(2).usage.totalTokens).toBe(rt.getRequired(2).usage.totalTokens);
    expect(rt2.getRequired(2).budget.quota.tokens).toBe(200);
    // 终态进程保持
    expect(ps2[0].state).toBe('done');

    // SIGCONT 继续跑直到完成
    rt2.signal(2, 'SIGCONT');
    const result = await rt2.getRequired(2).join();
    expect(result.status).toBe('done');
    expect(result.output).toBe('c-done');

    // nextPid 连续
    const later = rt2.getRequired(1).spawn({ task: 'p2' });
    expect(later.pid).toBe(3);
    await later.join();
    await child.join(); // 原 runtime 的子进程自然收尾
  });
});
