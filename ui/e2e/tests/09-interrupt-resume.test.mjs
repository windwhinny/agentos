// 中断(EINTR)全流程:生成中点击 ⏹ 中断 → 进程转 ON_INBOX → 注入消息后续聊
// 覆盖:中断按钮仅在 ON_LLM 时可用、中断标记上屏、状态迁移、续聊响应
export const mode = 'demo';

export default async function run({ page, dom, assert, sleep }) {
  await page.waitFor(dom.rowStateIs('★ 1', 'done'), { label: 'init 进程完成' });

  // spawn 长时延任务(命中「调研员」剧本:2500ms 首 token 时延,留出中断窗口)
  assert.ok(await page.evalJs(dom.clickRow('★ 1')), '选中 PID 1');
  assert.ok(await page.evalJs(dom.clickButton('＋子进程')), '打开 spawn 对话框');
  await page.waitFor(dom.dialogVisible, { label: 'spawn 对话框出现' });
  assert.ok(await page.evalJs(dom.fillTextarea('调研 中断回归')), '填写任务');
  assert.ok(await page.evalJs(dom.clickButton('spawn')), '提交 spawn');
  await page.waitFor(dom.terminalAttachIs('PID 4'), { label: '自动 attach PID 4' });

  // 生成中(ON_LLM):中断按钮应可用
  await page.waitFor(dom.interruptEnabled, { label: '中断按钮可用' });
  assert.ok(await page.evalJs(dom.clickButton('⏹ 中断')), '点击中断');

  // 进程应转 ON_INBOX 等待输入,且中断标记上屏
  await page.waitFor(dom.rowStateIs(' 4', 'blocked:INBOX'), { label: 'PID 4 转 ON_INBOX', timeoutMs: 8000 });
  await page.waitFor(dom.terminalContains('生成被用户中断'), { label: '中断标记上屏' });

  // 注入消息续聊:应收到新的 assistant 响应(调研剧本的正式结论)
  assert.ok(await page.evalJs(dom.fillTerminalInput('补充一下:重点看配额')), '注入用户消息');
  assert.ok(await page.evalJs(dom.clickButton('发送')), '发送');
  await page.waitFor(dom.terminalContains('调研结论'), { label: '续聊响应到达', timeoutMs: 15000 });
  await sleep(300);
  // 续聊结论同样只渲染一次(与 01 的去重逻辑协同)
  assert.equal(await page.evalJs(dom.countInTerminal('调研结论：Agent')), 1, '续聊的最终消息应只出现一次');
}
