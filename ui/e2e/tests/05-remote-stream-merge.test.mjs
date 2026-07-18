// Bug 回归(live 模式主 bug):切换/重新 attach 进程后,终端被流式中间帧刷满
// 根因:RemoteDriver 对 SSE output 事件只做 raw append,不按 chunk.id 合并;
//       select() 时 driver.output(pid) 把每一帧中间态原样塞给 React,merge 只覆盖首个匹配项,残留全量中间帧
// 修复:remote-driver.ts —— SSE 写入缓冲时即按 chunk.id 合并
// 本测试用假 live server 模拟:attach 前缓冲一组共享 id 的流式帧,attach 后应只见一条合并消息
export const mode = 'live';

export default async function run({ page, dom, assert, fake, sleep }) {
  // 初始:PID 1(done,干净历史) + PID 2(blocked:LLM,无输出);默认选中 PID 1
  await page.waitFor(dom.rowCountIs(2), { label: '假 live server 初始状态就绪' });
  await page.waitFor(dom.terminalAttachIs('PID 1'), { label: '默认 attach PID 1' });

  // 用户未盯屏期间,PID 2 在后台流式输出(4 帧共享 id=m1,末帧 done=true)
  await fake.emit(2, [
    { type: 'assistant', id: 'm1', data: { text: '', thinking: '思' }, done: false, ts: 1 },
    { type: 'assistant', id: 'm1', data: { text: '你', thinking: '思考中' }, done: false, ts: 2 },
    { type: 'assistant', id: 'm1', data: { text: '你好', thinking: '思考中' }, done: false, ts: 3 },
    { type: 'assistant', id: 'm1', data: { text: '你好,世界', thinking: '思考完成' }, done: true, ts: 4 },
  ]);
  await sleep(300);

  // 此刻才 attach PID 2(修复前:select() 拉回 raw 帧列表,终端刷满「思考中…」中间帧)
  assert.ok(await page.evalJs(dom.clickRowIndex(1)), 'attach PID 2');
  await page.waitFor(dom.terminalContains('你好,世界'), { label: '终帧文本出现' });
  await sleep(300);

  const stale = await page.evalJs(dom.countInTerminal('思考中…'));
  assert.equal(stale, 0, `不应残留流式中间帧(「思考中…」出现 ${stale} 次)`);
  const merged = await page.evalJs(dom.countInTerminal('你好,世界'));
  assert.equal(merged, 1, `合并后的 assistant 消息只应出现一次(实际 ${merged} 次)`);
  const thinkingBlocks = await page.evalJs(dom.countInTerminal('思考过程'));
  assert.equal(thinkingBlocks, 1, `思考块应只有一个(实际 ${thinkingBlocks} 个)`);

  // attach 后继续流式:也应原位更新,不追加中间帧
  await fake.emit(2, [
    { type: 'assistant', id: 'm2', data: { text: '第二', thinking: '' }, done: false, ts: 5 },
    { type: 'assistant', id: 'm2', data: { text: '第二句完成', thinking: '' }, done: true, ts: 6 },
  ]);
  await page.waitFor(dom.terminalContains('第二句完成'), { label: '第二条消息终帧' });
  await sleep(200);
  assert.equal(await page.evalJs(dom.countInTerminal('第二句完成')), 1, '第二条消息只应出现一次');
  assert.equal(await page.evalJs(dom.countInTerminal('▍')), 0, 'done 后不应残留流式光标');
}
