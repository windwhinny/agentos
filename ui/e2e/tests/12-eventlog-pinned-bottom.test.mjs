// Bug 回归:事件流只追加不滚动,新事件被压在可视区外,用户要手动往下翻
// 修复:BottomBar —— flex-col-reverse,滚动位置天然钉在底部,新事件始终可见
// 注意:事件流日志不含任务文本(spawn 日志为「spawn: PID X」),用 PID 序号做锚点 ——
// demo 初始 3 进程,5 轮 spawn 得 PID 4-8,最后 fork 得 PID 9,序号确定性成立
export const mode = 'demo';

export default async function run({ page, dom, assert, sleep }) {
  await page.waitFor(dom.rowStateIs('★ 1', 'done'), { label: 'init 进程完成' });

  // 连刷 5 个进程(PID 4-8),制造远超容器高度的事件量
  for (let i = 0; i < 5; i++) {
    assert.ok(await page.evalJs(dom.clickRow('★ 1')), `第 ${i + 1} 轮:选中 PID 1`);
    assert.ok(await page.evalJs(dom.clickButton('＋子进程')), '打开对话框');
    await page.waitFor(dom.dialogVisible, { label: '对话框出现' });
    assert.ok(await page.evalJs(dom.fillTextarea(`e2e 刷事件 ${i}`)), '填写任务');
    assert.ok(await page.evalJs(dom.clickButton('spawn')), '提交 spawn');
    await page.waitFor(dom.logsContain(`spawn: PID ${4 + i}`), { label: `第 ${i + 1} 轮 spawn 事件出现`, timeoutMs: 15000 });
  }

  // 钉底:最新 spawn 事件必须在可视区内 —— 修复前会被压到可视区外
  const visible = await page.evalJs(dom.newestLogVisible('spawn: PID 8'));
  assert.ok(visible === true, `最新事件应在事件流可视区内(实际: ${visible})`);

  // 手动上翻后,最新事件应离开可视区 —— 证明可视区装不下全部事件,上面的钉底断言不是白过的
  assert.ok(await page.evalJs(dom.logScrollTop), '事件流应可上翻(内容超出容器)');
  await sleep(200);
  const visibleAfterScroll = await page.evalJs(dom.newestLogVisible('spawn: PID 8'));
  assert.ok(visibleAfterScroll === false, `上翻后最新事件应离开可视区(实际: ${visibleAfterScroll})`);

  // 回到底部,再 fork 制造新事件:钉底应恢复,新事件立即可见
  await page.evalJs(dom.logScrollBottom);
  assert.ok(await page.evalJs(dom.clickRow('★ 1')), '选中 PID 1');
  assert.ok(await page.evalJs(dom.clickButton('fork')), '点击 fork(prompt 由 CDP 自动接受)');
  await page.waitFor(dom.logsContain('fork: PID 1 → 分支 PID 9'), { label: 'fork 事件出现' });
  const forkVisible = await page.evalJs(dom.newestLogVisible('分支 PID 9'));
  assert.ok(forkVisible === true, `fork 新事件应钉在可视区(实际: ${forkVisible})`);
}
