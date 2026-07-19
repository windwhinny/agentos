/**
 * AgentOS live server —— 前端控制台的真实模型后端。
 *
 *   OPENAI_API_KEY=sk-... npm run server        （默认 :8787）
 *
 * 协议（与 UI 的 RemoteDriver 对齐）：
 *   GET  /api/state   → { ps, pipes, outputs }   全量快照（含各进程 stdout 历史）
 *   GET  /api/events  → SSE：{kind:'state',ps,pipes} | {kind:'output',pid,chunk}
 *   POST /api/spawn   { ppid, task, name?, model?, budgetTokens? } → { pid }
 *   POST /api/fork    { pid, hint? } → { pid }
 *   POST /api/signal  { pid, sig } → { ok }
 *   POST /api/send    { pid, text } → { ok }
 *   POST /api/pipe    { fromPid, toPid, mode? } → { ok }
 *
 * 模型管理（注册表持久化于 server/models.json，含密钥，勿提交）：
 *   GET    /api/models           → { providers(脱敏), defaultModel }
 *   POST   /api/providers        { name, type:'openai'|'anthropic', apiKey, baseUrl?, models:"a,b" }
 *   DELETE /api/providers/:name
 *   POST   /api/default-model    { model }
 */
import http from 'node:http';
import { AgentRuntime } from '../src/core/runtime';
import type { OutputChunk } from '../src/types';
import {
  buildProvider,
  loadRegistry,
  saveRegistry,
  toView,
  type ModelRegistry,
} from './models';

const PORT = Number(process.env.PORT ?? 8787);
const registry: ModelRegistry = loadRegistry();

const providers = registry.providers.map(buildProvider);
const rt = new AgentRuntime({
  providers,
  defaults: { model: { model: registry.defaultModel } },
  budget: { tokens: 1_000_000 },
  maxDepth: 4,
});
// 绑定各供应商的模型清单（resolveModel 按模型选供应商）
providers.forEach((p, i) => rt.registerProvider(p, { models: registry.providers[i].models }));

// —— SSE 广播 ——
const clients = new Set<http.ServerResponse>();
function broadcast(evt: unknown): void {
  const line = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of clients) res.write(line);
}
function stateEvent() {
  return { kind: 'state', ps: rt.ps(), pipes: rt.pipeline() };
}

// —— 输出转发：每个进程创建时 tap 其 stdout ——
const tapped = new Set<number>();
function tapProcess(pid: number): void {
  if (tapped.has(pid)) return;
  tapped.add(pid);
  rt.getRequired(pid).stdout.tap((chunk: OutputChunk) => {
    broadcast({ kind: 'output', pid, chunk });
  });
}
rt.on('process:created', (snap: { pid: number }) => {
  tapProcess(snap.pid);
  broadcast(stateEvent());
});
rt.on('process:state', () => broadcast(stateEvent()));
rt.on('process:exit', () => broadcast(stateEvent()));

// —— init（PID 1）：协调者 ——
const initProc = rt.init({
  task:
    '你是 AgentOS 的 init 协调进程（PID 1）。用户会通过控制台交付任务。' +
    '你可以用 spawn_process 派生子进程并行工作、wait_process 等待结果、ps 查看进程表、send_message 与其他进程通信。' +
    '简明回答；需要并行或隔离的子任务就 spawn。',
  name: 'init',
});
tapProcess(initProc.pid);

// —— HTTP ——
function cors(res: http.ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => {
      try {
        resolve(buf ? JSON.parse(buf) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}
function json(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  const url = new URL(req.url ?? '/', 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/api/state') {
      const outputs: Record<number, OutputChunk[]> = {};
      for (const s of rt.ps()) outputs[s.pid] = rt.getRequired(s.pid).stdout.read();
      return json(res, 200, { ps: rt.ps(), pipes: rt.pipeline(), outputs });
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify(stateEvent())}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 30_000);
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/spawn') {
      const b = await readBody(req);
      const proc = rt.spawn(Number(b.ppid), {
        task: String(b.task ?? ''),
        name: b.name ? String(b.name) : undefined,
        model: b.model ? { model: String(b.model) } : undefined,
        budget: b.budgetTokens ? { tokens: Number(b.budgetTokens) } : undefined,
      });
      return json(res, 200, { pid: proc.pid });
    }
    if (req.method === 'POST' && url.pathname === '/api/fork') {
      const b = await readBody(req);
      const child = rt.fork(Number(b.pid), b.hint ? String(b.hint) : undefined);
      return json(res, 200, { pid: child.pid });
    }
    if (req.method === 'POST' && url.pathname === '/api/signal') {
      const b = await readBody(req);
      rt.signal(Number(b.pid), String(b.sig));
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/send') {
      const b = await readBody(req);
      const pid = Number(b.pid);
      const proc = rt.getRequired(pid);
      // 进程已退出：revive 保留上下文续聊（重开 stdin），注入消息后 start
      if (proc.isExited) proc.revive();
      await rt.user.send(pid, String(b.text ?? ''), {
        images: Array.isArray(b.images) ? (b.images as unknown[]).map(String) : undefined,
      });
      if (!proc.started) proc.start();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/interrupt') {
      const b = await readBody(req);
      rt.getRequired(Number(b.pid)).interrupt();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/pipe') {
      const b = await readBody(req);
      rt.pipe(
        Number(b.fromPid),
        Number(b.toPid),
        b.mode ? { mode: b.mode as 'stream' | 'batch' | 'tool' } : undefined,
      );
      broadcast(stateEvent());
      return json(res, 200, { ok: true });
    }
    // —— 模型管理（密钥不下发，toView 已脱敏）——
    if (req.method === 'GET' && url.pathname === '/api/models') {
      return json(res, 200, toView(registry));
    }
    if (req.method === 'POST' && url.pathname === '/api/providers') {
      const b = await readBody(req);
      const name = String(b.name ?? '').trim();
      const type = String(b.type ?? '');
      const apiKey = String(b.apiKey ?? '').trim();
      const models = String(b.models ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (!name || !apiKey || models.length === 0)
        return json(res, 400, { error: 'name / apiKey / models 均必填' });
      if (type !== 'openai' && type !== 'anthropic')
        return json(res, 400, { error: 'type 仅支持 openai | anthropic' });
      if (registry.providers.some((p) => p.name === name))
        return json(res, 400, { error: `供应商名已存在: ${name}` });
      const entry = {
        name,
        type,
        apiKey,
        models,
        ...(b.baseUrl ? { baseUrl: String(b.baseUrl) } : {}),
      };
      registry.providers.push(entry);
      rt.registerProvider(buildProvider(entry), { models });
      // 首个供应商自动接管默认模型
      if (!registry.defaultModel) registry.defaultModel = models[0];
      saveRegistry(registry);
      return json(res, 200, { ok: true, ...toView(registry) });
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/providers/')) {
      const name = decodeURIComponent(url.pathname.slice('/api/providers/'.length));
      const idx = registry.providers.findIndex((p) => p.name === name);
      if (idx < 0) return json(res, 404, { error: `供应商不存在: ${name}` });
      const [removed] = registry.providers.splice(idx, 1);
      rt.removeProvider(name);
      // 默认模型随供应商消失则回退到剩余第一个模型
      if (removed.models.includes(registry.defaultModel)) {
        registry.defaultModel = registry.providers[0]?.models[0] ?? '';
        if (registry.defaultModel) rt.setDefaultModel(registry.defaultModel);
      }
      saveRegistry(registry);
      return json(res, 200, { ok: true, ...toView(registry) });
    }
    if (req.method === 'POST' && url.pathname === '/api/default-model') {
      const b = await readBody(req);
      const model = String(b.model ?? '').trim();
      const known = registry.providers.some((p) => p.models.includes(model));
      if (!known) return json(res, 400, { error: `未注册的模型: ${model}` });
      registry.defaultModel = model;
      rt.setDefaultModel(model);
      saveRegistry(registry);
      return json(res, 200, { ok: true, ...toView(registry) });
    }
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('AgentOS live server OK. 前端控制台加 ?server=http://localhost:' + PORT + ' 连接。');
      return;
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end((e as Error).message);
  }
});

server.listen(PORT, () => {
  console.log(
    `[agentos-server] listening on :${PORT}（init = PID ${initProc.pid}，默认模型 ${registry.defaultModel}，供应商 ${registry.providers.length} 个）`,
  );
});
