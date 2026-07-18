import { describe, it, expect } from 'vitest';
import { AgentRuntime } from '../../src/core/runtime';
import { MockLLMProvider, type MockResponder } from '../../src/llm/mock';
import { StdoutStream } from '../../src/ipc/stdio';
import type { OutputChunk, Tool } from '../../src/types';

const noopTool: Tool = { name: 'noop', description: 'noop', parameters: {}, execute: () => 'ok' };

function makeRuntime(responder: MockResponder, opts?: { streamDelayMs?: number }) {
  const provider = new MockLLMProvider(responder, { streamDelayMs: opts?.streamDelayMs ?? 5 });
  const rt = new AgentRuntime({
    providers: [provider],
    defaults: { model: { model: 'mock-v1' } },
    budget: { tokens: 500_000 },
  });
  return { rt, provider };
}

async function eventually(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error('eventually timeout');
    await new Promise((r) => setTimeout(r, 15));
  }
}

describe('流式输出（F-45）', () => {
  it('stdout.read 按 id 合并流式帧，只留最后一帧', () => {
    const s = new StdoutStream();
    s.push({ type: 'assistant', id: 'm1', done: false, data: { text: '你' }, ts: 1 });
    s.push({ type: 'assistant', id: 'm1', done: false, data: { text: '你好' }, ts: 2 });
    s.push({ type: 'assistant', id: 'm1', done: true, data: { text: '你好，世界' }, ts: 3 });
    s.push({ type: 'assistant', id: 'm2', done: true, data: { text: '第二条' }, ts: 4 });
    const read = s.read();
    expect(read.length).toBe(2);
    expect((read[0].data as { text: string }).text).toBe('你好，世界');
    expect(read[0].done).toBe(true);
    expect((read[1].data as { text: string }).text).toBe('第二条');
  });

  it('流式：多帧同 id 实时上屏，最终上下文与非流式一致', async () => {
    const content = '你好，这是 AgentOS 的流式输出测试，一共三十一个字哦。';
    const frames: OutputChunk[] = [];
    const { rt } = makeRuntime(() => ({ content }), { streamDelayMs: 8 });
    const p = rt.init({ task: 't' });
    p.stdout.tap((c) => frames.push(c));
    const r = await p.join();
    expect(r.status).toBe('done');
    // 中间帧多、共享 id、末帧 done
    const aFrames = frames.filter((c) => c.type === 'assistant');
    expect(aFrames.length).toBeGreaterThan(3);
    expect(new Set(aFrames.map((c) => c.id)).size).toBe(1);
    expect(aFrames[aFrames.length - 1].done).toBe(true);
    // 合并读取只剩一帧，文本完整
    const merged = p.stdout.read().filter((c) => c.type === 'assistant');
    expect(merged.length).toBe(1);
    expect((merged[0].data as { text: string }).text).toBe(content);
    // 上下文最终消息与非流式完全一致
    const last = p.context.messages[p.context.messages.length - 1];
    expect(last.role).toBe('assistant');
    expect(last.content).toBe(content);
    expect(r.output).toBe(content);
  });

  it('thinking：思考链进入 message.reasoning 与 chunk data.thinking', async () => {
    const { rt } = makeRuntime(() => ({ thinking: '先想三步……', content: '答案' }));
    const p = rt.init({ task: 't' });
    await p.join();
    const last = p.context.messages[p.context.messages.length - 1];
    expect(last.reasoning).toBe('先想三步……');
    const merged = p.stdout.read().filter((c) => c.type === 'assistant');
    const d = merged[0].data as { text: string; thinking?: string };
    expect(d.text).toBe('答案');
    expect(d.thinking).toBe('先想三步……');
  });
});

describe('中断（F-46，Codex Esc 语义）', () => {
  it('中断当前生成：保留部分输出，转 ON_INBOX，用户消息后继续', async () => {
    let calls = 0;
    const { rt } = makeRuntime(
      () => {
        calls++;
        return calls === 1 ? { content: '很长的输出'.repeat(200) } : { content: 'short-answer' };
      },
      { streamDelayMs: 40 },
    );
    const p = rt.init({ task: 't' });
    await eventually(() => p.blockedReason === 'ON_LLM');
    await new Promise((r) => setTimeout(r, 120)); // 流到一半
    p.interrupt();
    await eventually(() => p.state === 'blocked' && p.blockedReason === 'ON_INBOX');
    // 部分输出已落账 + 中断标记
    const assistant = p.context.messages.filter((m) => m.role === 'assistant');
    expect(assistant.length).toBe(1);
    expect((assistant[0].content as string).length).toBeLessThan('很长的输出'.repeat(200).length);
    expect(p.context.messages.some((m) => m.role === 'user' && m.meta?.kind === 'interrupt')).toBe(
      true,
    );
    expect(
      p.stdout.read().some((c) => c.type === 'stderr' && String(c.data).includes('中断')),
    ).toBe(true);
    expect(p.turns).toBe(0); // 中断轮不计 turns
    // 用户发话后继续并完成
    await rt.user.send(p.pid, '换个短回答');
    const r = await p.join();
    expect(r.status).toBe('done');
    expect(r.output).toBe('short-answer');
    expect(p.turns).toBe(1);
  });

  it('ON_INBOX 等待中 SIGKILL 能正常杀死进程', async () => {
    let calls = 0;
    const { rt } = makeRuntime(
      () => {
        calls++;
        return calls === 1 ? { content: '很长的输出'.repeat(200) } : { content: 'never' };
      },
      { streamDelayMs: 40 },
    );
    const p = rt.init({ task: 't' });
    await eventually(() => p.blockedReason === 'ON_LLM');
    await new Promise((r) => setTimeout(r, 120));
    p.interrupt();
    await eventually(() => p.blockedReason === 'ON_INBOX');
    p.signal('SIGKILL');
    const r = await p.join();
    expect(r.status).toBe('killed');
    expect(r.reason).toBe('SIGKILL');
  });
});

describe('多模态输入（F-47）', () => {
  it('send 带图片：上下文生成 image_url + text 多模态消息', async () => {
    let calls = 0;
    const { rt, provider } = makeRuntime(() => {
      calls++;
      return calls === 1
        ? { content: 'working', toolCalls: [{ name: 'noop' }], delayMs: 150 }
        : { content: 'seen' };
    });
    const p = rt.init({ task: '看图', tools: [noopTool] });
    await new Promise((r) => setTimeout(r, 60)); // 第一次调用进行中注入
    await rt.user.send(p.pid, '这张图里是什么', { images: ['data:image/png;base64,AAA'] });
    await p.join();
    expect(calls).toBe(2);
    const imgMsg = provider.calls[1].messages.find(
      (m) => m.role === 'user' && Array.isArray(m.content),
    );
    expect(imgMsg).toBeTruthy();
    const parts = imgMsg!.content as Array<{
      type: string;
      image_url?: { url: string };
      text?: string;
    }>;
    expect(parts[0].type).toBe('image_url');
    expect(parts[0].image_url?.url).toBe('data:image/png;base64,AAA');
    expect(parts[parts.length - 1]).toEqual({ type: 'text', text: '这张图里是什么' });
  });
});
