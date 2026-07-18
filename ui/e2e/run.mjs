// AgentOS 控制台 e2e 运行器:零依赖(Node>=22 + 系统 Chrome)
// 流程:确保 dist 构建 → 静态服务(:7199) → 假 live server(:8899) → headless Chrome → 逐条跑 tests/*.test.mjs
// 用法: npm run test:e2e        (dist 存在则直接用,否则先构建)
//       npm run test:e2e -- --build   (强制重新构建)
//       npm run test:e2e -- --only 05 (只跑文件名含 05 的用例)
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchChrome, sleep } from './lib/cdp.mjs';
import { dom } from './lib/dom.mjs';
import { serveStatic, createFakeLiveServer } from './lib/servers.mjs';

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(E2E_DIR, '..');
const DIST_DIR = join(UI_DIR, 'dist');
const ARTIFACTS_DIR = join(E2E_DIR, 'artifacts');
const STATIC_PORT = 7199;
const FAKE_PORT = 8899;

const args = process.argv.slice(2);
const forceBuild = args.includes('--build');
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;

// —— 断言工具 ——
class AssertError extends Error {}
const assert = {
  ok(v, msg) {
    if (!v) throw new AssertError(msg ?? `断言失败:期望真值,实际 ${JSON.stringify(v)}`);
  },
  equal(a, b, msg) {
    if (a !== b)
      throw new AssertError(msg ?? `断言失败:期望 ${JSON.stringify(b)},实际 ${JSON.stringify(a)}`);
  },
};

async function ensureBuild() {
  if (!forceBuild && existsSync(join(DIST_DIR, 'index.html'))) {
    console.log('• 使用现有 dist/(传 --build 强制重建)');
    return;
  }
  console.log('• 构建前端(npm run build)…');
  const r = spawnSync('npm', ['run', 'build'], { cwd: UI_DIR, stdio: 'inherit' });
  if (r.status !== 0) throw new Error('前端构建失败');
}

async function main() {
  await ensureBuild();
  mkdirSync(ARTIFACTS_DIR, { recursive: true });

  console.log(`• 静态服务 dist → http://127.0.0.1:${STATIC_PORT}`);
  const staticServer = await serveStatic(DIST_DIR, STATIC_PORT);
  console.log(`• 假 live server → http://127.0.0.1:${FAKE_PORT}`);
  const fake = await createFakeLiveServer(FAKE_PORT);

  console.log('• 启动 headless Chrome…');
  const { proc, client, profile } = await launchChrome();

  const files = readdirSync(join(E2E_DIR, 'tests'))
    .filter((f) => f.endsWith('.test.mjs'))
    .filter((f) => !only || f.includes(only))
    .sort();

  let pass = 0;
  const failures = [];
  try {
    for (const f of files) {
      const mod = await import(pathToFileURL(join(E2E_DIR, 'tests', f)).href);
      const url =
        mod.mode === 'live'
          ? `http://127.0.0.1:${STATIC_PORT}/?server=http://127.0.0.1:${FAKE_PORT}`
          : `http://127.0.0.1:${STATIC_PORT}/`;
      const page = await client.newPage(url);
      const t0 = Date.now();
      try {
        await Promise.race([
          mod.default({ page, dom, assert, fake, sleep, ports: { static: STATIC_PORT, fake: FAKE_PORT } }),
          sleep(90_000).then(() => {
            throw new AssertError('用例超时(90s)');
          }),
        ]);
        // 页面 JS 异常/console.error 也视为失败
        if (page.consoleErrors.length)
          throw new AssertError(`页面产生 ${page.consoleErrors.length} 条错误:\n  ` + page.consoleErrors.join('\n  '));
        pass++;
        console.log(`ok   ${f} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      } catch (e) {
        failures.push({ f, error: e });
        const shot = join(ARTIFACTS_DIR, `${f.replace(/\.test\.mjs$/, '')}-fail.png`);
        await page.screenshot(shot).catch(() => {});
        console.log(`not ok ${f}`);
        console.log(`  ${String(e.message ?? e).split('\n').join('\n  ')}`);
        if (page.consoleErrors.length) console.log(`  页面错误:\n  ` + page.consoleErrors.join('\n  '));
        console.log(`  截图: ${shot}`);
      }
      await page.close();
    }
  } finally {
    proc.kill('SIGKILL');
    await sleep(300); // 等 Chrome 退出,避免清理 profile 时 ENOTEMPTY
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    staticServer.close();
    fake.server.close();
  }

  console.log(`\n${pass}/${files.length} 通过`);
  if (failures.length) {
    console.log('失败用例: ' + failures.map((x) => x.f).join(', '));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('e2e 运行器失败:', e);
  process.exit(1);
});
