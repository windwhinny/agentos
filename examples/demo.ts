/**
 * 演示：pro 父进程 + 两个 flash 子进程并发调研，管道汇总，fork 分支评审。
 * 运行：OPENAI_API_KEY 在 .env 中；npx tsx examples/demo.ts（或编入测试运行）
 */
import { AgentRuntime, DeepSeekProvider } from '../src/index';

const rt = new AgentRuntime({
  providers: [new DeepSeekProvider({ apiKey: process.env.OPENAI_API_KEY! })],
  defaults: { model: { model: 'deepseek-v4-pro' } },
  models: { pro: 'deepseek-v4-pro', flash: 'deepseek-v4-flash' },
  budget: { tokens: 200_000 },
});

const init = rt.init({
  task: '主题：多 Agent 系统的进程模型。协调两个子进程分别调研“调度”与“通信”，最后汇总。',
});

rt.user.tap(init.pid, (c) => console.log(`[stdout:${c.type}]`, String(c.data).slice(0, 120)));

const a = init.spawn({
  task: '用 3 点概括“多 Agent 调度”的设计要点',
  model: { model: 'flash', maxTokens: 500 },
  name: '调度员',
});
const b = init.spawn({
  task: '用 3 点概括“Agent 间通信”的设计要点',
  model: { model: 'flash', maxTokens: 500 },
  name: '通信员',
});

const [ra, rb] = await Promise.all([a.join(), b.join()]);
console.log('\n—— 调度员 ——\n', ra.output);
console.log('\n—— 通信员 ——\n', rb.output);
console.log(
  '\nps():',
  rt.ps().map((s) => ({ pid: s.pid, name: s.name, state: s.state, tokens: s.usage.totalTokens })),
);
await init.join();
