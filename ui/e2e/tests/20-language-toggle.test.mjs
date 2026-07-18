// 功能:中英文语言切换(demo 模式)
// 覆盖:顶栏 lang-toggle 切换 → UI chrome 文案变英文(html lang 同步)
//      → 刷新后语言持久化(localStorage)→ 切回中文
// 注意:本用例结束必须切回中文 —— localStorage 在同源页面间共享,避免污染其他用例
export const mode = 'demo';

const clickLangToggle = `(()=>{const b=document.querySelector('[data-testid=lang-toggle]');if(!b)return false;b.click();return true})()`;
const htmlLang = `document.documentElement.lang`;
const bodyHas = (s) => `document.body.textContent.includes(${JSON.stringify(s)})`;

export default async function run({ page, dom, assert, sleep }) {
  // 1. 默认中文(无 localStorage 时为 zh)
  await page.waitFor(bodyHas('进程控制台'), { label: '默认中文界面就绪' });
  assert.equal(await page.evalJs(htmlLang), 'zh-CN', '默认 html lang 应为 zh-CN');

  // 2. 切到英文:多处 chrome 文案联动
  assert.ok(await page.evalJs(clickLangToggle), '点击语言切换按钮');
  await page.waitFor(bodyHas('Process Console'), { label: '切换为英文界面' });
  assert.equal(await page.evalJs(htmlLang), 'en', '切换后 html lang 应为 en');
  assert.ok(await page.evalJs(bodyHas('Event Stream')), '事件流标题应变英文');
  assert.ok(await page.evalJs(bodyHas('Process Table')), '进程表标题应变英文');
  assert.ok(!(await page.evalJs(bodyHas('进程控制台'))), '中文标题应消失');
  // 中文态下按钮文本是「＋子进程」,英文态应不再是
  const zhBtn = await page.evalJs(dom.clickButton('＋子进程'));
  assert.ok(!zhBtn, '英文态下不应存在中文 spawn 按钮');

  // 3. 刷新页面:localStorage 持久化,仍为英文
  await page.send('Page.reload', { ignoreCache: true });
  await sleep(1500);
  await page.waitFor(bodyHas('Process Console'), { label: '刷新后仍为英文' });
  assert.equal(await page.evalJs(htmlLang), 'en', '刷新后 html lang 应保持 en');

  // 4. 切回中文(收尾必须,防止污染同源其他用例)
  assert.ok(await page.evalJs(clickLangToggle), '再次点击切回中文');
  await page.waitFor(bodyHas('进程控制台'), { label: '切回中文界面' });
  assert.equal(await page.evalJs(htmlLang), 'zh-CN', '切回后 html lang 应为 zh-CN');
  assert.ok(await page.evalJs(bodyHas('事件流')), '事件流标题应恢复中文');
}
