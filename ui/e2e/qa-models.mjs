// 可视化 QA:模型管理功能(真实后端 + 真实 Chrome headless,逐步截图)
// 用法: node e2e/qa-models.mjs   (需 repo 根 .env 有 DEEPSEEK_API_KEY;自动起 :8787 真后端)
// 产物: e2e/artifacts/qa-models/*.png
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, sleep } from './lib/cdp.mjs';
import { serveStatic } from './lib/servers.mjs';
import { dom } from './lib/dom.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(ROOT, '..');
const OUT = join(ROOT, 'e2e', 'artifacts', 'qa-models');
mkdirSync(OUT, { recursive: true });

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
      await page.screenshot(join(OUT, `${name}.png`));
      const errs = page.consoleErrors.splice(0);
      if (errs.length) errors.push({ name, errs });
      console.log(`📸 ${name}${errs.length ? ' ⚠ ' + errs.join('|').slice(0, 200) : ''}`);
    };

    await page.waitFor(`(${dom.modelSelectValue}) !== null`, { label: '模型下拉加载' });
    await sleep(1200);
    await shot('01-顶栏模型下拉');

    // 打开管理面板
    await page.evalJs(dom.clickModelManagerBtn);
    await page.waitFor(dom.modelManagerVisible, { label: '面板打开' });
    await sleep(400);
    await shot('02-模型管理面板');

    // 录入一个 anthropic 供应商(假 key,不会被真实调用)
    await page.evalJs(dom.fillProviderField('provider-name-input', 'claude-test'));
    await page.evalJs(dom.selectProviderType('anthropic'));
    await page.evalJs(dom.fillProviderField('provider-apikey-input', 'sk-ant-qa-fake'));
    await page.evalJs(dom.fillProviderField('provider-models-input', 'claude-sonnet-4, claude-haiku-4'));
    await shot('03-录入表单填好');
    await page.evalJs(dom.clickProviderSubmit);
    await page.waitFor(dom.providerCardVisible('claude-test'), { label: '新供应商卡片出现' });
    await sleep(400);
    await shot('04-录入完成');

    // 点 chip 设 claude-sonnet-4 为默认
    await page.evalJs(dom.clickModelChip('claude-sonnet-4'));
    await page.waitFor(`(${dom.modelSelectValue}) === 'claude-sonnet-4'`, { label: '顶栏默认联动' });
    await sleep(300);
    await shot('05-默认已切换');

    // spawn 对话框联动
    await page.evalJs(`(()=>{const r=document.querySelectorAll('tbody tr')[0];if(r)r.click();return true})()`);
    await sleep(300);
    await page.evalJs(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='＋子进程');b.click();return true})()`);
    await page.waitFor(dom.dialogVisible, { label: 'spawn 对话框' });
    await sleep(300);
    await shot('06-spawn对话框默认模型联动');
    const spawnVal = await page.evalJs(dom.spawnModelValue);
    console.log(`  spawn 对话框默认模型 = ${spawnVal}(期望 claude-sonnet-4)`);
    await page.evalJs(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='取消');if(b)b.click();return true})()`);

    // 清理:删除 claude-test,默认回退 deepseek
    await page.evalJs(dom.clickModelManagerBtn);
    await page.waitFor(dom.modelManagerVisible, { label: '面板重开' });
    await page.evalJs(dom.clickProviderDelete('claude-test'));
    await page.waitFor(`!(${dom.providerCardVisible('claude-test')})`, { label: '供应商已删' });
    await sleep(300);
    await shot('07-删除后回退');
    const finalDefault = await page.evalJs(dom.modelSelectValue);
    console.log(`  删除后默认模型 = ${finalDefault}(期望回退 deepseek-v4-pro)`);
  } finally {
    proc.kill();
    srv.kill();
    staticSrv.close();
  }
  if (errors.length) {
    console.log('\n⚠ 页面错误汇总:', JSON.stringify(errors, null, 2).slice(0, 800));
    process.exit(1);
  }
  console.log('\n✅ qa-models 完成,无页面错误');
}

main().catch((e) => {
  console.error('qa-models 失败:', e.message);
  process.exit(1);
});
