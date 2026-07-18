// Bug 回归:驱动层操作失败静默(unhandled promise rejection),用户看不到任何反馈
// 修复:use-runtime —— 所有 actions 经 guard 包装,失败落入事件流(✗ 前缀)
// 本测试用假 server 对 /api/spawn 注入 500,断言错误出现在事件流
export const mode = 'live';

export default async function run({ page, dom, assert, sleep }) {
  // 假 server 进程表跨用例残留(06 拉起过进程),只能断言至少 2 行
  await page.waitFor(`document.querySelectorAll('tbody tr').length >= 2`, { label: '假 live server 就绪' });

  assert.ok(await page.evalJs(dom.clickRowIndex(0)), '选中 PID 1');
  assert.ok(await page.evalJs(dom.clickButton('＋子进程')), '打开 spawn 对话框');
  await page.waitFor(dom.dialogVisible, { label: 'spawn 对话框出现' });
  // __fail__ 触发假 server 返回 500
  assert.ok(await page.evalJs(dom.fillTextarea('__fail__ 注入失败')), '填写触发失败的任务');
  assert.ok(await page.evalJs(dom.clickButton('spawn')), '提交 spawn');
  await sleep(600);

  assert.ok(await page.evalJs(dom.logsContain('✗ spawn 失败')), '事件流应出现 ✗ spawn 失败');
  assert.ok(await page.evalJs(dom.logsContain('spawn exploded')), '事件流应包含后端错误详情');
}
