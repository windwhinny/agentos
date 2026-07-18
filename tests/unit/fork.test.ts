import { describe, it, expect } from 'vitest';
import { AgentRuntime } from '../../src/core/runtime';
import { MockLLMProvider } from '../../src/llm/mock';

function rt() {
  return new AgentRuntime({
    providers: [new MockLLMProvider(() => ({ content: 'x' }))],
    defaults: { model: { model: 'm1' } },
  });
}

describe('fork（COW）', () => {
  it('分叉共享上下文，双向写互不影响', async () => {
    const runtime = rt();
    const init = runtime.init({ task: 'base' });
    await init.join();
    const baseLen = init.context.messages.length;

    const branch = runtime.fork(init.pid, 'explore A');
    // fork 立即共享（hint 触发 branch 的 COW slice，init 不变）
    expect(init.context.messages.length).toBe(baseLen);
    expect(branch.context.messages.length).toBe(baseLen + 1);
    expect(branch.ppid).toBe(init.ppid);

    // init 追加 → branch 不受影响
    init.appendMessage({ role: 'user', content: 'init-only' });
    expect(branch.context.messages.length).toBe(baseLen + 1);
    // branch 追加 → init 不受影响
    branch.appendMessage({ role: 'user', content: 'branch-only' });
    expect(init.context.messages.length).toBe(baseLen + 1);
    await branch.join();
  });

  it('两次 fork 各自独立', async () => {
    const runtime = rt();
    const init = runtime.init({ task: 'base' });
    await init.join();
    const a = runtime.fork(init.pid, 'A');
    const b = runtime.fork(init.pid, 'B');
    a.appendMessage({ role: 'user', content: 'a-msg' });
    expect(b.context.messages.some((m) => m.content === 'a-msg')).toBe(false);
    expect(init.context.messages.some((m) => m.content === 'a-msg')).toBe(false);
    await Promise.all([a.join(), b.join()]);
  });
});
