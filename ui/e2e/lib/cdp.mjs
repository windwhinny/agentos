// 零依赖 CDP 驱动:启动系统 Chrome(headless)+ 通过 DevTools Protocol 控制页面
// 依赖 Node.js >= 22(内置 WebSocket / fetch)
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  for (const p of candidates) if (existsSync(p)) return p;
  throw new Error('找不到 Chrome/Chromium,请设置 CHROME_PATH 环境变量指向浏览器可执行文件');
}

/** 启动 headless Chrome 并返回 { proc, client, profile } */
export async function launchChrome() {
  if (typeof WebSocket === 'undefined')
    throw new Error('e2e 需要 Node.js >= 22(依赖内置 WebSocket)');
  const profile = mkdtempSync(join(tmpdir(), 'agentos-e2e-chrome-'));
  const proc = spawn(
    findChrome(),
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--window-size=1440,900',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const portFile = join(profile, 'DevToolsActivePort');
  let wsUrl;
  for (let i = 0; i < 150; i++) {
    if (existsSync(portFile)) {
      const [port, p] = readFileSync(portFile, 'utf8').split('\n');
      if (port && p) {
        wsUrl = `ws://127.0.0.1:${port.trim()}${p.trim()}`;
        break;
      }
    }
    await sleep(100);
  }
  if (!wsUrl) {
    proc.kill();
    throw new Error('Chrome DevToolsActivePort 未出现,Chrome 启动失败');
  }
  const client = await CdpClient.connect(wsUrl);
  return { proc, client, profile };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class CdpClient {
  static connect(wsUrl) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.onopen = () => resolve(new CdpClient(ws));
      ws.onerror = () => reject(new Error('CDP WebSocket 连接失败: ' + wsUrl));
    });
  }

  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.eventHandlers = new Set();
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result ?? {});
      } else if (msg.method) {
        for (const h of this.eventHandlers) h(msg);
      }
    };
  }

  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }

  onEvent(h) {
    this.eventHandlers.add(h);
    return () => this.eventHandlers.delete(h);
  }

  async newPage(url) {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new CdpPage(this, sessionId, targetId);
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    if (url) await page.send('Page.navigate', { url });
    return page;
  }
}

export class CdpPage {
  constructor(client, sessionId, targetId) {
    this.client = client;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.consoleErrors = [];
    client.onEvent((msg) => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        this.consoleErrors.push(`exception: ${d.text} ${d.exception?.description ?? ''}`.slice(0, 500));
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
        // favicon 404 之类的资源错误不算 JS 错误,这里只收集 console.error
        this.consoleErrors.push(`console.error: ${text}`.slice(0, 500));
      } else if (msg.method === 'Page.javascriptDialogOpening') {
        // fork 提示语等 window.prompt:自动接受,避免阻塞页面
        this.send('Page.handleJavaScriptDialog', { accept: true, promptText: 'e2e分支提示' }).catch(() => {});
      }
    });
  }

  send(method, params) {
    return this.client.send(method, params, this.sessionId);
  }

  /** 在页面上下文执行 JS(returnByValue),页面抛错则拒绝 */
  async evalJs(code) {
    const r = await this.send('Runtime.evaluate', { expression: code, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails)
      throw new Error('页面内执行出错: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).slice(0, 400));
    return r.result?.value;
  }

  /** 轮询直到表达式返回真值 */
  async waitFor(code, { timeoutMs = 20000, intervalMs = 150, label } = {}) {
    const t0 = Date.now();
    for (;;) {
      const v = await this.evalJs(code);
      if (v) return v;
      if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor 超时(${timeoutMs}ms): ${label ?? code.slice(0, 100)}`);
      await sleep(intervalMs);
    }
  }

  async screenshot(path) {
    mkdirSync(join(path, '..'), { recursive: true });
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path, Buffer.from(r.data, 'base64'));
  }

  async close() {
    await this.client.send('Target.closeTarget', { targetId: this.targetId }).catch(() => {});
  }
}
