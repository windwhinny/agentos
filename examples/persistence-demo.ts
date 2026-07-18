/**
 * 演示：session 持久化 + 跨 runtime resume。
 * 用 MockLLMProvider 自包含运行，无需 API Key。
 * 运行：npx tsx examples/persistence-demo.ts
 */
import { AgentRuntime, MockLLMProvider, SessionStore } from '../src/index';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dbPath = join(tmpdir(), 'agentos-demo.db');

// -- 第一幕：runtime1 运行并持久化 --
const store1 = new SessionStore(dbPath);
const rt1 = new AgentRuntime({
  providers: [
    new MockLLMProvider((msgs) => {
      const task = msgs.find((m) => m.role === 'user')?.content ?? '';
      if (task === 'parent') return { content: '调研完成：进程模型很适合 Agent 编排' };
      return { content: '子任务完成：spawn/join 已验证' };
    }),
  ],
  defaults: { model: { model: 'mock-model' } },
  store: store1,
});

const sid = rt1.attachPersistence({ title: '持久化演示' });
console.log('sessionId:', sid);

const init = rt1.init({ task: 'parent' });
const child = init.spawn({ task: 'child', name: '调研员' });
await Promise.all([init.join(), child.join()]);

console.log(
  'runtime1 ps():',
  rt1.ps().map((s) => ({ pid: s.pid, name: s.name, state: s.state })),
);
console.log('落盘统计:', store1.stats(sid));
store1.close();
console.log('--- runtime1 关闭，store 已落盘 ---\n');

// -- 第二幕：runtime2 从同一 db 恢复 --
const store2 = new SessionStore(dbPath);
const rt2 = new AgentRuntime({
  providers: [new MockLLMProvider(() => ({ content: 'resumed' }))],
  defaults: { model: { model: 'mock-model' } },
  store: store2,
});

rt2.resume(sid);
console.log(
  'runtime2 恢复后 ps():',
  rt2.ps().map((s) => ({ pid: s.pid, state: s.state })),
);

const restored = rt2.get(1)!;
console.log(
  'pid 1 上下文:',
  restored.context.messages.map((m) => `${m.role}: ${m.content}`),
);
console.log(
  'pid 1 输出流:',
  store2
    .getOutput(sid, 1)
    .filter((c) => c.type === 'result' || (c as { done?: boolean }).done)
    .map((c) => {
      if (c.type === 'result') return `${c.type}: ${c.data}`;
      const d = c.data as { text?: string };
      return `${c.type}: ${d.text ?? ''}`;
    }),
);

// 恢复后继续 spawn 新进程，新进程自动落盘
const next = restored.spawn({ task: 'follow-up' });
await next.join();
console.log(
  '恢复后新进程:',
  store2.snapshot(sid)!.processes.map((p) => p.pid),
);
store2.close();
