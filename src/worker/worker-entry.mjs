// worker 内的自包含 mini-runtime（纯 JS ESM，不依赖 TS 源码）
import { parentPort, workerData } from 'node:worker_threads';

const cfg = workerData;
const messages = [];
if (cfg.systemPrompt) messages.push({ role: 'system', content: cfg.systemPrompt });
messages.push({ role: 'user', content: cfg.task });

const inbox = [];
let killed = false;
parentPort.on('message', (m) => {
  if (m.type === 'stdin') inbox.push(m.msg);
  if (m.type === 'signal' && m.sig === 'SIGKILL') killed = true;
});

// —— provider ——
let chat;
if (cfg.worker.provider === 'mock') {
  const script = [...(cfg.worker.script ?? [])];
  chat = async () => {
    const step = script.shift();
    if (!step) throw new Error('mock script exhausted');
    if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
    if (step.error) throw new Error(step.error.message ?? 'mock error');
    const tool_calls = (step.toolCalls ?? []).map((tc, i) => ({
      id: `wcall_${i}`,
      name: tc.name,
      arguments: JSON.stringify(tc.arguments ?? {}),
    }));
    return {
      message: { content: step.content ?? '', tool_calls },
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    };
  };
} else {
  // deepseek（OpenAI 兼容）
  chat = async (req) => {
    const res = await fetch(
      `${cfg.worker.baseUrl ?? 'https://api.deepseek.com'}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.worker.apiKey ?? process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: cfg.model.model,
          messages: req.messages,
          ...(req.tools?.length
            ? {
                tools: req.tools.map((t) => ({
                  type: 'function',
                  function: { name: t.name, description: t.description, parameters: t.parameters },
                })),
              }
            : {}),
          ...(cfg.model.temperature !== undefined ? { temperature: cfg.model.temperature } : {}),
          ...(cfg.model.maxTokens !== undefined ? { max_tokens: cfg.model.maxTokens } : {}),
        }),
      },
    );
    if (!res.ok) throw new Error(`DeepSeek API ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const msg = data.choices?.[0]?.message ?? {};
    return {
      message: {
        content: msg.content ?? '',
        tool_calls: msg.tool_calls?.map((tc) => ({
          id: tc.id,
          name: tc.function?.name ?? '',
          arguments: tc.function?.arguments ?? '{}',
        })),
      },
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        totalTokens: data.usage?.total_tokens ?? 0,
      },
    };
  };
}

// —— tools ——
const toolMap = new Map();
if (cfg.toolModule) {
  const mod = await import(cfg.toolModule);
  for (const t of mod.tools ?? []) toolMap.set(t.name, t);
}

const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
let turns = 0;
let lastOutput = '';

try {
  while (true) {
    if (killed) throw Object.assign(new Error('killed'), { code: 'SIGKILL' });
    while (inbox.length) messages.push({ role: 'user', content: inbox.shift().payload });
    const res = await chat({ messages, tools: toolMap.size ? [...toolMap.values()] : undefined });
    usage.promptTokens += res.usage.promptTokens;
    usage.completionTokens += res.usage.completionTokens;
    usage.totalTokens += res.usage.totalTokens;
    turns++;
    if (cfg.budget?.tokens && usage.totalTokens > cfg.budget.tokens) {
      throw Object.assign(new Error('token budget exceeded in worker'), {
        code: 'BUDGET_EXCEEDED',
      });
    }
    const msg = {
      role: 'assistant',
      content: res.message.content ?? '',
      ...(res.message.tool_calls?.length ? { tool_calls: res.message.tool_calls } : {}),
    };
    messages.push(msg);
    if (msg.content) {
      parentPort.postMessage({
        type: 'stdout',
        chunk: { type: 'assistant', data: msg.content, ts: Date.now() },
      });
      lastOutput = msg.content;
    }
    if (!msg.tool_calls?.length) break;
    for (const call of msg.tool_calls) {
      const tool = toolMap.get(call.name);
      let out;
      try {
        let args = {};
        try {
          args = JSON.parse(call.arguments || '{}');
        } catch {
          args = {};
        }
        out = tool ? await tool.execute(args, {}) : `Error: tool '${call.name}' not found`;
      } catch (e) {
        out = `Error: ${e.message}`;
      }
      const outStr = typeof out === 'string' ? out : JSON.stringify(out);
      messages.push({ role: 'tool', content: outStr, tool_call_id: call.id, name: call.name });
      parentPort.postMessage({
        type: 'stdout',
        chunk: { type: 'tool', data: { name: call.name, output: outStr }, ts: Date.now() },
      });
    }
  }
  parentPort.postMessage({
    type: 'exit',
    result: { status: 'done', reason: 'DONE', exitCode: 0, output: lastOutput, usage, turns },
  });
} catch (e) {
  const isKill = e.code === 'SIGKILL' || killed;
  const isBudget = e.code === 'BUDGET_EXCEEDED';
  parentPort.postMessage({
    type: 'exit',
    result: {
      status: isKill || isBudget ? 'killed' : 'failed',
      reason: isKill ? 'SIGKILL' : isBudget ? 'BUDGET_EXCEEDED' : 'ERROR',
      exitCode: isKill ? 137 : isBudget ? 125 : 1,
      output: lastOutput,
      error: e.message,
      usage,
      turns,
    },
  });
}
