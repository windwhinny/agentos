// Bug 回归:用户发送的消息从不在终端渲染,对话只剩机器侧输出
// (可视化 QA 截图实证:发完消息终端里找不到自己说过的话)
// 修复:use-runtime 发送成功后注入 user 回显 chunk,Terminal 渲染右对齐用户气泡
export const mode = 'demo';

export default async function run({ page, dom, assert }) {
  await page.waitFor(dom.rowStateIs('★ 1', 'done'), { label: 'init 进程完成' });

  assert.ok(await page.evalJs(dom.fillTerminalInput('qa 回显探针消息')), '填写消息');
  assert.ok(await page.evalJs(dom.clickButton('发送')), '点击发送');

  await page.waitFor(dom.userBubbleWith('qa 回显探针消息'), { label: '用户气泡出现' });
  // 气泡应在终端滚动容器内,而不是事件流里
  assert.ok(await page.evalJs(dom.terminalContains('qa 回显探针消息')), '终端内可见用户消息');
}
