// 可视化 QA:中英文界面(真实后端 + 真实 Chrome headless @2x)
// 同时产出 README 用界面截图 → docs/images/console.png(中文 UI)/ console-en.png(英文 UI)
// 场景展示 Agent 间通信:researcher 产出结论,writer 用 ps/wait_process 协调等待,
// 结论经 pipe 流入 writer stdin,writer 引用收信(Received:)并汇总(Summary:)——对话内容全英文
// 确定性保障:
//   - 启动即中断 init 的开场生成(转 ON_INBOX 保持静默),防止它自主 spawn 子进程污染画面
//   - 临时重置 models.json(避免历史 QA 注册的假 provider 入镜),结束后恢复
//   - 页面加载后立刻切英文 UI 再跑场景,事件流日志同样为英文
// 用法: node e2e/qa-i18n.mjs   (需 repo 根 .env 有 OPENAI_API_KEY;自动起 :8787 真后端)
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, sleep } from './lib/cdp.mjs';
import { serveStatic } from './lib/servers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(ROOT, '..');
const OUT = join(ROOT, 'e2e', 'artifacts', 'qa-i18n');
const DOCS_IMG = join(REPO, 'docs', 'images');
const MODELS_JSON = join(REPO, 'server', 'models.json');
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

const post = (path, body) =>
  fetch(`http://localhost:8787${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
const getState = async () => (await fetch('http://localhost:8787/api/state')).json();

/** 让 init 静默:中断开场生成 → ON_INBOX(或已完成 → done,同样静默);清掉它自主 spawn 的杂散进程 */
async function quietInit() {
  for (let i = 0; i < 10; i++) {
    await post('/api/interrupt', { pid: 1 }).catch(() => {});
    await sleep(600);
    const { ps } = await getState();
    const init = ps.find((p) => p.pid === 1);
    if (init && init.blockedReason !== 'ON_LLM' && init.state !== 'running') break;
  }
  const { ps } = await getState();
  for (const p of ps) if (p.pid > 1) await post('/api/signal', { pid: p.pid, sig: 'SIGKILL' }).catch(() => {});
}

const clickBtn = (text) =>
  `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b)return false;b.click();return true})()`;
const clickRow = (text) =>
  `(()=>{const r=[...document.querySelectorAll('tbody tr')].find(r=>r.textContent.includes(${JSON.stringify(text)}));if(!r)return false;r.click();return true})()`;
const fillDialog = (selector, text) =>
  `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(text)});el.dispatchEvent(new Event('input',{bubbles:true}));return true})()`;
const clickTestId = (id) =>
  `(()=>{const b=document.querySelector('[data-testid=${id}]');if(!b)return false;b.click();return true})()`;

async function main() {
  const apiKey = loadKey();
  if (!apiKey) throw new Error('.env 缺 OPENAI_API_KEY');
  // 临时重置 models.json(可能残留历史 QA 注册的假 provider),结束恢复原文件
  let modelsBak = null;
  try {
    modelsBak = readFileSync(MODELS_JSON, 'utf8');
  } catch {}
  rmSync(MODELS_JSON, { force: true });

  const srv = await startRealServer(apiKey);
  await quietInit(); // 尽早中断 init,防止它自主 spawn 子进程污染画面
  const staticSrv = await serveStatic(join(ROOT, 'dist'), 7200);
  const { proc, client } = await launchChrome();
  const errors = [];
  try {
    const page = await client.newPage('http://127.0.0.1:7200/?server=http://localhost:8787');
    // 2x 渲染:README 截图需要高分屏清晰度(1440x900 逻辑像素 → 2880x1800 PNG)
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 2,
      mobile: false,
    });
    const shot = async (name) => {
      const file = join(OUT, `${name}.png`);
      await page.screenshot(file);
      const errs = page.consoleErrors.splice(0);
      if (errs.length) errors.push({ name, errs });
      console.log(`📸 ${name}${errs.length ? ' ⚠ ' + errs.join('|').slice(0, 200) : ''}`);
      return file;
    };
    const spawnChild = async (name, task) => {
      await page.evalJs(clickBtn('＋child'));
      await sleep(400);
      await page.evalJs(fillDialog('[data-testid=spawn-dialog] textarea', task));
      await page.evalJs(fillDialog('[data-testid=spawn-dialog] input', name));
      await page.evalJs(clickTestId('spawn-submit'));
      await sleep(600); // 自动 attach 到新进程
    };

    await page.waitFor(`document.querySelectorAll('tbody tr').length >= 1`, { label: '进程表出现' });
    // 先切英文 UI 再跑场景:事件流日志随当前语言落账,保证英文截图全英文
    await page.evalJs(clickTestId('lang-toggle'));
    await page.waitFor(`document.body.textContent.includes('Process Console')`, { label: '英文界面' });
    await sleep(500);
    await page.evalJs(clickRow('★ 1'));

    // —— researcher:产出三点结论(生成期较长,留出建管窗口) ——
    await spawnChild(
      'researcher',
      'You are a researcher. List exactly 3 design pillars of an OS-style agent runtime — lifecycle, inter-process communication, and resource budget. One short line each.',
    );

    // —— writer:ps 找到 researcher → wait_process 阻塞等待 → 收信后引用并汇总 ——
    await page.evalJs(clickRow('★ 1'));
    await spawnChild(
      'writer',
      `You are a writer. Do these steps in order: 1) Call the ps tool to list processes and find the one named 'researcher'. 2) Call wait_process on the researcher's pid to wait for it to finish. 3) Its conclusion will then arrive as a message — quote it verbatim under a 'Received:' heading, then distill it into a one-sentence 'Summary:'.`,
    );

    // —— 建管道 researcher → writer(拓扑面板可见;researcher 仍在生成,writer 阻塞中) ——
    await page.evalJs(clickRow('researcher'));
    await sleep(300);
    await page.evalJs(clickBtn('pipe→'));
    await sleep(300);
    await page.evalJs(clickRow('writer'));
    await sleep(500);

    // —— researcher 完成 → 最终帧经管道流入 writer stdin → writer 引用收信并汇总 ——
    await page
      .waitFor(`document.body.textContent.includes('Summary')`, { timeoutMs: 150000, label: 'writer 汇总出现' })
      .catch(() => console.log('  ⚠ writer 未产出 Summary,截图可能缺少收信响应'));
    // 等 writer 彻底生成完再截图('Summary' 可能先在 thinking 流里出现)
    await page
      .waitFor(`!document.body.textContent.includes('generating')`, { timeoutMs: 90000, label: 'writer 空闲' })
      .catch(() => {});
    await sleep(1500);

    const en = await shot('01-英文界面');

    // 切中文拍第二张(事件流日志已按英文落账,中文截图中日志同样为英文)
    await page.evalJs(clickTestId('lang-toggle'));
    await page.waitFor(`document.body.textContent.includes('进程控制台')`, { label: '中文界面' });
    await sleep(400);
    const zh = await shot('02-中文界面');

    // README 用图
    copyFileSync(zh, join(DOCS_IMG, 'console.png'));
    copyFileSync(en, join(DOCS_IMG, 'console-en.png'));
    console.log('已更新 docs/images/console.png 与 console-en.png');
  } finally {
    proc.kill();
    srv.kill();
    staticSrv.close();
    if (modelsBak !== null) writeFileSync(MODELS_JSON, modelsBak, { mode: 0o600 });
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
