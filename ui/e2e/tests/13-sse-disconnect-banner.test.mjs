// Bug 回归:live 模式 SSE 断开后页面静默停滞,看起来一切正常但数据已不更新
// 修复:remote-driver —— EventSource onerror 上报错误横幅,onopen 恢复后清除
// 注意:本用例会投毒假 server 的 SSE(后续 /api/events 持续 503),必须最后运行
export const mode = 'live';

export default async function run({ page, dom, assert, fake }) {
  // 假 server 进程表跨用例残留(06/11 拉起过进程),只能断言至少 2 行
  await page.waitFor(`document.querySelectorAll('tbody tr').length >= 2`, { label: '假 live server 就绪' });
  assert.equal(await page.evalJs(dom.errorBannerText), '', '初始不应有错误横幅');

  // 模拟 backend 挂掉:摧毁 SSE 连接,后续重连也 503
  fake.poisonSse();

  // 横幅应出现并说明 SSE 断开
  await page.waitFor(
    `(()=>{const el=[...document.querySelectorAll('div')].find(d=>d.className.includes('bg-red-500/10'));return !!el && el.textContent.includes('SSE')})()`,
    { label: 'SSE 断开横幅出现', timeoutMs: 10000 },
  );
  const banner = await page.evalJs(dom.errorBannerText);
  assert.ok(banner.includes('SSE 实时通道断开'), `横幅应说明 SSE 断开(实际:「${banner}」)`);
}
