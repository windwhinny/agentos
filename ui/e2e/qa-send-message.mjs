// 真实服务端到端验证:init 协调者用 send_message 唤醒一个已 done 的子进程
// 用法: node e2e/qa-send-message.mjs  → 截图到 e2e/artifacts/qa/
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, sleep } from './lib/cdp.mjs';
import { serveStatic } from './lib/servers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(ROOT, '..');
const OUT = join(ROOT, 'e2e', 'artifacts', 'qa');

const env = readFileSync(join(REPO, '.env'), 'utf8');
const apiKey = env.match(/DEEPSEEK_API_KEY\s*=\s*(\S+)/)?.[1];
if (!apiKey) throw new Error('no key');

const server = spawn('npm', ['run', 'server'], {
  cwd: REPO,
  env: { ...process.env, DEEPSEEK_API_KEY: apiKey, PORT: '8787' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

const fillInput = (text) =>
  `(()=>{const el=document.querySelector('form input:not([type=file])');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(text)});el.dispatchEvent(new Event('input',{bubbles:true}));return true})()`;
const clickSend = `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='发送');b.click();return true})()`;

try {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch('http://localhost:8787/')).ok) break; } catch {}
    await sleep(200);
  }
  const staticServer = await serveStatic(join(ROOT, 'dist'), 7199);
  const { proc, client } = await launchChrome();
  try {
    const page = await client.newPage('http://127.0.0.1:7199/?server=http://localhost:8787');
    await page.waitFor(`document.querySelectorAll('tbody tr').length >= 1`, { label: '进程表' });
    await sleep(1000);

    // 一条指令让 init 走完整流程:spawn → wait → 对 done 子进程 send_message
    await page.evalJs(fillInput('请严格按顺序执行:1) 用 spawn_process 派生一个子进程,任务写「用一句话介绍你自己」;2) 用 wait_process 等它退出;3) 用 send_message 给它发「再介绍一下你自己」。不要做别的。'));
    await page.evalJs(clickSend);

    // 等子进程出现
    await page.waitFor(`document.querySelectorAll('tbody tr').length >= 2`, { timeoutMs: 60000, label: '子进程出现' });
    await sleep(2000);
    await page.screenshot(join(OUT, 'sm-01-子进程已spawn.png'));

    // 等 init 完成整个流程(它 done 了说明 send_message 也执行完了)
    await page
      .waitFor(
        `(()=>{const r=[...document.querySelectorAll('tbody tr')].find(r=>r.textContent.includes('★ 1'));return !!r && r.textContent.includes('done')})()`,
        { timeoutMs: 150000, label: 'init 流程完成' },
      )
      .catch(() => {});
    await sleep(4000); // 给被唤醒的子进程留应答时间
    await page.screenshot(join(OUT, 'sm-02-init流程完成.png'));

    // attach 子进程看它是否被唤醒续聊
    await page.evalJs(`(()=>{const r=document.querySelectorAll('tbody tr')[1];if(r)r.click();return true})()`);
    await sleep(800);
    await page.screenshot(join(OUT, 'sm-03-子进程终端.png'));
    const childText = await page.evalJs(`(()=>{const t=document.querySelector('.flex-1.overflow-auto.px-3.py-2');return t?t.textContent.replace(/\\s+/g,' '):''})()`);
    const initRow = await page.evalJs(`(()=>{const r=[...document.querySelectorAll('tbody tr')].find(r=>r.textContent.includes('★ 1'));return r?r.textContent.replace(/\\s+/g,' '):''})()`);
    const childRow = await page.evalJs(`(()=>{const r=document.querySelectorAll('tbody tr')[1];return r?r.textContent.replace(/\\s+/g,' '):''})()`);
    console.log('init 行:', initRow);
    console.log('子进程行:', childRow);
    console.log('子进程终端:', childText.slice(0, 400));
    if (page.consoleErrors.length) console.log('页面错误:', page.consoleErrors);
    await page.close();
  } finally {
    proc.kill();
    staticServer.close();
  }
} finally {
  server.kill();
}
process.exit(0);
