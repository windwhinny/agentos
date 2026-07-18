// Bug 回归:UI 允许创建管道环(A→B、B→A),进程输出会在环上无限循环(内核无环检测)
// 修复:use-runtime actions.pipe —— 建管前 DFS 检查开放管道图,成环则拒绝并记录事件
export const mode = 'demo';

export default async function run({ page, dom, assert, sleep }) {
  await page.waitFor(dom.rowStateIs('★ 1', 'done'), { label: 'init 进程完成' });

  // 剧本管道 2→3 已关闭,先建一条开放的 2→3
  assert.ok(await page.evalJs(dom.clickRow('调研员')), '选中 PID 2');
  assert.ok(await page.evalJs(dom.clickButton('pipe→')), '设管道源 PID 2');
  assert.ok(await page.evalJs(dom.clickRow('写手')), '点目标 PID 3,建立 2→3');
  await sleep(400);
  assert.ok(await page.evalJs(dom.logsContain('pipe: PID 2 → PID 3')), '2→3 应建立成功');

  // 再尝试 3→2:会形成环,应被拒绝
  assert.ok(await page.evalJs(dom.clickRow('写手')), '选中 PID 3');
  assert.ok(await page.evalJs(dom.clickButton('pipe→')), '设管道源 PID 3');
  assert.ok(await page.evalJs(dom.clickRow('调研员')), '点目标 PID 2,尝试 3→2(成环)');
  await sleep(400);
  assert.ok(await page.evalJs(dom.logsContain('会形成管道环')), '事件流应记录环拒绝原因');

  // 管道拓扑面板:开放管道应只有 2→3 一条(3→2 未建立)
  const openPipes = await page.evalJs(
    `(()=>{const p=[...document.querySelectorAll('.h-36 > div:last-child .space-y-1 > div')];return p.map(x=>x.textContent).filter(t=>t.includes('open'))})()`,
  );
  assert.equal(openPipes.length, 1, `开放管道应只有 2→3 一条(实际 ${openPipes.length}: ${openPipes.join(' / ')})`);
}
