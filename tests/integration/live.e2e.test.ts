/**
 * 真实 DeepSeek 模型的端到端测试（RUN_LIVE=1 门控，无 Mock）。
 * 断言为语义级：状态、退出码、进程表形态、输出包含关键词。
 */
import { describe, it, expect } from 'vitest';
import { AgentRuntime } from '../../src/core/runtime';
import { textOf } from '../../src/types';
import { DeepSeekProvider } from '../../src/llm/deepseek';
import type { Tool } from '../../src/types';

const RUN = process.env.RUN_LIVE === '1' && !!process.env.DEEPSEEK_API_KEY;

function liveRuntime(opts: Record<string, unknown> = {}) {
  const deepseek = new DeepSeekProvider({
    apiKey: process.env.DEEPSEEK_API_KEY!,
    baseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
    timeoutMs: 55_000,
  });
  return new AgentRuntime({
    providers: [deepseek],
    // 默认 flash + temperature 0：低成本、行为稳定
    defaults: { model: { model: 'deepseek-v4-flash', temperature: 0 } },
    models: { pro: 'deepseek-v4-pro', flash: 'deepseek-v4-flash' },
    ...opts,
  });
}

const slowTool: Tool = {
  name: 'slow_tool',
  description: 'Wait for ms milliseconds, then return. Used for waiting.',
  parameters: {
    type: 'object',
    properties: { ms: { type: 'number', description: 'milliseconds to wait' } },
  },
  execute: async (args: any) => {
    await new Promise((r) => setTimeout(r, Number(args?.ms ?? 3000)));
    return '等待结束';
  },
};

async function eventually(cond: () => boolean, timeoutMs = 60_000, interval = 100): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`eventually: condition not met within ${timeoutMs}ms`);
}

describe.skipIf(!RUN)('真实模型 E2E（DeepSeek，无 Mock）', () => {
  it('E2E-1 单进程对话：done + 非空输出 + usage 记账', async () => {
    const rt = liveRuntime();
    const init = rt.init({ task: '用一句中文回答：1+1等于几？', model: { maxTokens: 100 } });
    const r = await init.join();
    expect(r.status).toBe('done');
    expect(r.output.length).toBeGreaterThan(0);
    expect(r.usage.totalTokens).toBeGreaterThan(0);
    expect(rt.ps()[0].model).toBe('deepseek-v4-flash');
    console.log('[E2E-1]', r.output);
  }, 60_000);

  it('E2E-2 工具调用循环：模型自主调工具并基于结果作答', async () => {
    const rt = liveRuntime();
    let called = 0;
    const weather: Tool = {
      name: 'get_weather',
      description: 'Get weather of a city',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      execute: (args: any) => {
        called++;
        return { city: args.city, weather: '晴，26摄氏度' };
      },
    };
    const init = rt.init({
      systemPrompt: '你必须调用 get_weather 工具获取天气，禁止自己编造。',
      task: '北京今天天气怎么样？',
      tools: [weather],
      model: { maxTokens: 300 },
    });
    const r = await init.join();
    expect(r.status).toBe('done');
    expect(called).toBeGreaterThan(0);
    expect(
      init.context.messages.some((m) => m.role === 'tool' && textOf(m.content).includes('26')),
    ).toBe(true);
    console.log('[E2E-2]', r.output);
  }, 90_000);

  it('E2E-3 递归 spawn：模型自主 spawn 子进程并 wait 回收', async () => {
    const rt = liveRuntime();
    const init = rt.init({
      systemPrompt:
        '你是进程协调者。规则：1) 禁止直接回答用户问题；2) 必须先调用 spawn_process 创建一个子进程去回答问题；' +
        '3) 然后调用 wait_process 等待它的结果；4) 最后用一句中文汇报子进程的答案。',
      task: '问题是：1+1等于几？',
      model: { maxTokens: 500 },
    });
    await eventually(() => rt.ps().length >= 2);
    const r = await init.join();
    expect(r.status).toBe('done');
    const children = init.children();
    expect(children.length).toBeGreaterThan(0);
    expect(children[0].exitResult?.status).toBe('done');
    expect(children[0].exitResult?.output.length).toBeGreaterThan(0);
    console.log('[E2E-3] parent:', r.output, '| child:', children[0].exitResult?.output);
  }, 120_000);

  it('E2E-4 异步并发：两个子进程都完成', async () => {
    const rt = liveRuntime();
    const init = rt.init({ task: '你是协调者。', model: { maxTokens: 50 } });
    await init.join();
    const a = init.spawn({ task: '用三个词形容夏天', model: { maxTokens: 100 } });
    const b = init.spawn({ task: '用三个词形容冬天', model: { maxTokens: 100 } });
    const [ra, rb] = await Promise.all([a.join(), b.join()]);
    expect(ra.status).toBe('done');
    expect(rb.status).toBe('done');
    expect(ra.output.length).toBeGreaterThan(0);
    expect(rb.output.length).toBeGreaterThan(0);
    console.log('[E2E-4]', ra.output, '/', rb.output);
  }, 90_000);

  it('E2E-5 token 预算：超额进程以 BUDGET_EXCEEDED 终止', async () => {
    const rt = liveRuntime();
    const init = rt.init({ task: '协调者', model: { maxTokens: 50 } });
    await init.join();
    const child = init.spawn({ task: '写一篇 500 字关于大海的作文', budget: { tokens: 50 } });
    const r = await child.join();
    expect(r.status).toBe('killed');
    expect(r.reason).toBe('BUDGET_EXCEEDED');
  }, 60_000);

  it('E2E-6 turns 配额：第二轮后以 MAX_TURNS 终止', async () => {
    const rt = liveRuntime();
    let n = 0;
    const counter: Tool = {
      name: 'counter',
      description: 'increment and return count',
      parameters: { type: 'object', properties: {} },
      execute: () => ++n,
    };
    const init = rt.init({
      systemPrompt: '第一步调用 counter 工具，第二步复述其返回值。',
      task: '开始',
      tools: [counter],
      budget: { turns: 1 },
      model: { maxTokens: 300 },
    });
    const r = await init.join();
    expect(r.status).toBe('killed');
    expect(r.reason).toBe('MAX_TURNS');
  }, 90_000);

  it('E2E-7 wall 配额：step 边界 TIMEOUT', async () => {
    const rt = liveRuntime();
    const init = rt.init({
      systemPrompt: '第一步必须调用 slow_tool 工具（参数 ms=500）；第二步回答"完成"。',
      task: '开始',
      tools: [slowTool],
      budget: { wallMs: 1 }, // 首次 LLM 调用必然超过 1ms，下一个 step 边界即触发
      model: { maxTokens: 300 },
    });
    const r = await init.join();
    expect(r.status).toBe('killed');
    expect(r.reason).toBe('TIMEOUT');
  }, 60_000);

  it('E2E-8 SIGKILL：长任务被强制中止', async () => {
    const rt = liveRuntime();
    const init = rt.init({ task: '协调者', model: { maxTokens: 50 } });
    await init.join();
    const child = init.spawn({ task: '写一篇 2000 字关于宇宙的长文', model: { maxTokens: 3000 } });
    await new Promise((r) => setTimeout(r, 800));
    const t0 = Date.now();
    rt.signal(child.pid, 'SIGKILL');
    const r = await child.join();
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(r.status).toBe('killed');
    expect(r.reason).toBe('SIGKILL');
  }, 60_000);

  it('E2E-9 SIGTERM：工具执行中发信号，step 边界优雅退出', async () => {
    const rt = liveRuntime();
    const init = rt.init({
      systemPrompt:
        '严格按步骤执行：第一步必须调用 slow_tool 工具（参数 ms=4000）；工具返回后，第二步回答"已完成"。禁止跳过第一步。',
      task: '开始执行',
      tools: [slowTool],
      model: { maxTokens: 300 },
    });
    await new Promise((r) => setTimeout(r, 2500));
    rt.signal(init.pid, 'SIGTERM');
    const r = await init.join();
    expect(r.status).toBe('done');
    expect(r.reason).toBe('SIGTERM');
    expect(r.exitCode).toBe(0);
  }, 90_000);

  it('E2E-10 用户注入：运行中进程接收并响应用户消息', async () => {
    const rt = liveRuntime();
    const init = rt.init({
      systemPrompt:
        '第一步必须调用 slow_tool 工具（参数 ms=4000）等待。之后严格按用户的最新指示给出最终答案。',
      task: '等待用户指示',
      tools: [slowTool],
      model: { maxTokens: 300 },
    });
    rt.user.attach(init.pid);
    await new Promise((r) => setTimeout(r, 2500));
    await rt.user.send(undefined, '请把"你好世界"作为最终答案，只回复这四个字。');
    const r = await init.join();
    expect(r.status).toBe('done');
    expect(r.output).toContain('你好世界');
    expect(init.context.messages.some((m) => m.meta?.from === 0)).toBe(true);
    console.log('[E2E-10]', r.output);
  }, 90_000);

  it('E2E-11 管道：writer 的产出经管道进入 reader 上下文并被复述', async () => {
    const rt = liveRuntime();
    const init = rt.init({ task: '协调者', tools: [slowTool], model: { maxTokens: 50 } });
    const writer = init.spawn({
      systemPrompt: '无论收到什么，只回复"菠萝蜜数据"四个字，不要调用任何工具，不要输出其他内容。',
      task: '输出数据',
      model: { maxTokens: 50 },
    });
    const reader = init.spawn({
      systemPrompt:
        '第一步必须调用 slow_tool 工具（参数 ms=9000）等待数据。之后你会收到来自其他进程的消息，第二步：原样复述你收到的进程消息内容。',
      task: '等待并复述数据',
      tools: [slowTool],
      model: { maxTokens: 300 },
    });
    rt.pipe(writer.pid, reader.pid);
    const rr = await reader.join();
    expect(rr.status).toBe('done');
    expect(rr.output).toContain('菠萝蜜数据');
    await writer.join();
    await init.join();
    console.log('[E2E-11]', rr.output);
  }, 120_000);

  it('E2E-12 fork：分支独立演化', async () => {
    const rt = liveRuntime();
    const init = rt.init({ task: '1+1等于几？', model: { maxTokens: 100 } });
    const r1 = await init.join();
    expect(r1.status).toBe('done');
    const branch = init.fork('请改用英文重新回答同样的问题。');
    const rb = await branch.join();
    expect(rb.status).toBe('done');
    expect(rb.output.length).toBeGreaterThan(0);
    expect(init.context.messages.some((m) => textOf(m.content).includes('英文'))).toBe(false);
    console.log('[E2E-12] init:', r1.output, '| branch:', rb.output);
  }, 90_000);

  it('E2E-13 信号量：真实模型并发调用临界区工具，互斥为 1', async () => {
    const rt = liveRuntime();
    const sem = rt.semaphore(1);
    let active = 0;
    let maxActive = 0;
    const critical: Tool = {
      name: 'critical',
      description: 'enter critical section and return ok',
      parameters: { type: 'object', properties: {} },
      execute: async (_args, ctx) => {
        await sem.acquire(ctx.pid);
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 1500));
        active--;
        sem.release(ctx.pid);
        return 'ok';
      },
    };
    const init = rt.init({ task: '协调者', tools: [critical], model: { maxTokens: 50 } });
    const mk = (t: string) =>
      init.spawn({
        systemPrompt: '第一步调用 critical 工具，第二步复述其返回值。',
        task: t,
        tools: [critical],
        model: { maxTokens: 200 },
      });
    const a = mk('任务A');
    const b = mk('任务B');
    await Promise.all([a.join(), b.join(), init.join()]);
    expect(maxActive).toBe(1);
  }, 120_000);

  it('E2E-14 supervisor（restart=always）：进程完成后被重启一次', async () => {
    const rt = liveRuntime();
    let n = 0;
    const counter: Tool = {
      name: 'counter',
      description: 'increment and return count',
      parameters: { type: 'object', properties: {} },
      execute: () => ++n,
    };
    const init = rt.init({ task: '协调者', tools: [counter], model: { maxTokens: 50 } });
    init.spawn({
      systemPrompt: '第一步调用 counter 工具一次，第二步复述其返回值。',
      task: '开始',
      name: 'sup',
      tools: [counter],
      model: { maxTokens: 200 },
      supervision: { strategy: 'one-for-one', restart: 'always', maxRestarts: 1 },
    });
    // 等原进程 + 1 次重启都完成（counter 被调用两次且两进程均 done）
    await eventually(
      () => rt.ps().filter((s) => s.name === 'sup' && s.exit?.status === 'done').length === 2,
      90_000,
    );
    expect(n).toBe(2);
    const doneProcs = rt.ps().filter((s) => s.name === 'sup' && s.exit?.status === 'done');
    expect(doneProcs.length).toBe(2);
    await init.join();
  }, 120_000);

  it('E2E-15 checkpoint/restore：运行中快照，新 runtime 恢复后跑完', async () => {
    const rt = liveRuntime();
    const init = rt.init({ task: '协调者', tools: [slowTool], model: { maxTokens: 50 } });
    const child = init.spawn({
      systemPrompt:
        '第一步必须调用 slow_tool 工具（参数 ms=3000）；工具返回后，第二步用一句中文回答"恢复成功"。',
      task: '开始',
      tools: [slowTool],
      model: { maxTokens: 300 },
    });
    await init.join();
    await new Promise((r) => setTimeout(r, 2500)); // child 处于 ON_TOOL
    const snap = rt.checkpoint();
    expect(snap.processes.length).toBe(2);

    const rt2 = liveRuntime();
    rt2.restore(snap);
    expect(rt2.ps()[1].state).toBe('paused');
    rt2.signal(2, 'SIGCONT');
    const r = await rt2.getRequired(2).join();
    expect(r.status).toBe('done');
    expect(r.output.length).toBeGreaterThan(0);
    console.log('[E2E-15]', r.output);
    await child.join().catch(() => undefined);
  }, 120_000);

  it('E2E-16 worker 隔离 + 真实 DeepSeek：独立线程完成对话', async () => {
    const rt = liveRuntime();
    const init = rt.init({ task: '协调者', model: { maxTokens: 50 } });
    await init.join();
    const child = init.spawn({
      task: '用一句中文回答：2+2等于几？',
      isolation: 'worker',
      worker: { provider: 'deepseek' },
      model: { maxTokens: 100 },
    });
    const r = await child.join();
    expect(r.status).toBe('done');
    expect(r.output.length).toBeGreaterThan(0);
    expect(r.usage.totalTokens).toBeGreaterThan(0);
    console.log('[E2E-16]', r.output);
  }, 90_000);
});
