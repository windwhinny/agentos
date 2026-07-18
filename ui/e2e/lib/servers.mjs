// e2e 用本地服务:dist 静态服务 + 假的 AgentOS live server(REST + SSE)
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { sleep } from './cdp.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** 静态托管 dist(SPA 回退到 index.html) */
export function serveStatic(root, port) {
  const server = createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    let file = join(root, p);
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

const readBody = (req) =>
  new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => resolve(d));
  });

const json = (res, body, code = 200) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

function snap({ pid, ppid = 1, name = null, state = 'done', blockedReason, model = 'deepseek-v4-pro', tokens = 100 }) {
  return {
    pid,
    ppid,
    name,
    state,
    ...(blockedReason ? { blockedReason } : {}),
    depth: pid === 1 ? 0 : 1,
    model,
    provider: 'deepseek',
    usage: { promptTokens: tokens - 10, completionTokens: 10, totalTokens: tokens },
    budgetUsed: { tokens, turns: 1 },
    turns: 1,
    children: [],
    createdAt: Date.now() - 5000,
    uptimeMs: 1200,
  };
}

/**
 * 假 live server:模拟 agentos server 的 REST + SSE 协议。
 * - emit(pid, frames):注入流式 output 帧(chunk.id 共享模拟流式)
 * - spawnRequests:记录收到的 spawn 请求体(断言前端参数透传)
 * - 任务文本含 __fail__ 时 /api/spawn 返回 500(失败注入)
 * - poisonSse():摧毁现有 SSE 连接并让 /api/events 持续 503(模拟 backend 挂掉)
 */
export async function createFakeLiveServer(port) {
  const sseClients = new Set();
  const spawnRequests = [];
  const modelRequests = []; // 模型管理端点收到的请求({method, path, body}),供断言
  let nextPid = 3;
  let ssePoisoned = false;
  let processes = [
    snap({ pid: 1, ppid: 0, name: 'init', state: 'done', tokens: 731 }),
    snap({ pid: 2, state: 'blocked', blockedReason: 'ON_LLM', tokens: 0 }),
  ];
  // 内存模型注册表(与真实 server/models.ts 同契约,密钥不下发)
  const registry = {
    defaultModel: 'deepseek-v4-pro',
    providers: [
      { name: 'deepseek', type: 'deepseek', models: ['deepseek-v4-pro', 'deepseek-v4-flash'], hasKey: true },
    ],
  };
  const modelView = () => ({ defaultModel: registry.defaultModel, providers: registry.providers });
  const outputs = {
    1: [
      { type: 'assistant', data: { text: 'AgentOS init(PID 1)就绪。' }, ts: Date.now() - 4000, id: 'p1_t1', done: true },
      { type: 'result', data: 'AgentOS init(PID 1)就绪。', ts: Date.now() - 3999 },
    ],
  };

  const send = (evt) => {
    const line = `data: ${JSON.stringify(evt)}\n\n`;
    for (const res of sseClients) res.write(line);
  };
  const emitState = () => send({ kind: 'state', ps: processes, pipes: [] });
  const emitOutput = (pid, chunk) => send({ kind: 'output', pid, chunk });

  const server = createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
    const url = new URL(req.url, 'http://x');

    if (url.pathname === '/api/state') return json(res, { ps: processes, pipes: [], outputs });

    if (url.pathname === '/api/events') {
      if (ssePoisoned) {
        // 投毒模式:模拟 backend 挂掉,SSE 持续 503(EventSource 重连也会失败)
        return json(res, { error: 'service unavailable' }, 503);
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(': ok\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/spawn') {
      const body = JSON.parse(await readBody(req));
      // 失败注入:任务文本含 __fail__ 时返回 500,用于「操作失败可见性」用例
      if (typeof body.task === 'string' && body.task.includes('__fail__')) {
        return json(res, 'Error: spawn exploded (注入的后端错误)', 500);
      }
      spawnRequests.push(body);
      const pid = nextPid++;
      processes = [
        ...processes,
        snap({ pid, ppid: Number(body.ppid), state: 'blocked', blockedReason: 'ON_LLM', model: body.model ?? 'deepseek-v4-pro', tokens: 0 }),
      ];
      json(res, { pid });
      setTimeout(emitState, 50);
      return;
    }

    // —— 模型管理端点(与真实 server 同契约)——
    if (url.pathname === '/api/models') return json(res, modelView());

    if (req.method === 'POST' && url.pathname === '/api/providers') {
      const body = JSON.parse(await readBody(req));
      modelRequests.push({ method: 'POST', path: '/api/providers', body });
      if (!body.name || !body.apiKey || !body.models) return json(res, { error: 'name / apiKey / models 均必填' }, 400);
      if (body.type !== 'openai' && body.type !== 'anthropic') return json(res, { error: 'type 仅支持 openai | anthropic' }, 400);
      if (registry.providers.some((p) => p.name === body.name)) return json(res, { error: `供应商名已存在: ${body.name}` }, 400);
      const models = String(body.models).split(',').map((s) => s.trim()).filter(Boolean);
      registry.providers.push({ name: body.name, type: body.type, ...(body.baseUrl ? { baseUrl: body.baseUrl } : {}), models, hasKey: true });
      return json(res, { ok: true, ...modelView() });
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/api/providers/')) {
      const name = decodeURIComponent(url.pathname.slice('/api/providers/'.length));
      modelRequests.push({ method: 'DELETE', path: url.pathname, body: null });
      const idx = registry.providers.findIndex((p) => p.name === name);
      if (idx < 0) return json(res, { error: `供应商不存在: ${name}` }, 404);
      const [removed] = registry.providers.splice(idx, 1);
      if (removed.models.includes(registry.defaultModel)) {
        registry.defaultModel = registry.providers[0]?.models[0] ?? '';
      }
      return json(res, { ok: true, ...modelView() });
    }

    if (req.method === 'POST' && url.pathname === '/api/default-model') {
      const body = JSON.parse(await readBody(req));
      modelRequests.push({ method: 'POST', path: '/api/default-model', body });
      const known = registry.providers.some((p) => p.models.includes(body.model));
      if (!known) return json(res, { error: `未注册的模型: ${body.model}` }, 400);
      registry.defaultModel = body.model;
      return json(res, { ok: true, ...modelView() });
    }

    if (req.method === 'POST') return json(res, { ok: true });
    res.writeHead(404);
    res.end('not found');
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  /** 测试直接调用:向 SSE 注入一组共享 id 的流式帧(模拟后台流式输出) */
  const emit = async (pid, frames, gapMs = 40) => {
    for (const f of frames) {
      emitOutput(pid, f);
      await sleep(gapMs);
    }
  };
  /** 测试直接调用:摧毁现有 SSE 连接并让后续 /api/events 返回 503(模拟 backend 挂掉) */
  const poisonSse = () => {
    ssePoisoned = true;
    for (const res of sseClients) res.destroy();
    sseClients.clear();
  };
  return { server, spawnRequests, modelRequests, emit, emitState, emitOutput, poisonSse };
}
