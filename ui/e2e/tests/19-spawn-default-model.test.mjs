// 功能:spawn 对话框与控制台默认模型联动(live 模式)
// 覆盖:spawn 对话框默认选中当前控制台默认模型 → 不改选择直接提交时请求体携带它
// 注意:假 server 跨用例共享,默认模型可能被 18 改成 flash —— 本用例不假设初始值,
//      读当前默认值做联动断言,任何初始状态下都成立。
export const mode = 'live';

export default async function run({ page, dom, assert, fake, sleep }) {
  // 等顶栏模型下拉加载(值非空即注册表已拉取)
  await page.waitFor(`(${dom.modelSelectValue}) !== null && (${dom.modelSelectValue}) !== ''`, { label: '顶栏模型下拉就绪' });
  const currentDefault = await page.evalJs(dom.modelSelectValue);
  assert.ok(currentDefault, '应存在当前默认模型');

  // spawn 对话框默认选中与控制台默认模型联动
  assert.ok(await page.evalJs(dom.clickRowIndex(0)), '选中 PID 1');
  assert.ok(await page.evalJs(dom.clickButton('＋子进程')), '打开 spawn 对话框');
  await page.waitFor(dom.dialogVisible, { label: 'spawn 对话框出现' });
  assert.equal(await page.evalJs(dom.spawnModelValue), currentDefault, `spawn 对话框应默认选中控制台默认模型 ${currentDefault}`);

  // 不改选择直接提交 → 请求体携带该默认模型
  const spawnCountBefore = fake.spawnRequests.length;
  assert.ok(await page.evalJs(dom.fillTextarea('e2e：spawn 默认模型联动')), '填写任务');
  assert.ok(await page.evalJs(dom.clickButton('spawn')), '提交 spawn');
  await sleep(500);
  assert.equal(fake.spawnRequests.length, spawnCountBefore + 1, '假 server 应新增 1 次 spawn 请求');
  const body = fake.spawnRequests[fake.spawnRequests.length - 1];
  assert.equal(body.model, currentDefault, `spawn 应携带当前默认模型(实际 ${body.model ?? '缺失'},期望 ${currentDefault})`);
}
