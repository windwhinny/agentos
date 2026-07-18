// Bug 回归:对已退出进程点信号按钮毫无反应(内核静默 no-op),看起来「按钮坏了」
// 修复:ProcessTable 对已退出进程禁用信号按钮(spawn/fork/pipe 仍然可用)
export const mode = 'demo';

export default async function run({ page, dom, assert }) {
  await page.waitFor(dom.rowStateIs('★ 1', 'done'), { label: 'init 进程已退出' });

  assert.ok(await page.evalJs(dom.clickRow('★ 1')), '选中已退出的 PID 1');
  assert.ok(await page.evalJs(dom.signalButtonsDisabled), '已退出进程的信号按钮应全部禁用');

  // spawn 一个无限循环写手(存活进程),自动 attach 后信号按钮应恢复可用
  assert.ok(await page.evalJs(dom.clickButton('＋子进程')), '打开 spawn 对话框');
  await page.waitFor(dom.dialogVisible, { label: 'spawn 对话框出现' });
  assert.ok(await page.evalJs(dom.fillTextarea('等待上游并写成摘要')), '填写写手任务(无限循环)');
  assert.ok(await page.evalJs(dom.clickButton('spawn')), '提交 spawn');
  await page.waitFor(dom.terminalAttachIs('PID 4'), { label: '自动 attach 存活的 PID 4' });
  await page.waitFor(dom.signalButtonsEnabled, { label: '存活进程的信号按钮恢复可用' });
}
