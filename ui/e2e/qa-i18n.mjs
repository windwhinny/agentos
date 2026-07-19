// 可视化 QA:中英文界面(真实后端 + 真实 Chrome headless)
// 同时产出 README 用界面截图 → docs/images/console.png(中文 UI)/ console-en.png(英文 UI)
// 场景展示 Agent 间通信:researcher 产出结论 → pipe → writer 收信并汇总(对话内容全英文)
// 用法: node e2e/qa-i18n.mjs   (需 repo 根 .env 有 OPENAI_API_KEY;自动起 :8787 真后端)
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, sleep } from './lib/cdp.mjs';
import { serveStatic } from './lib/servers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(ROOT, '..');
const OUT = join(ROOT, 'e2e', 'artifacts', 'qa-i18n');
const DOCS_IMG = join(REPO, 'docs', 'images');
mkdirSync(OUT, { recursive: true });
mkdirSync(DOCS_IMG, { recursive: true });

function loadKey() {
  const env = readFileSync(join(REPO, '.env'), 'utf8');
  return env.match(/OPENAI_API_KEY\s*=\s*(\S+)/)?.[1] ?? null;
}

async function startRealServer(apiKey) {
  const proc = spawn('npm', ['run', 'server'], {
    cwd: REPO,
    env: { ...process.env, OPENAI_API_KEY: apiKey, PORT: '8787' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch('http://localhost:8787/');
      if (r.ok) return proc;
    } catch {}
    await sleep(200);
  }
  proc.kill();
  throw new Error('真实后端 20s 内未就绪');
}

const clickBtn = (text) =>
  `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b)return false;b.click();return true})()`;
const clickRow = (text) =>
  `(()=>{const r=[...document.querySelectorAll('tbody tr')].find(r=>r.textContent.includes(${JSON.stringify(text)}));if(!r)return false;r.click();return true})()`;
const fillInput = (text) =>
  `(()=>{const el=document.querySelector('form input:not([type=file])');if(!el)return false;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(text)});el.dispatchEvent(new Event('input',{bubbles:true}));return true})()`;
const fillDialog = (selector, text) =>
  `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(text)});el.dispatchEvent(new Event('input',{bubbles:true}));return true})()`;
const clickTestId = (id) =>
  `(()=>{const b=document.querySelector('[data-testid=${id}]');if(!b)return false;b.click();return true})()`;
// 生成中指示只跟随当前选中进程的终端
const waitIdle = (page, label) =>
  page.waitFor(`!document.body.textContent.includes('生成中')`, { timeoutMs: 90000, label });

async function main() {
  const apiKey = loadKey();
  if (!apiKey) throw new Error('.env 缺 OPENAI_API_KEY');
  const srv = await startRealServer(apiKey);
  const staticSrv = await serveStatic(join(ROOT, 'dist'), 7200);
  const { proc, client } = await launchChrome();
  const errors = [];
  try {
    const page = await client.newPage('http://127.0.0.1:7200/?server=http://localhost:8787');
    const shot = async (name) => {
      const file = join(OUT, `${name}.png`);
      await page.screenshot(file);
      const errs = page.consoleErrors.splice(0);
      if (errs.length) errors.push({ name, errs });
      console.log(`📸 ${name}${errs.length ? ' ⚠ ' + errs.join('|').slice(0, 200) : ''}`);
      return file;
    };
    const spawnChild = async (name, task) => {
      await page.evalJs(clickBtn('＋子进程'));
      await sleep(400);
      await page.evalJs(fillDialog('[data-testid=spawn-dialog] textarea', task));
      await page.evalJs(fillDialog('[data-testid=spawn-dialog] input', name));
      await page.evalJs(clickTestId('spawn-submit'));
      await sleep(600); // 自动 attach 到新进程
    };

    await page.waitFor(`document.querySelectorAll('tbody tr').length >= 1`, { label: '进程表出现' });
    await sleep(1000);
    await page.evalJs(clickRow('★ 1'));

    // —— researcher:产出三点结论 ——
    await spawnChild(
      'researcher',
      'You are a researcher. List exactly 3 design pillars of an OS-style agent runtime — lifecycle, inter-process communication, and resource budget. One short line each.',
    );
    await waitIdle(page, 'researcher 完成');
    await sleep(800);

    // —— writer:首条回复故意拉长,留出中断窗口 ——
    await page.evalJs(clickRow('★ 1'));
    await spawnChild(
      'writer',
      `You are a writer. Your job: when a research conclusion arrives as a message from another agent, quote it verbatim under a 'Received:' heading, then distill it into a one-sentence 'Summary:'. For now, just describe in 5-6 sentences what kind of conclusions you can summarize.`,
    );
    await sleep(2500); // 等 writer 进入流式生成中段
    await page.evalJs(clickTestId('terminal-interrupt')); // EINTR:保留部分输出,转 ON_INBOX 待命
    await waitIdle(page, 'writer 中断完成');
    await sleep(500);

    // —— 建管道 researcher → writer(拓扑面板可见) ——
    await page.evalJs(clickRow('├ 2'));
    await sleep(300);
    await page.evalJs(clickBtn('pipe→'));
    await sleep(300);
    await page.evalJs(clickRow('├ 3'));
    await sleep(500);

    // —— 让 researcher 重述结论:最终帧经管道流入 writer 的 stdin ——
    await page.evalJs(clickRow('├ 2'));
    await sleep(300);
    await page.evalJs(fillInput('Please restate your 3 pillars.'));
    await page.evalJs(clickBtn('发送'));
    await sleep(1500);
    await waitIdle(page, 'researcher 重述完成');

    // —— writer 被管道消息唤醒,引用收信并汇总 ——
    await page.evalJs(clickRow('├ 3'));
    await sleep(500);
    await page
      .waitFor(`document.body.textContent.includes('Summary')`, { timeoutMs: 90000, label: 'writer 汇总出现' })
      .catch(() => console.log('  ⚠ writer 未产出 Summary,截图可能缺少收信响应'));
    await waitIdle(page, 'writer 汇总完成').catch(() => {});
    await sleep(1200);

    const zh = await shot('01-中文界面');

    // 切英文
    await page.evalJs(clickTestId('lang-toggle'));
    await page.waitFor(`document.body.textContent.includes('Process Console')`, { label: '英文界面' });
    await sleep(400);
    const en = await shot('02-英文界面');

    // 切回中文(别污染本地存储)
    await page.evalJs(clickTestId('lang-toggle'));
    await page.waitFor(`document.body.textContent.includes('进程控制台')`, { label: '切回中文' });

    // README 用图
    copyFileSync(zh, join(DOCS_IMG, 'console.png'));
    copyFileSync(en, join(DOCS_IMG, 'console-en.png'));
    console.log('已更新 docs/images/console.png 与 console-en.png');
  } finally {
    proc.kill();
    srv.kill();
    staticSrv.close();
  }
  if (errors.length) {
    console.log('\n⚠ 页面错误汇总:', JSON.stringify(errors, null, 2).slice(0, 800));
    process.exit(1);
  }
  console.log('\n✅ qa-i18n 完成,无页面错误');
}

main().catch((e) => {
  console.error('qa-i18n 失败:', e.message);
  process.exit(1);
});
