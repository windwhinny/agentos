import type { MockResponder } from '@/agentos/llm/mock';
import { textOf } from '@/agentos/types';

/**
 * 演示剧本（demo 模式的 Mock 大脑）：
 * init 协调者自动建「调研员」「写手」两个子进程；调研员 4 秒后产出结论，
 * 经管道流入写手，写手汇总。用户可继续 spawn / fork / attach 交互。
 */
export const demoResponder: MockResponder = (msgs) => {
  const firstUser = textOf(msgs.find((m) => m.role === 'user')?.content ?? '');
  const toolMsgs = msgs.filter((m) => m.role === 'tool');

  // —— 用户 attach 注入的消息优先响应 ——
  const last = msgs[msgs.length - 1];
  if (last?.role === 'user' && last.meta?.from === 0 && toolMsgs.length > 0) {
    return { content: `收到你的指令：「${textOf(last.content).slice(0, 50)}」，已并入当前任务继续执行。` };
  }

  // —— 协调者剧本 ——
  if (firstUser.includes('协调')) {
    if (toolMsgs.length === 0)
      return {
        thinking: '我是协调者。把任务拆成「调研」和「写作」两段，先 spawn 调研员。',
        content: '',
        toolCalls: [{ name: 'spawn_process', arguments: { task: '调研进程模型要点', name: '调研员' } }],
      };
    if (toolMsgs.length === 1)
      return {
        thinking: '调研员已就位。再 spawn 写手，等调研结论经管道流过去后让它写摘要。',
        content: '',
        toolCalls: [{ name: 'spawn_process', arguments: { task: '等待调研结论并写成摘要', name: '写手' } }],
      };
    if (toolMsgs.length === 2) {
      const pid = JSON.parse(textOf(toolMsgs[0].content)).pid;
      return { content: '', toolCalls: [{ name: 'wait_process', arguments: { pid } }] };
    }
    if (toolMsgs.length === 3) {
      const pid = JSON.parse(textOf(toolMsgs[1].content)).pid;
      return { content: '', toolCalls: [{ name: 'wait_process', arguments: { pid } }] };
    }
    return { content: '调研 → 写作流水线已完成。你可以 attach 任意进程、spawn 新进程、或发信号观察行为。' };
  }

  // —— 写手：先等管道消息 ——（必须在「调研」分支之前：写手任务文本里含“调研”二字）
  if (firstUser.includes('摘要') || firstUser.includes('写作')) {
    const piped = msgs.some((m) => m.role === 'user' && textOf(m.content).includes('调研结论'));
    if (piped)
      return {
        thinking: '调研结论已到，压缩成一句摘要。',
        content: '摘要：进程模型让 SubAgent 成为一等公民——**可管理、可通信、可配额**的完整生命周期实体。',
      };
    return { content: '', toolCalls: [{ name: 'ps', arguments: {} }], delayMs: 1500 };
  }

  // —— 调研员 ——
  if (firstUser.includes('调研')) {
    return {
      thinking: '要点收敛中：先列生命周期，再列 IPC，最后落到配额。',
      content: '调研结论：Agent 进程模型三要素 —— **生命周期管理**、**进程间通信**、**资源配额**。\n\n- 生命周期：状态机 + 信号\n- IPC：管道 / 消息\n- 配额：预算树',
      delayMs: 2500,
    };
  }

  // —— 管道消息被注入到普通进程 ——
  if (last?.meta?.kind === 'pipe') {
    return { content: `已收到上游进程消息：「${textOf(last.content).slice(0, 50)}」` };
  }

  // —— 用户手工 spawn 的默认进程 ——
  return { content: `任务完成：${firstUser.slice(0, 60)}（demo Mock 应答）`, delayMs: 1200 };
};
