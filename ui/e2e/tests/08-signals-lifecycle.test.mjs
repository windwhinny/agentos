// 信号全流程:SIGSTOP 暂停 → SIGCONT 恢复 → SIGKILL 级联终止 → SIGTERM 优雅退出
// 用「写手」剧本(任务含「摘要」进写手分支、不含「调研结论」不满足退出条件):
// 它会以 1.5s/拍循环 ps,是长期存活的多轮进程,
// 让 SIGSTOP 的 step-boundary 语义可观测(单轮进程在 LLM 返回后直接退出,观察不到 paused)
// 注意1:任务文本若含「调研结论」会让写手第一轮就满足退出条件直接 done(本项目踩过)
// 注意2:信号按钮对已退出进程禁用(见 16),所以级联/TERM 都必须以存活进程为目标
export const mode = 'demo';

export default async function run({ page, dom, assert, sleep }) {
  await page.waitFor(dom.rowStateIs('★ 1', 'done'), { label: 'init 进程完成' });

  // spawn 一个无限循环的写手进程(PID 4)
  assert.ok(await page.evalJs(dom.clickRow('★ 1')), '选中 PID 1');
  assert.ok(await page.evalJs(dom.clickButton('＋子进程')), '打开 spawn 对话框');
  await page.waitFor(dom.dialogVisible, { label: 'spawn 对话框出现' });
  assert.ok(await page.evalJs(dom.fillTextarea('等待上游并写成摘要')), '填写写手任务');
  assert.ok(await page.evalJs(dom.clickButton('spawn')), '提交 spawn');
  await page.waitFor(dom.terminalAttachIs('PID 4'), { label: '自动 attach PID 4' });

  // 等它进入循环(至少 2 轮)
  await page.waitFor(
    `(()=>{const r=[...document.querySelectorAll('tbody tr')].find(r=>r.textContent.includes(' 4'));return !!r && !r.textContent.includes('done')})()`,
    { label: 'PID 4 存活' },
  );
  await sleep(2000);

  // SIGSTOP → 下一 step 边界应进入 paused
  assert.ok(await page.evalJs(dom.clickButton('⏸')), '发送 SIGSTOP');
  await page.waitFor(dom.rowStateIs(' 4', 'paused'), { label: 'PID 4 进入 paused', timeoutMs: 8000 });

  // SIGCONT → 恢复运行(blocked/running)
  assert.ok(await page.evalJs(dom.clickButton('▶')), '发送 SIGCONT');
  await page.waitFor(
    `(()=>{const r=[...document.querySelectorAll('tbody tr')].find(r=>r.textContent.includes(' 4'));return !!r && !r.textContent.includes('paused') && !r.textContent.includes('done')})()`,
    { label: 'PID 4 恢复运行', timeoutMs: 8000 },
  );

  // SIGKILL 级联:以 PID 4 为父再 spawn 一个写手(PID 5),KILL 存活的 PID 4,整棵子树应被终止
  assert.ok(await page.evalJs(dom.clickRow(' 4')), '选中 PID 4');
  assert.ok(await page.evalJs(dom.clickButton('＋子进程')), '以 PID 4 为父打开 spawn 对话框');
  await page.waitFor(dom.dialogVisible, { label: 'spawn 对话框出现' });
  assert.ok(await page.evalJs(dom.fillTextarea('等待上游并写成摘要')), '填写写手任务');
  assert.ok(await page.evalJs(dom.clickButton('spawn')), '提交 spawn');
  await page.waitFor(dom.rowCountIs(5), { label: 'PID 5 出现' });
  await sleep(1000);
  assert.ok(await page.evalJs(dom.clickRow(' 4')), '选中 PID 4');
  assert.ok(await page.evalJs(dom.clickButton('KILL')), '对存活的 PID 4 发送 SIGKILL');
  await page.waitFor(dom.rowStateIs(' 4', 'killed'), { label: 'PID 4 被终止', timeoutMs: 8000 });
  await page.waitFor(dom.rowStateIs(' 5', 'killed'), { label: 'PID 5 被级联终止', timeoutMs: 8000 });

  // SIGTERM:再 spawn 一个写手(PID 6,父 PID 1),优雅退出
  assert.ok(await page.evalJs(dom.clickRow('★ 1')), '选中 PID 1');
  assert.ok(await page.evalJs(dom.clickButton('＋子进程')), '再次打开 spawn 对话框');
  await page.waitFor(dom.dialogVisible, { label: 'spawn 对话框出现' });
  assert.ok(await page.evalJs(dom.fillTextarea('等待上游并写成摘要')), '填写写手任务');
  assert.ok(await page.evalJs(dom.clickButton('spawn')), '提交 spawn');
  await page.waitFor(dom.rowCountIs(6), { label: 'PID 6 出现' });
  await sleep(500);
  assert.ok(await page.evalJs(dom.clickButton('TERM')), '发送 SIGTERM');
  await page.waitFor(dom.rowStateIs(' 6', 'done'), { label: 'PID 6 优雅退出', timeoutMs: 8000 });
  assert.ok(await page.evalJs(dom.logsContain('SIGTERM')), '事件流记录 SIGTERM');
}
