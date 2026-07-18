import type { Tool } from '../types';

/** 内置工具 = 进程系统调用：每个进程默认可用 */
export function makeBuiltinTools(): Map<string, Tool> {
  const tools: Tool[] = [
    {
      name: 'spawn_process',
      description:
        'Spawn a child process (subagent) to run a task asynchronously. Returns { pid }.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'task for the child process' },
          name: { type: 'string' },
          model: { type: 'string', description: 'model id or alias for the child' },
          systemPrompt: { type: 'string' },
        },
        required: ['task'],
      },
      execute: (args, ctx) => {
        const child = ctx.runtime.spawn(ctx.pid, {
          task: String(args.task),
          name: args.name !== undefined ? String(args.name) : undefined,
          systemPrompt: args.systemPrompt !== undefined ? String(args.systemPrompt) : undefined,
          model: args.model !== undefined ? { model: String(args.model) } : undefined,
        });
        return { pid: child.pid };
      },
    },
    {
      name: 'wait_process',
      description: 'Block until a process exits and return its ExitResult.',
      parameters: {
        type: 'object',
        properties: {
          pid: { type: 'number' },
          timeoutMs: { type: 'number' },
        },
        required: ['pid'],
      },
      execute: async (args, ctx) => {
        const target = ctx.runtime.getRequired(Number(args.pid));
        const self = ctx.process;
        const prevState = self.state;
        const prevReason = self.blockedReason;
        if (!self.isExited) {
          self.state = 'blocked';
          self.blockedReason = 'ON_CHILD';
        }
        try {
          return await target.join({
            timeoutMs: args.timeoutMs !== undefined ? Number(args.timeoutMs) : undefined,
          });
        } finally {
          if (self.state === 'blocked' && self.blockedReason === 'ON_CHILD') {
            self.state = prevState;
            self.blockedReason = prevReason;
          }
        }
      },
    },
    {
      name: 'ps',
      description: 'List the process table.',
      parameters: { type: 'object', properties: {} },
      execute: (_args, ctx) => ctx.runtime.ps(),
    },
    {
      name: 'send_message',
      description: 'Send a text message to another process stdin.',
      parameters: {
        type: 'object',
        properties: {
          pid: { type: 'number' },
          text: { type: 'string' },
        },
        required: ['pid', 'text'],
      },
      execute: async (args, ctx) => {
        const target = ctx.runtime.getRequired(Number(args.pid));
        // 已退出(done/failed/killed)不等于死了:revive 保留上下文续聊,与用户 send 语义一致。
        // 修复前:直接写已关闭的 stdin → EPIPE,消息丢失,调用方只收到工具错误
        const revived = target.isExited;
        if (revived) target.revive();
        await target.stdin.write({
          from: ctx.pid,
          to: target.pid,
          kind: 'pipe',
          payload: String(args.text),
          ts: Date.now(),
        });
        target.start(); // 已 start/存活时是 no-op
        return { delivered: true, revived };
      },
    },
    {
      name: 'fork_process',
      description: 'Fork current process context into a sibling branch. Returns { pid }.',
      parameters: {
        type: 'object',
        properties: { hint: { type: 'string' } },
      },
      execute: (args, ctx) => ({
        pid: ctx.runtime.fork(ctx.pid, args.hint !== undefined ? String(args.hint) : undefined).pid,
      }),
    },
    {
      name: 'read_pipe',
      description: 'Drain pending pipe messages (for pipe mode=tool).',
      parameters: { type: 'object', properties: {} },
      execute: (_args, ctx) =>
        ctx.process.pipeInbox.drain().map((m) => ({ from: m.from, payload: m.payload })),
    },
  ];
  return new Map(tools.map((t) => [t.name, t]));
}
