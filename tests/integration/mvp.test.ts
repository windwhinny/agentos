import { describe, it, expect } from 'vitest';
import { AgentRuntime } from '../../src/core/runtime';
import { textOf } from '../../src/types';
import { MockLLMProvider, type MockResponder } from '../../src/llm/mock';
import type { Tool } from '../../src/types';
import { abortableSleep } from '../../src/utils';
import { MaxDepthError, TimeoutError, ToolNotAllowedError } from '../../src/errors';

const slowTool: Tool = {
  name: 'slow_tool',
  description: 'sleep for ms',
  parameters: { type: 'object', properties: { ms: { type: 'number' } } },
  execute: async (args: any, ctx) => {
    await abortableSleep(args?.ms ?? 300, ctx.signal);
    return 'slept';
  },
};

const addTool: Tool = {
  name: 'add',
  description: 'add two numbers',
  parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } },
  execute: (args: any) => Number(args.a) + Number(args.b),
};

function makeRuntime(responder: MockResponder, opts: Record<string, unknown> = {}) {
  const mock = new MockLLMProvider(responder);
  const rt = new AgentRuntime({
    providers: [mock],
    defaults: { model: { model: 'deepseek-v4-pro' } },
    models: { pro: 'deepseek-v4-pro', flash: 'deepseek-v4-flash' },
    ...opts,
  });
  return { rt, mock };
}

describe('MVP: 单进程生命周期（F-1/F-2）', () => {
  it('init 完成单轮对话并产出 ExitResult', async () => {
    const { rt } = makeRuntime(() => ({ content: '你好，我是 init' }));
    const init = rt.init({ task: '打个招呼' });
    expect(init.pid).toBe(1);
    const result = await init.join();
    expect(result.status).toBe('done');
    expect(result.output).toBe('你好，我是 init');
    expect(result.usage.totalTokens).toBe(15);
    const snap = rt.ps();
    expect(snap.length).toBe(1);
    expect(snap[0].state).toBe('done');
  });

  it('工具调用循环（F-13）', async () => {
    const { rt } = makeRuntime((msgs, n) =>
      n === 1
        ? { content: '', toolCalls: [{ name: 'add', arguments: { a: 1, b: 2 } }] }
        : { content: `结果是 ${msgs.filter((m) => m.role === 'tool')[0].content}` },
    );
    const init = rt.init({ task: '算一下', tools: [addTool] });
    const result = await init.join();
    expect(result.output).toBe('结果是 3');
    expect(result.turns).toBe(2);
    const toolChunks = init.stdout.read().filter((c) => c.type === 'tool');
    expect(toolChunks.length).toBe(1);
  });
});

describe('MVP: 模型参数化（F-3）', () => {
  it('子进程可覆盖模型与推理参数，别名生效', async () => {
    const { rt, mock } = makeRuntime(() => ({ content: 'ok' }));
    const init = rt.init({ task: 'parent' });
    const child = init.spawn({
      task: 'child',
      model: { model: 'flash', temperature: 0.1, maxTokens: 50 },
    });
    await child.join();
    const childCall = mock.calls[mock.calls.length - 1];
    expect(childCall.model).toBe('deepseek-v4-flash');
    expect(childCall.temperature).toBe(0.1);
    expect(childCall.maxTokens).toBe(50);
    await init.join();
  });

  it('未指定时继承父进程模型配置', async () => {
    const { rt, mock } = makeRuntime(() => ({ content: 'ok' }));
    const init = rt.init({ task: 'p', model: { model: 'deepseek-v4-pro', temperature: 0.3 } });
    const child = init.spawn({ task: 'c' });
    await child.join();
    expect(mock.calls[mock.calls.length - 1].model).toBe('deepseek-v4-pro');
    expect(mock.calls[mock.calls.length - 1].temperature).toBe(0.3);
    await init.join();
  });
});

describe('MVP: 阻塞 / 异步执行（F-4/F-5）', () => {
  it('API blocking spawn：返回子进程 ExitResult', async () => {
    const { rt } = makeRuntime((msgs) => {
      const task = textOf(msgs.find((m) => m.role === 'user')?.content ?? '');
      return task.includes('child-task')
        ? { content: 'child-done', delayMs: 100 }
        : { content: 'parent-done' };
    });
    const init = rt.init({ task: 'parent-task' });
    await init.join();
    const result = await init.spawn({ task: 'child-task', mode: 'blocking' });
    expect(result.output).toBe('child-done');
    expect(result.status).toBe('done');
  });

  it('循环内 wait_process：父处于 BLOCKED_ON_CHILD，子退出后恢复', async () => {
    const { rt } = makeRuntime((msgs) => {
      const task = textOf(msgs.find((m) => m.role === 'user')?.content ?? '');
      if (task.includes('child-task')) return { content: 'child-done', delayMs: 250 };
      const toolMsgs = msgs.filter((m) => m.role === 'tool');
      if (toolMsgs.length === 0)
        return {
          content: '',
          toolCalls: [{ name: 'spawn_process', arguments: { task: 'child-task' } }],
        };
      if (toolMsgs.length === 1) {
        const pid = JSON.parse(textOf(toolMsgs[0].content)).pid;
        return { content: '', toolCalls: [{ name: 'wait_process', arguments: { pid } }] };
      }
      return { content: 'parent-done' };
    });
    const init = rt.init({ task: 'parent-task' });
    await new Promise((r) => setTimeout(r, 120));
    expect(init.state).toBe('blocked');
    expect(init.blockedReason).toBe('ON_CHILD');
    const result = await init.join();
    expect(result.output).toBe('parent-done');
    expect(init.state).toBe('done');
  });

  it('两个子进程异步并发，wall time 小于串行', async () => {
    const { rt } = makeRuntime(() => ({ content: 'slow-ok', delayMs: 400 }));
    const init = rt.init({ task: 'p' });
    const t0 = Date.now();
    const a = init.spawn({ task: 'a' });
    const b = init.spawn({ task: 'b' });
    const [ra, rb] = await Promise.all([a.join(), b.join()]);
    const elapsed = Date.now() - t0;
    expect(ra.output).toBe('slow-ok');
    expect(rb.output).toBe('slow-ok');
    expect(elapsed).toBeLessThan(700); // 串行需 800ms+
    await init.join();
  });
});

describe('MVP: 递归 spawn 与深度限制（F-6）', () => {
  const treeResponder: MockResponder = (msgs) => {
    const task = textOf(msgs.find((m) => m.role === 'user')?.content ?? '');
    const toolMsgs = msgs.filter((m) => m.role === 'tool');
    if (task.includes('level3')) return { content: 'leaf-done' };
    const next = task.includes('level1') ? 'level2' : 'level3';
    if (toolMsgs.length === 0)
      return { content: '', toolCalls: [{ name: 'spawn_process', arguments: { task: next } }] };
    if (toolMsgs.length === 1) {
      const pid = JSON.parse(textOf(toolMsgs[0].content)).pid;
      return { content: '', toolCalls: [{ name: 'wait_process', arguments: { pid } }] };
    }
    const exit = JSON.parse(textOf(toolMsgs[1].content));
    return { content: `done:${exit.output}` };
  };

  it('子进程通过内置工具再建孙进程（三层树）', async () => {
    const { rt } = makeRuntime(treeResponder);
    const init = rt.init({ task: 'level1' });
    const result = await init.join();
    expect(result.output).toBe('done:done:leaf-done');
    expect(rt.ps().length).toBe(3);
  });

  it('超过 maxDepth 抛 MaxDepthError', async () => {
    const { rt } = makeRuntime(() => ({ content: 'x' }), { maxDepth: 1 });
    const init = rt.init({ task: 'p' });
    const child = init.spawn({ task: 'c' }); // depth 1 OK
    expect(() => rt.spawn(child.pid, { task: 'gc' })).toThrow(MaxDepthError);
    await Promise.all([init.join(), child.join()]);
  });
});

describe('MVP: 预算（F-7）', () => {
  const budgetResponder: MockResponder = (msgs) => {
    const task = textOf(msgs.find((m) => m.role === 'user')?.content ?? '');
    if (task === 'p') return { content: 'parent-done' };
    return msgs.filter((m) => m.role === 'tool').length === 0
      ? { content: '', toolCalls: [{ name: 'add', arguments: { a: 1, b: 1 } }] }
      : { content: 'never' };
  };

  it('子进程 token 预算耗尽 → BUDGET_EXCEEDED', async () => {
    const { rt } = makeRuntime(budgetResponder);
    const init = rt.init({ task: 'p', tools: [addTool] });
    const child = init.spawn({ task: 'c', tools: [addTool], budget: { tokens: 20 } });
    const result = await child.join();
    expect(result.status).toBe('killed');
    expect(result.reason).toBe('BUDGET_EXCEEDED');
    await init.join();
  });

  it('父预算链式扣减：父超额导致子被杀', async () => {
    const { rt } = makeRuntime(budgetResponder);
    const init = rt.init({ task: 'p', tools: [addTool], budget: { tokens: 25 } });
    const child = init.spawn({ task: 'c', tools: [addTool], budget: { tokens: 1000 } });
    const result = await child.join();
    expect(result.reason).toBe('BUDGET_EXCEEDED');
    // init 自身 15 + 子第一次 15 = 30 > 25
    expect(rt.get(1)!.budget.usedTokens).toBe(30);
    await init.join();
  });
});

describe('MVP: 信号与取消链（F-8/F-9）', () => {
  it('SIGKILL 级联整棵子树，1s 内终止', async () => {
    const { rt } = makeRuntime(() => ({ content: 'too-late', delayMs: 5000 }));
    const init = rt.init({ task: 'p' });
    const child = init.spawn({ task: 'c' });
    const gc = child.spawn({ task: 'gc' });
    await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    rt.signal(init.pid, 'SIGKILL');
    const [ri, rc, rg] = await Promise.all([init.join(), child.join(), gc.join()]);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(ri.status).toBe('killed');
    expect(rc.reason).toBe('SIGKILL');
    expect(rg.reason).toBe('SIGKILL');
  });

  it('SIGTERM 在 step 边界优雅退出', async () => {
    const { rt, mock } = makeRuntime((msgs, n) =>
      n === 1
        ? { content: '', toolCalls: [{ name: 'slow_tool', arguments: { ms: 200 } }] }
        : { content: 'never-reached' },
    );
    const init = rt.init({ task: 'p', tools: [slowTool] });
    await new Promise((r) => setTimeout(r, 50));
    rt.signal(init.pid, 'SIGTERM');
    const result = await init.join();
    expect(result.status).toBe('done');
    expect(result.reason).toBe('SIGTERM');
    expect(result.exitCode).toBe(0);
    expect(mock.calls.length).toBe(1); // 第二轮 LLM 调用未发生
  });
});

describe('MVP: 用户交互（F-10）', () => {
  it('attach + send：消息注入运行中进程的上下文', async () => {
    const { rt } = makeRuntime((msgs) => {
      const injected = msgs.some(
        (m) => m.role === 'user' && textOf(m.content).includes('USER_INJECT'),
      );
      if (injected) return { content: 'got-inject' };
      const toolResults = msgs.filter((m) => m.role === 'tool').length;
      if (toolResults === 0)
        return { content: '', toolCalls: [{ name: 'slow_tool', arguments: { ms: 300 } }] };
      return { content: 'missed' };
    });
    const init = rt.init({ task: 'p', tools: [slowTool] });
    rt.user.attach(init.pid);
    expect(rt.user.attachedPid).toBe(init.pid);
    await new Promise((r) => setTimeout(r, 100));
    await rt.user.send(undefined, 'USER_INJECT hello');
    const result = await init.join();
    expect(result.output).toBe('got-inject');
    const injectedMsg = init.context.messages.find((m) => m.meta?.from === 0);
    expect(injectedMsg).toBeTruthy();
  });
});

describe('MVP: 父内省与 ps（F-11/F-12）', () => {
  it('children / descendants / readOutput / tap', async () => {
    const { rt } = makeRuntime((msgs) => {
      const task = textOf(msgs.find((m) => m.role === 'user')?.content ?? '');
      return { content: `out:${task}` };
    });
    const init = rt.init({ task: 'root-task' });
    const a = init.spawn({ task: 'A' });
    const b = init.spawn({ task: 'B' });
    const seen: string[] = [];
    rt.tap(init.pid, a.pid, (c) => seen.push(String(c.data)));
    await Promise.all([a.join(), b.join(), init.join()]);
    expect(init.children().length).toBe(2);
    expect(init.descendants().length).toBe(2);
    const out = rt.readOutput(init.pid, a.pid);
    expect(out.some((c) => c.data === 'out:A')).toBe(true);
    expect(seen).toContain('out:A');
    // 非子树内省被拒绝
    expect(() => rt.readOutput(a.pid, b.pid)).toThrow();
    const snap = rt.ps();
    expect(snap.length).toBe(3);
    expect(snap[1]).toHaveProperty('usage');
    expect(snap[1]).toHaveProperty('model');
    expect(snap[1]).toHaveProperty('uptimeMs');
  });
});

describe('MVP: 工具白名单与 join 超时（F-13/F-4）', () => {
  it('子进程工具超出父白名单被拒绝', async () => {
    const { rt } = makeRuntime(() => ({ content: 'ok' }));
    const init = rt.init({ task: 'p', tools: [addTool] });
    expect(() => init.spawn({ task: 'c', tools: [slowTool] })).toThrow(ToolNotAllowedError);
    const ok = init.spawn({ task: 'c2', tools: [addTool] });
    await ok.join();
    await init.join();
  });

  it('join 超时抛 TimeoutError 且不杀目标进程', async () => {
    const { rt } = makeRuntime(() => ({ content: 'later', delayMs: 300 }));
    const init = rt.init({ task: 'p' });
    const child = init.spawn({ task: 'c' });
    await expect(child.join({ timeoutMs: 50 })).rejects.toThrow(TimeoutError);
    const result = await child.join();
    expect(result.output).toBe('later');
    await init.join();
  });
});
