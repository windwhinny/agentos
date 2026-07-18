// Bug 回归:fork 后终端不自动 attach 到新分支(与 spawn 同类)
// 修复:App.tsx —— fork 成功后自动 select 分支 PID
// 注:fork 会触发 window.prompt 输入分支提示,e2e 通过 CDP 自动接受
export const mode = 'demo';

export default async function run({ page, dom, assert }) {
  await page.waitFor(dom.rowStateIs('★ 1', 'done'), { label: 'init 进程完成' });

  assert.ok(await page.evalJs(dom.clickRow('★ 1')), '选中 PID 1');
  assert.ok(await page.evalJs(dom.clickButton('fork')), '点击 fork(prompt 由 CDP 自动接受)');

  await page.waitFor(dom.rowCountIs(4), { label: '进程表出现分支 PID 4' });
  await page.waitFor(dom.terminalAttachIs('PID 4'), { label: '终端自动 attach 到分支 PID 4' });
  assert.ok(await page.evalJs(dom.logsContain('fork: PID 1 → 分支 PID 4')), '事件流应记录 fork');
}
