// 可视化 QA:中英文界面(真实后端 + 真实 Chrome headless)
// 同时产出 README 用界面截图 → docs/images/console.png(中文)/ console-en.png(英文)
// 用法: node e2e/qa-i18n.mjs   (需 repo 根 .env 有 DEEPSEEK_API_KEY;自动起 :8787 真后端)
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
  return env.match(/DEEPSEEK_API_KEY\s*=\s*(\S+)/)?.[1] ?? null;
}

async function startRealServer(apiKey) {
  const proc = spawn('npm', ['run', 'server'], {
    cwd: REPO,
    env: { ...process.env, DEEPSEEK_API_KEY: apiKey, PORT: '8787' },
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
const fillInput = (text) =>
  `(()=>{const el=document.querySelector('form input:not([type=file])');if(!el)return false;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(text)});el.dispatchEvent(new Event('input',{bubbles:true}));return true})()`;

async function main() {
  const apiKey = loadKey();
  if (!apiKey) throw new Error('.env 缺 DEEPSEEK_API_KEY');
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

    await page.waitFor(`document.querySelectorAll('tbody tr').length >= 1`, { label: '进程表出现' });
    await sleep(1000);

    // 让终端有点真实内容:选中 init,发一句短消息
    await page.evalJs(`(()=>{const r=document.querySelectorAll('tbody tr')[0];if(r)r.click();return true})()`);
    await sleep(500);
    await page.evalJs(fillInput('用一句话说明什么是进程'));
    await page.evalJs(clickBtn('发送'));
    await page
      .waitFor(`!document.body.textContent.includes('生成中')`, { timeoutMs: 60000, label: '生成结束' })
      .catch(() => {});
    await sleep(1200);

    // spawn 一个子进程让进程表更丰富(不问 LLM,立刻有行)
    await page.evalJs(clickBtn('＋子进程'));
    await sleep(400);
    await page.evalJs(
      `(()=>{const el=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'用一句话介绍你自己');el.dispatchEvent(new Event('input',{bubbles:true}));return true})()`,
    );
    await page.evalJs(clickBtn('spawn'));
    await sleep(2500);
    // 回到 PID 1 视角截图(有对话内容)
    await page.evalJs(`(()=>{const r=document.querySelectorAll('tbody tr')[0];if(r)r.click();return true})()`);
    await sleep(500);
    const zh = await shot('01-中文界面');

    // 切英文
    await page.evalJs(`(()=>{const b=document.querySelector('[data-testid=lang-toggle]');if(!b)return false;b.click();return true})()`);
    await page.waitFor(`document.body.textContent.includes('Process Console')`, { label: '英文界面' });
    await sleep(400);
    const en = await shot('02-英文界面');

    // 切回中文(别污染本地存储)
    await page.evalJs(`(()=>{const b=document.querySelector('[data-testid=lang-toggle]');if(!b)return false;b.click();return true})()`);
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
