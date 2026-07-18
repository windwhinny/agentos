// Bug 回归:事件流被 blocked↔running 抖动刷屏(每次 LLM 调用/工具执行都翻两三条),
// 真正的关键事件(创建/退出/暂停)被淹没,看起来「一堆重复的东西」
// 修复:use-runtime 状态 diff 跳过 blocked↔running 抖动,保留其余转换
export const mode = 'demo';

export default async function run({ page, dom, assert, sleep }) {
  // demo 剧本全程会产生大量 LLM/工具往返 —— 修复前事件流里必有抖动
  await page.waitFor(dom.rowStateIs('★ 1', 'done'), { label: 'init 进程完成' });
  await sleep(500);

  const flap = await page.evalJs(dom.logFlapCount);
  assert.ok(flap === 0, `事件流不应有 blocked↔running 抖动(实际 ${flap} 条)`);

  // 关键转换必须保留:创建、进入终态
  assert.ok(await page.evalJs(dom.logsContain('创建')), '创建日志应保留');
  assert.ok(await page.evalJs(dom.logsContain('done')), 'done 转换日志应保留');
}
