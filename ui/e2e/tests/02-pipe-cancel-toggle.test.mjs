// Bug 回归:pipe→ 提示「再次点击 pipe→ 取消」,但实际点击无效,提示不消失
// 根因:onAction('pipe') 无条件 setPipeSource(pid),同一进程重复点击状态不变
// 修复:App.tsx —— 同一进程再次点击 pipe→ 时切换为 null(取消)
export const mode = 'demo';

export default async function run({ page, dom, assert, sleep }) {
  await page.waitFor(dom.rowStateIs('★ 1', 'done'), { label: 'init 进程完成' });

  assert.ok(await page.evalJs(dom.clickRow('调研员')), '选中 PID 2');
  await page.waitFor(dom.terminalAttachIs('PID 2'), { label: 'attach 到 PID 2' });

  assert.ok(await page.evalJs(dom.clickButton('pipe→')), '第一次点击 pipe→');
  await sleep(300);
  assert.ok(await page.evalJs(dom.pipeTipVisible), '第一次点击后应出现管道源提示');
  const tip = await page.evalJs(dom.pipeTipText);
  assert.ok(tip.includes('PID 2'), `提示应标记管道源 PID 2(实际:「${tip}」)`);

  assert.ok(await page.evalJs(dom.clickButton('pipe→')), '再次点击 pipe→(应取消)');
  await sleep(300);
  assert.ok(!(await page.evalJs(dom.pipeTipVisible)), '再次点击同一进程 pipe→ 后提示应消失(取消)');
}
