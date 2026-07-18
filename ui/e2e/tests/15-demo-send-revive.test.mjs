// Bug 回归:demo 模式向已退出进程发消息 → stdin 已关闭 → EPIPE,消息石沉大海
// (placeholder 还谎称「消息将滞留在 stdin」;live 模式服务端会 revive,demo 不会)
// 修复:浏览器内核补 revive()(与 node 内核一致),LocalDriver.send 先 revive 再 start
export const mode = 'demo';

export default async function run({ page, dom, assert }) {
  await page.waitFor(dom.rowStateIs('★ 1', 'done'), { label: 'init 进程已退出' });

  assert.ok(await page.evalJs(dom.fillTerminalInput('再聊聊进程模型')), '填写消息');
  assert.ok(await page.evalJs(dom.clickButton('发送')), '点击发送');

  // revive 后续聊:mock 应答「收到你的指令…」(init 已有工具消息,走用户注入分支)
  await page.waitFor(dom.terminalContains('收到你的指令'), { label: 'revive 后续聊应答' });
  assert.ok(!(await page.evalJs(dom.logsContain('EPIPE'))), '事件流不应出现 EPIPE');
  // 进程被唤醒过:事件流应记录 done → ready 的复活
  assert.ok(await page.evalJs(dom.logsContain('done → ready')), '事件流应记录进程复活');
}
