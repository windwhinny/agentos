// Bug 回归:流式输出期间终端不自动滚到底部
// 根因:Terminal 滚动副作用依赖 chunks.length,而流式帧按 id 覆盖、length 不变 → 滚动不触发
// 修复:Terminal —— 依赖 merged 后的 visible 数组(每次帧更新都是新引用),帧帧滚到底
export const mode = 'demo';

export default async function run({ page, dom, assert, sleep }) {
  await page.waitFor(dom.rowStateIs('★ 1', 'done'), { label: 'init 进程完成' });

  // spawn 一个长输出任务(命中「调研员」剧本:2500ms 首 token 时延 + 24 帧流式)
  assert.ok(await page.evalJs(dom.clickRow('★ 1')), '选中 PID 1');
  assert.ok(await page.evalJs(dom.clickButton('＋子进程')), '打开 spawn 对话框');
  await page.waitFor(dom.dialogVisible, { label: 'spawn 对话框出现' });
  assert.ok(await page.evalJs(dom.fillTextarea('调研 自动滚动回归')), '填写任务');
  assert.ok(await page.evalJs(dom.clickButton('spawn')), '提交 spawn');

  // 自动 attach 到新进程;把终端容器压扁,确保内容必然溢出可滚动
  await page.waitFor(dom.terminalAttachIs('PID 4'), { label: '自动 attach 到 PID 4' });
  await page.evalJs(dom.terminalCapHeight(90));

  // 等流式开始(出现 ▍ 光标),且确认内容已可滚动
  await page.waitFor(dom.terminalStreaming, { label: '流式输出开始', timeoutMs: 15000 });
  await page.waitFor(dom.terminalCanScroll, { label: '内容溢出可滚动' });

  // 关键断言:手动滚回顶部后,后续流式帧到达时应被重新拉回底部
  // (修复前:length 不变 → 不滚 → 停在顶部;且此刻进程尚未 done,done 帧的 length 变化还没发生)
  assert.ok(await page.evalJs(dom.terminalScrollTop), '已手动滚到顶部');
  await sleep(500); // 40ms/帧 × ~12 帧,仍处于流式窗口内
  assert.ok(!(await page.evalJs(dom.rowStateIs(' 4', 'done'))), '断言时进程仍在运行(排除 done 帧干扰)');
  assert.ok(await page.evalJs(dom.terminalAtBottom), '流式帧持续到达时终端应始终钉在底部');

  // 完成后也应停在底部
  await page.waitFor(dom.rowStateIs(' 4', 'done'), { label: 'PID 4 完成' });
  await sleep(200);
  assert.ok(await page.evalJs(dom.terminalAtBottom), '进程完成后终端应停在底部');
}
