/**
 * 演示：多 LLM provider 混合调度。
 * OpenAI 做规划（强推理），DeepSeek 做执行（高性价比），按进程独立配置。
 * 运行：在 .env 配置 OPENAI_API_KEY 和 DEEPSEEK_API_KEY 后 npx tsx examples/multi-provider.ts
 */
import { AgentRuntime, OpenAIProvider, DeepSeekProvider } from '../src/index';

const rt = new AgentRuntime({
  providers: [
    new OpenAIProvider({
      apiKey: process.env.OPENAI_API_KEY!,
      // baseUrl: 'https://api.openai.com/v1',      // OpenAI 官方
      // baseUrl: 'http://localhost:11434/v1',      // 或 Ollama / vLLM 本地
    }),
    new DeepSeekProvider({
      apiKey: process.env.DEEPSEEK_API_KEY!,
      baseUrl: process.env.DEEPSEEK_BASE_URL,
    }),
  ],
  defaults: { model: { model: 'gpt-4o', provider: 'openai' } },
  budget: { tokens: 300_000 },
  maxDepth: 3,
});

// init 用 OpenAI 做规划
const planner = rt.init({
  task: '分解任务：设计一个 Todo 应用。列出 3 个子任务交给执行者。',
  model: { model: 'gpt-4o', provider: 'openai', temperature: 0.3 },
  name: 'planner',
});

rt.user.tap(planner.pid, (c) => {
  if (c.type === 'assistant') console.log(`[planner] ${String(c.data).slice(0, 100)}`);
});

// 子进程用 DeepSeek 做执行（provider 字段切换）
const executor = planner.spawn({
  task: '实现第一个子任务：数据库 schema 设计',
  model: { model: 'deepseek-v4-pro', provider: 'deepseek', maxTokens: 1000 },
  name: 'executor',
});

rt.user.tap(executor.pid, (c) => {
  if (c.type === 'assistant') console.log(`[executor] ${String(c.data).slice(0, 100)}`);
});

await executor.join();
await planner.join();

console.log(
  '\nps():',
  rt.ps().map((s) => ({
    pid: s.pid,
    name: s.name,
    model: s.model,
    provider: s.provider,
    tokens: s.usage.totalTokens,
  })),
);
