// Bug 回归:进程退出后,最终消息在终端被渲染两遍
// 根因:内核退出时除最后一条 assistant chunk 外还会写一条内容相同的 result chunk,UI 两者都渲染
// 修复:Terminal dedupeResult —— result 与前一条 assistant 文本相同则跳过
export const mode = 'demo';

export default async function run({ page, dom, assert }) {
  // 等 demo 剧本跑完(init 完成)
  await page.waitFor(dom.rowStateIs('★ 1', 'done'), { label: 'init 进程完成' });

  // 默认 attach 的就是 PID 1:最终消息(assistant)与 result 内容相同,只应出现一次
  const n = await page.evalJs(dom.countInTerminal('调研 → 写作流水线已完成'));
  assert.equal(n, 1, `PID 1 最终消息在终端出现 ${n} 次(应为 1 次:assistant + result 去重)`);

  // attach 调研员,其结论同样只应出现一次
  assert.ok(await page.evalJs(dom.clickRow('调研员')), '点击调研员行');
  await page.waitFor(dom.terminalAttachIs('PID 2'), { label: 'attach 到 PID 2' });
  const m = await page.evalJs(dom.countInTerminal('调研结论：Agent'));
  assert.equal(m, 1, `PID 2 调研结论在终端出现 ${m} 次(应为 1 次)`);
}
