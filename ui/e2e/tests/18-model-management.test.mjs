// 功能:模型管理面板(live 模式)
// 覆盖:顶栏默认模型显示 → 管理面板录入 openai 供应商(断言假 server 收到正确 POST 体)
//      → 点 chip 设默认(断言 /api/default-model 请求 + 顶栏联动)
//      → 删除供应商(默认模型回退 + DELETE 请求)
export const mode = 'live';

export default async function run({ page, dom, assert, fake, sleep }) {
  // 假 server 跨用例共享:不断言进程行数,直接等模型下拉(本用例的真正前提)
  // 1. 顶栏模型下拉已加载,当前默认 deepseek-v4-pro
  await page.waitFor(`(${dom.modelSelectValue}) === 'deepseek-v4-pro'`, { label: '顶栏模型下拉就绪,默认 deepseek-v4-pro' });

  // 2. 打开管理面板:初始只有 deepseek 供应商
  assert.ok(await page.evalJs(dom.clickModelManagerBtn), '点击「⚙ 模型」按钮');
  await page.waitFor(dom.modelManagerVisible, { label: '模型管理面板出现' });
  assert.ok(await page.evalJs(dom.providerCardVisible('deepseek')), '面板中应列出 deepseek 供应商');

  // 3. 录入 openai 供应商
  assert.ok(await page.evalJs(dom.fillProviderField('provider-name-input', 'gpt-test')), '填写供应商名');
  assert.ok(await page.evalJs(dom.selectProviderType('openai')), '选择 openai 类型');
  assert.ok(await page.evalJs(dom.fillProviderField('provider-baseurl-input', 'https://api.openai.com/v1')), '填写 baseUrl');
  assert.ok(await page.evalJs(dom.fillProviderField('provider-apikey-input', 'sk-e2e-fake')), '填写 apiKey');
  assert.ok(await page.evalJs(dom.fillProviderField('provider-models-input', 'gpt-4o, gpt-4o-mini')), '填写模型列表');
  assert.ok(await page.evalJs(dom.clickProviderSubmit), '提交录入表单');

  await page.waitFor(dom.providerCardVisible('gpt-test'), { label: '新供应商卡片出现' });
  await sleep(300); // 等 POST 到达假 server

  const addReq = fake.modelRequests.find((r) => r.path === '/api/providers');
  assert.ok(addReq, '假 server 应收到 POST /api/providers');
  assert.equal(addReq.body.name, 'gpt-test', `供应商名透传(实际 ${addReq.body.name})`);
  assert.equal(addReq.body.type, 'openai', `类型透传(实际 ${addReq.body.type})`);
  assert.equal(addReq.body.apiKey, 'sk-e2e-fake', `apiKey 应发给 server(实际 ${addReq.body.apiKey ?? '缺失'})`);
  assert.equal(addReq.body.baseUrl, 'https://api.openai.com/v1', `baseUrl 透传(实际 ${addReq.body.baseUrl ?? '缺失'})`);
  assert.equal(addReq.body.models, 'gpt-4o,gpt-4o-mini', `模型列表以逗号字符串透传(实际 ${addReq.body.models})`);

  // 4. 点 gpt-4o chip 设为默认 → 顶栏联动 + server 收到请求
  assert.ok(await page.evalJs(dom.clickModelChip('gpt-4o')), '点击 gpt-4o chip 设为默认');
  await page.waitFor(`(${dom.modelSelectValue}) === 'gpt-4o'`, { label: '顶栏默认模型切换为 gpt-4o' });
  const defReq = fake.modelRequests.find((r) => r.path === '/api/default-model');
  assert.ok(defReq, '假 server 应收到 POST /api/default-model');
  assert.equal(defReq.body.model, 'gpt-4o', `默认模型请求体(实际 ${defReq.body.model})`);

  // 5. 顶栏下拉直接切回 deepseek-v4-flash
  assert.ok(await page.evalJs(dom.setModelSelect('deepseek-v4-flash')), '顶栏下拉切到 flash');
  await page.waitFor(`(${dom.modelSelectValue}) === 'deepseek-v4-flash'`, { label: '顶栏默认模型为 flash' });

  // 6. 删除 gpt-test 供应商 → 卡片消失,默认不受影响(flash 属于 deepseek)
  assert.ok(await page.evalJs(dom.clickProviderDelete('gpt-test')), '删除 gpt-test 供应商');
  await page.waitFor(`!(${dom.providerCardVisible('gpt-test')})`, { label: 'gpt-test 卡片消失' });
  const delReq = fake.modelRequests.find((r) => r.method === 'DELETE');
  assert.ok(delReq && delReq.path === '/api/providers/gpt-test', `假 server 应收到 DELETE /api/providers/gpt-test(实际 ${delReq?.path})`);
  assert.equal(await page.evalJs(dom.modelSelectValue), 'deepseek-v4-flash', '删除后默认模型仍为 flash');

  // 7. 面板错误可见性:录入重名供应商 → 红字报错
  assert.ok(await page.evalJs(dom.fillProviderField('provider-name-input', 'deepseek')), '填写重名供应商');
  assert.ok(await page.evalJs(dom.fillProviderField('provider-apikey-input', 'sk-x')), '填写 apiKey');
  assert.ok(await page.evalJs(dom.fillProviderField('provider-models-input', 'm1')), '填写模型');
  assert.ok(await page.evalJs(dom.clickProviderSubmit), '提交重名录入');
  await page.waitFor(`(${dom.modelManagerError}).length > 0`, { label: '面板出现错误红字' });
}
