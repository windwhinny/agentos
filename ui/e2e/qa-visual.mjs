// 可视化手工 QA:真实后端(DeepSeek)+ 真实 Chrome(headless)+ 每步截图
// 目的:像真实用户一样操作页面,把渲染结果拍下来供人工检查,而不是只做 DOM 断言
// 用法: node e2e/qa-visual.mjs [--live-only|--demo-only]
// 产物: e2e/artifacts/qa/*.png + qa-report.json(每步页面错误/控制台错误)
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, sleep } from './lib/cdp.mjs';
import { serveStatic } from './lib/servers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(ROOT, '..');
const OUT = join(ROOT, 'e2e', 'artifacts', 'qa');
const LIVE = !process.argv.includes('--demo-only');
const DEMO = !process.argv.includes('--live-only');
const report = { steps: [], pageErrors: {} };

mkdirSync(OUT, { recursive: true });

// —— 从 .env 读 DEEPSEEK_API_KEY(不打印) ——
function loadKey() {
  try {
    const env = readFileSync(join(REPO, '.env'), 'utf8');
    const m = env.match(/DEEPSEEK_API_KEY\s*=\s*(\S+)/);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

// —— 启动真实后端 :8787 ——
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

// —— 通用步骤封装:截图 + 记录页面错误 ——
function makeStep(page, tag) {
  return async (name) => {
    const file = join(OUT, `${tag}-${name}.png`);
    await page.screenshot(file);
    const errs = page.consoleErrors.splice(0);
    report.steps.push({ tag, name, file, errors: errs });
    if (errs.length) console.log(`  ⚠ ${tag}-${name} 页面错误:`, errs.join(' | ').slice(0, 300));
    else console.log(`  📸 ${tag}-${name}.png`);
  };
}

// —— 页面操作助手 ——
const clickBtn = (text) =>
  `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b)return false;b.click();return true})()`;
const clickRow = (text) =>
  `(()=>{const r=[...document.querySelectorAll('tbody tr')].find(r=>r.textContent.includes(${JSON.stringify(text)}));if(!r)return false;r.click();return true})()`;
const fillInput = (text) =>
  `(()=>{const el=document.querySelector('form input:not([type=file])');if(!el)return false;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(text)});el.dispatchEvent(new Event('input',{bubbles:true}));return true})()`;
const fillTextarea = (text) =>
  `(()=>{const el=document.querySelector('textarea');if(!el)return false;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,${JSON.stringify(text)});el.dispatchEvent(new Event('input',{bubbles:true}));return true})()`;

// ================= LIVE 旅程(真 DeepSeek) =================
async function liveJourney(staticPort) {
  console.log('—— LIVE 旅程(真后端 + DeepSeek)——');
  const { proc, client } = await launchChrome();
  try {
    const page = await client.newPage(`http://127.0.0.1:${staticPort}/?server=http://localhost:8787`);
    const shot = makeStep(page, 'live');
    report.pageErrors.live = page.consoleErrors;

    await page.waitFor(`document.querySelectorAll('tbody tr').length >= 1`, { label: '进程表出现' });
    await sleep(1500);
    await shot('01-初始加载');

    // 选中 PID 1(init 协调进程)
    await page.evalJs(clickRow('★ 1'));
    await sleep(800);
    await shot('02-attach-PID1');

    // 发消息:问一个简短问题,观察流式渲染
    await page.evalJs(fillInput('用一句话说明什么是进程'));
    await shot('03-输入待发');
    await page.evalJs(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='发送');b.click();return true})()`);
    await sleep(4000); // 流式中段
    await shot('04-流式中段');
    // 等生成结束:生成中指示消失
    await page
      .waitFor(`!document.body.textContent.includes('生成中')`, { timeoutMs: 60000, label: '生成结束' })
      .catch(() => {});
    await sleep(1000);
    await shot('05-回复完成');

    // 滚动终端到顶部,检查完整对话渲染(用户怀疑重复)
    await page.evalJs(`(()=>{const t=document.querySelector('.flex-1.overflow-auto.px-3.py-2');if(t)t.scrollTop=0;return true})()`);
    await sleep(300);
    await shot('06-终端顶部视角');

    // 按钮全点一遍:spawn 对话框
    await page.evalJs(clickBtn('＋子进程'));
    await sleep(500);
    await shot('07-spawn对话框');
    await page.evalJs(fillTextarea('用一句话介绍你自己'));
    await page.evalJs(clickBtn('spawn'));
    await page
      .waitFor(`document.querySelectorAll('tbody tr').length >= 2`, { timeoutMs: 15000, label: '子进程出现' })
      .catch(() => {});
    await sleep(3000);
    await shot('08-spawn后');

    // fork( prompt 自动接受)
    await page.evalJs(clickRow('★ 1'));
    await sleep(300);
    await page.evalJs(clickBtn('fork'));
    await sleep(2500);
    await shot('09-fork后');

    // pipe→ :源 PID 1 → 目标第一行子进程
    await page.evalJs(clickRow('★ 1'));
    await page.evalJs(clickBtn('pipe→'));
    await sleep(400);
    await shot('10-pipe源已选');
    await page.evalJs(`(()=>{const r=document.querySelectorAll('tbody tr')[1];if(!r)return false;r.click();return true})()`);
    await sleep(800);
    await shot('11-pipe连接后');

    // 信号:对子进程 ⏸ ▶ TERM
    await page.evalJs(`(()=>{const r=document.querySelectorAll('tbody tr')[1];if(!r)return false;r.click();return true})()`);
    await page.evalJs(clickBtn('⏸'));
    await sleep(1200);
    await shot('12-SIGSTOP后');
    await page.evalJs(clickBtn('▶'));
    await sleep(1200);
    await shot('13-SIGCONT后');
    await page.evalJs(clickBtn('TERM'));
    await sleep(2500);
    await shot('14-SIGTERM后');

    await page.close();
  } finally {
    proc.kill();
  }
}

// ================= DEMO 旅程(内置 Mock) =================
async function demoJourney(staticPort) {
  console.log('—— DEMO 旅程(内置 Mock 大脑)——');
  const { proc, client } = await launchChrome();
  try {
    const page = await client.newPage(`http://127.0.0.1:${staticPort}/`);
    const shot = makeStep(page, 'demo');
    report.pageErrors.demo = page.consoleErrors;

    await page.waitFor(
      `(()=>{const r=[...document.querySelectorAll('tbody tr')].find(r=>r.textContent.includes('★ 1'));return !!r && r.textContent.includes('done')})()`,
      { timeoutMs: 30000, label: 'init 完成' },
    );
    await sleep(1000);
    await shot('01-demo剧本跑完');

    // 点击每一行看看 attach 渲染
    const rows = await page.evalJs(`document.querySelectorAll('tbody tr').length`);
    for (let i = 0; i < Math.min(rows, 3); i++) {
      await page.evalJs(`document.querySelectorAll('tbody tr')[${i}].click()`);
      await sleep(500);
      await shot(`02-attach第${i + 1}行`);
    }

    // 发消息(点发送按钮)
    await page.evalJs(`document.querySelectorAll('tbody tr')[0].click()`);
    await page.evalJs(fillInput('你好,介绍一下你自己'));
    await page.evalJs(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='发送');b.click();return true})()`);
    await sleep(2500);
    await shot('03-demo发消息后');

    // 按 Enter 再发一条(测试键盘提交)
    await page.evalJs(fillInput('第二条消息'));
    await page.evalJs(`(()=>{const f=document.querySelector('form');f.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));return true})()`);
    await sleep(2500);
    await shot('04-demo第二条后');

    // 无选中进程时按钮行为:先记录日志数,再逐个猛点信号按钮
    await page.evalJs(clickBtn('⏸'));
    await sleep(400);
    await shot('05-对已退出进程SIGSTOP');
    await page.evalJs(clickBtn('KILL'));
    await sleep(600);
    await shot('06-KILL后');

    // spawn 对话框:不填直接提交(空任务)
    await page.evalJs(clickBtn('＋子进程'));
    await sleep(400);
    await shot('07-spawn空对话框');
    await page.evalJs(clickBtn('spawn'));
    await sleep(1200);
    await shot('08-空任务spawn后');

    // fork 已退出进程
    await page.evalJs(clickBtn('fork'));
    await sleep(1500);
    await shot('09-fork已退出进程后');

    await page.close();
  } finally {
    proc.kill();
  }
}

// ================= main =================
const staticServer = await serveStatic(join(ROOT, 'dist'), 7199);
let serverProc = null;
try {
  if (LIVE) {
    const key = loadKey();
    if (!key) throw new Error('.env 中没有 DEEPSEEK_API_KEY,跳过 live 旅程');
    serverProc = await startRealServer(key);
    await liveJourney(7199);
    serverProc.kill();
    serverProc = null;
  }
  if (DEMO) await demoJourney(7199);
} finally {
  serverProc?.kill();
  staticServer.close();
}
writeFileSync(join(OUT, 'qa-report.json'), JSON.stringify(report, null, 2));
console.log(`\nQA 完成: ${report.steps.length} 张截图 → ${OUT}`);
