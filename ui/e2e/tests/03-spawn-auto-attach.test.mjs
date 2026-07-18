// Bug 回归:spawn 子进程后终端仍停留在父进程,看不到新进程的输出
// 修复:App.tsx —— spawn/fork 成功后自动 select 新 PID
export const mode = 'demo';

export default async function run({ page, dom, assert }) {
  await page.waitFor(dom.rowStateIs('★ 1', 'done'), { label: 'init 进程完成' });

  assert.ok(await page.evalJs(dom.clickRow('★ 1')), '选中 PID 1');
  assert.ok(await page.evalJs(dom.clickButton('＋子进程')), '打开 spawn 对话框');
  await page.waitFor(dom.dialogVisible, { label: 'spawn 对话框出现' });
  assert.ok(await page.evalJs(dom.fillTextarea('e2e：自动 attach 回归测试')), '填写任务');
  assert.ok(await page.evalJs(dom.clickButton('spawn')), '提交 spawn');

  // demo 剧本结束后已有 PID 1/2/3,新进程应为 PID 4
  await page.waitFor(dom.rowCountIs(4), { label: '进程表出现 PID 4' });
  // 关键断言:没有点击新进程行,终端应已自动 attach 到 PID 4
  await page.waitFor(dom.terminalAttachIs('PID 4'), { label: '终端自动 attach 到 PID 4' });
  await page.waitFor(dom.terminalContains('e2e：自动 attach 回归测试'.slice(0, 10)), {
    label: '终端显示新进程输出',
  });
}
