import { describe, it, expect } from 'vitest';
import { AgentRuntime } from '../../src/core/runtime';
import { DeepSeekProvider } from '../../src/llm/deepseek';
import type { Tool } from '../../src/types';

const RUN = process.env.RUN_LIVE === '1' && !!process.env.DEEPSEEK_API_KEY;

function liveRuntime() {
  const deepseek = new DeepSeekProvider({
    apiKey: process.env.DEEPSEEK_API_KEY!,
    baseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
    timeoutMs: 55_000,
  });
  return new AgentRuntime({
    providers: [deepseek],
    defaults: { model: { model: 'deepseek-v4-pro', temperature: 0.3 } },
    models: { pro: 'deepseek-v4-pro', flash: 'deepseek-v4-flash' },
  });
}

describe.skipIf(!RUN)('冒烟：DeepSeek 真实 API', () => {
  it('flash 完成真实对话', async () => {
    const rt = liveRuntime();
    const init = rt.init({
      task: '用一句中文回答：1+1等于几？',
      model: { model: 'flash', maxTokens: 100 },
    });
    const result = await init.join();
    expect(result.status).toBe('done');
    expect(result.output.length).toBeGreaterThan(0);
    expect(result.usage.totalTokens).toBeGreaterThan(0);
    expect(init.resolvedModel).toBe('deepseek-v4-flash');
    console.log('[live:flash]', result.output, result.usage);
  }, 60_000);

  it('pro 完成真实对话', async () => {
    const rt = liveRuntime();
    const init = rt.init({
      task: '用一句中文回答：太阳从哪边升起？',
      model: { model: 'pro', maxTokens: 100 },
    });
    const result = await init.join();
    expect(result.status).toBe('done');
    expect(result.output.length).toBeGreaterThan(0);
    console.log('[live:pro]', result.output, result.usage);
  }, 60_000);

  it('混合模型 spawn：pro 父 + flash 子（blocking）', async () => {
    const rt = liveRuntime();
    const init = rt.init({ task: '你是协调者。', model: { model: 'pro', maxTokens: 100 } });
    await init.join();
    const childResult = await init.spawn({
      task: '用一句中文回答：水的化学式是什么？',
      model: { model: 'flash', maxTokens: 100 },
      mode: 'blocking',
    });
    expect(childResult.status).toBe('done');
    expect(childResult.output.length).toBeGreaterThan(0);
    console.log('[live:mixed] child:', childResult.output, childResult.usage);
  }, 90_000);

  it('真实 API 工具调用循环', async () => {
    const rt = liveRuntime();
    let toolCalled = 0;
    const getTime: Tool = {
      name: 'get_current_time',
      description: 'Get the current server time',
      parameters: { type: 'object', properties: {} },
      execute: () => {
        toolCalled++;
        return { time: '2026-07-17 15:00:00 CST' };
      },
    };
    const init = rt.init({
      task: '现在几点？请调用 get_current_time 工具获取，然后用一句中文告诉我。',
      model: { model: 'flash', maxTokens: 300 },
      tools: [getTime],
    });
    const result = await init.join();
    expect(result.status).toBe('done');
    expect(toolCalled).toBeGreaterThan(0);
    expect(result.output.length).toBeGreaterThan(0);
    console.log('[live:tools]', result.output, 'toolCalled=', toolCalled);
  }, 90_000);
});
