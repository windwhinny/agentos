// Bug 回归:spawn 对话框选择的模型没有传到后端(LocalDriver 曾静默丢弃 params.model)
// 修复:local-driver.ts / remote-driver.ts —— model 透传
// 本测试在 live 模式下用假 server 断言 POST /api/spawn 请求体携带所选模型与父 PID
export const mode = 'live';

export default async function run({ page, dom, assert, fake, sleep }) {
  await page.waitFor(dom.rowCountIs(2), { label: '假 live server 初始状态就绪' });

  assert.ok(await page.evalJs(dom.clickRowIndex(0)), '选中 PID 1');
  assert.ok(await page.evalJs(dom.clickButton('＋子进程')), '打开 spawn 对话框');
  await page.waitFor(dom.dialogVisible, { label: 'spawn 对话框出现' });
  assert.ok(await page.evalJs(dom.fillTextarea('e2e：模型透传回归')), '填写任务');
  assert.ok(await page.evalJs(dom.selectModel('deepseek-v4-flash')), '选择 flash 模型');
  assert.ok(await page.evalJs(dom.fillBudget('50000')), '填写 token 预算');
  assert.ok(await page.evalJs(dom.clickButton('spawn')), '提交 spawn');

  await sleep(500); // 等 POST /api/spawn 到达假 server

  assert.equal(fake.spawnRequests.length, 1, `假 server 应收到 1 次 spawn 请求(实际 ${fake.spawnRequests.length})`);
  const body = fake.spawnRequests[0];
  assert.equal(body.ppid, 1, `spawn 父 PID 应为 1(实际 ${body.ppid})`);
  assert.equal(body.model, 'deepseek-v4-flash', `模型选择应透传到请求体(实际 ${body.model ?? '缺失'})`);
  assert.equal(body.task, 'e2e：模型透传回归', `任务文本应透传(实际 ${body.task})`);
  assert.equal(body.budgetTokens, 50000, `token 预算应透传(实际 ${body.budgetTokens ?? '缺失'})`);

  // spawn 后自动 attach 到新进程(与 03 互为印证,live 模式下同样成立)
  await page.waitFor(dom.terminalAttachIs('PID 3'), { label: '自动 attach 到 PID 3' });
}
