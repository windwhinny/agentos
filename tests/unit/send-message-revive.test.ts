import { describe, it, expect } from 'vitest';
import { AgentRuntime } from '../../src/core/runtime';
import { MockLLMProvider } from '../../src/llm/mock';
import { textOf } from '../../src/types';
import type { ChatMessage } from '../../src/types';

/**
 * 回归:send_message 到已退出(done)进程应 revive 续聊,而不是 EPIPE。
 * 修复前:目标 stdin 已关闭,写入抛 EPIPE,调用方收到 `Error: EPIPE: pipe closed`,消息丢失。
 * 修复后:revive 保留上下文重开 stdin,投递成功并 start,目标被唤醒继续对话。
 */
describe('send_message 到已退出进程', () => {
  function build() {
    // 协调者剧本:spawn worker → wait 它退出 → send_message 唤醒它 → 汇报
    const coordinator = (msgs: ChatMessage[]) => {
      const toolMsgs = msgs.filter((m) => m.role === 'tool');
      if (toolMsgs.length === 0)
        return { toolCalls: [{ name: 'spawn_process', arguments: { task: 'worker-task', name: 'worker' } }] };
      if (toolMsgs.length === 1) {
        const pid = JSON.parse(textOf(toolMsgs[0].content)).pid;
        return { toolCalls: [{ name: 'wait_process', arguments: { pid } }] };
      }
      if (toolMsgs.length === 2) {
        const pid = JSON.parse(textOf(toolMsgs[0].content)).pid;
        return { toolCalls: [{ name: 'send_message', arguments: { pid, text: '醒醒,还有活' } }] };
      }
      return { content: '协调完成' };
    };
    // worker 剧本:首轮直接完工;被管道消息唤醒后应答
    const worker = (msgs: ChatMessage[]) => {
      const last = msgs[msgs.length - 1];
      if (last?.role === 'user' && last.meta?.kind === 'pipe')
        return { content: `worker 收到:${textOf(last.content)}` };
      return { content: 'worker 首轮完成' };
    };
    const runtime = new AgentRuntime({
      providers: [
        new MockLLMProvider((msgs) => {
          const firstUser = textOf(msgs.find((m) => m.role === 'user')?.content ?? '');
          return firstUser === 'worker-task' ? worker(msgs) : coordinator(msgs);
        }),
      ],
      defaults: { model: { model: 'm1' } },
    });
    return runtime;
  }

  it('目标 done 后 send_message 投递成功并唤醒它续聊', async () => {
    const runtime = build();
    const coord = runtime.init({ task: '协调任务' });
    await coord.join();

    const workerProc = runtime.ps().find((s) => s.name === 'worker');
    expect(workerProc).toBeDefined();
    const worker = runtime.getRequired(workerProc!.pid);

    // 等 worker 被唤醒后的第二轮也跑完(revive 重置了 exitDeferred,join 等的是新一轮退出)
    await worker.join();

    // 1. 消息真的送达:worker 上下文里有这条 kind=pipe 的用户消息
    const delivered = worker.context.messages.find(
      (m) => m.role === 'user' && m.meta?.kind === 'pipe' && textOf(m.content) === '醒醒,还有活',
    );
    expect(delivered).toBeDefined();

    // 2. 上下文保留:revive 后原任务仍在(worker 不是被重置成新进程)
    expect(textOf(worker.context.messages.find((m) => m.role === 'user')!.content)).toBe('worker-task');

    // 3. worker 被唤醒后真的续聊了:stdout 有两轮回答
    const answers = worker.stdout
      .read()
      .filter((c) => c.type === 'assistant')
      .map((c) => JSON.stringify(c.data));
    expect(answers.some((t) => t.includes('worker 首轮完成'))).toBe(true);
    expect(answers.some((t) => t.includes('worker 收到:醒醒,还有活'))).toBe(true);

    // 4. 调用方看到的是成功而不是 EPIPE
    const sendResult = coord.context.messages.find((m) => m.role === 'tool' && m.name === 'send_message');
    expect(sendResult).toBeDefined();
    expect(textOf(sendResult!.content)).not.toMatch(/^Error/);
    const parsed = JSON.parse(textOf(sendResult!.content));
    expect(parsed).toMatchObject({ delivered: true, revived: true });
  });

  it('目标存活时行为不变(revived=false)', async () => {
    const runtime = new AgentRuntime({
      providers: [
        new MockLLMProvider((msgs) => {
          const firstUser = textOf(msgs.find((m) => m.role === 'user')?.content ?? '');
          if (firstUser === 'idle-worker') {
            const last = msgs[msgs.length - 1];
            if (last?.role === 'user' && last.meta?.kind === 'pipe') return { content: '存活收到' };
            // 首轮故意慢 500ms:协调者的 send_message 必在它生成期间到达(进程存活)
            return { content: 'idle 完成', delayMs: 500 };
          }
          const toolMsgs = msgs.filter((m) => m.role === 'tool');
          if (toolMsgs.length === 0)
            return { toolCalls: [{ name: 'spawn_process', arguments: { task: 'idle-worker', name: 'idle' } }] };
          if (toolMsgs.length === 1) {
            const pid = JSON.parse(textOf(toolMsgs[0].content)).pid;
            return { toolCalls: [{ name: 'send_message', arguments: { pid, text: '在吗' } }] };
          }
          return { content: '协调完成' };
        }),
      ],
      defaults: { model: { model: 'm1' } },
    });
    const coord = runtime.init({ task: '协调任务2' });
    await coord.join();
    const sendResult = coord.context.messages.find((m) => m.role === 'tool' && m.name === 'send_message');
    const parsed = JSON.parse(textOf(sendResult!.content));
    expect(parsed).toMatchObject({ delivered: true, revived: false });
  });
});
