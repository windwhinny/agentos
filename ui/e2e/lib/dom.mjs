// 页面侧 DOM 探针:所有表达式通过 CDP Runtime.evaluate 在页面里执行
// 终端滚动容器选择器:Terminal 组件的 stdout 区域(class 组合在本代码库中唯一)
const TERM = `document.querySelector('.flex-1.overflow-auto.px-3.py-2')`;

const q = (s) => JSON.stringify(s);

// 事件流滚动容器:「事件流」标题 div 的下一个兄弟节点(与实现类名解耦,见下方注释)
const LOG = `[...document.querySelectorAll('div')].find(d=>d.childElementCount===0&&d.textContent.trim()==='事件流')?.nextElementSibling`;

export const dom = {
  // —— 进程表 ——
  rowCount: `document.querySelectorAll('tbody tr').length`,
  rowCountIs: (n) => `document.querySelectorAll('tbody tr').length === ${n}`,
  rowsText: `(()=>[...document.querySelectorAll('tbody tr')].map(r=>r.textContent.replace(/\\s+/g,' ').trim()))()`,
  rowStateIs: (rowText, state) =>
    `(()=>{const r=[...document.querySelectorAll('tbody tr')].find(r=>r.textContent.includes(${q(rowText)}));return !!r && r.textContent.includes(${q(state)})})()`,
  clickRow: (text) =>
    `(()=>{const r=[...document.querySelectorAll('tbody tr')].find(r=>r.textContent.includes(${q(text)}));if(!r)return false;r.click();return true})()`,
  clickRowIndex: (i) =>
    `(()=>{const r=document.querySelectorAll('tbody tr')[${i}];if(!r)return false;r.click();return true})()`,

  // —— 按钮(按可见文本精确匹配) ——
  clickButton: (text) =>
    `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${q(text)});if(!b)return false;b.click();return true})()`,

  // —— spawn 对话框 ——
  dialogVisible: `!!document.querySelector('textarea')`,
  fillTextarea: (text) =>
    `(()=>{const el=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,${q(text)});el.dispatchEvent(new Event('input',{bubbles:true}));return true})()`,
  selectModel: (value) =>
    `(()=>{const el=document.querySelector('[data-testid=spawn-model-select]')||document.querySelector('dialog select, textarea')?.closest('div')?.querySelector('select');if(!el)return false;Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,${q(value)});el.dispatchEvent(new Event('change',{bubbles:true}));return el.value===${q(value)}})()`,

  // —— 终端 ——
  terminalText: `(()=>{const t=${TERM};return t?t.textContent.replace(/\\s+/g,' '):''})()`,
  terminalContains: (text) =>
    `(()=>{const t=${TERM};return !!t && t.textContent.replace(/\\s+/g,' ').includes(${q(text)})})()`,
  countInTerminal: (text) =>
    `(()=>{const t=${TERM};if(!t)return -1;const s=t.textContent.replace(/\\s+/g,' ');return s.split(${q(text)}).length-1})()`,
  terminalAttachIs: (pidText) =>
    `(()=>{const s=[...document.querySelectorAll('span')].find(s=>s.textContent.startsWith('终端 attach'));return !!s && s.textContent.includes(${q(pidText)})})()`,
  terminalStreaming: `(()=>{const t=${TERM};return !!t && t.textContent.includes('▍')})()`,
  terminalAtBottom: `(()=>{const t=${TERM};return !!t && (t.scrollHeight-t.scrollTop-t.clientHeight)<=2})()`,
  terminalCanScroll: `(()=>{const t=${TERM};return !!t && t.scrollHeight>t.clientHeight+10})()`,
  terminalScrollTop: `(()=>{const t=${TERM};t.scrollTop=0;return t.scrollTop===0})()`,
  terminalCapHeight: (px) =>
    `(()=>{const t=${TERM};t.style.maxHeight='${px}px';return true})()`,

  // —— pipe 提示 ——
  pipeTipVisible: `!!document.querySelector('.fixed.bottom-40')`,
  pipeTipText: `(()=>{const el=document.querySelector('.fixed.bottom-40');return el?el.textContent:''})()`,
  pipeLineCount: `(()=>{const p=document.querySelectorAll('.h-36 > div:last-child .space-y-1 > div');return p.length})()`,

  // —— 事件流(BottomBar) ——
  // 容器定位走「事件流」标题的兄弟节点,不依赖 flex-col-reverse 实现类名 ——
  // 否则探针与钉底修复耦合,破坏修复时测试会因找不到容器而失败,而不是败在钉底断言上
  logsText: `(()=>{const el=${LOG};return el?el.textContent.replace(/\\s+/g,' '):''})()`,
  logsContain: (text) =>
    `(()=>{const el=${LOG};return !!el && el.textContent.includes(${q(text)})})()`,
  // 最新一条事件是否在容器可视区内(column-reverse 下首个 DOM 子节点即视觉底部)
  newestLogVisible: (text) =>
    `(()=>{const el=${LOG};if(!el)return false;const item=[...el.children].find(c=>c.textContent.includes(${q(text)}));if(!item)return 'not-found';const r=item.getBoundingClientRect(),cr=el.getBoundingClientRect();return r.bottom<=cr.bottom+2 && r.top>=cr.top-2})()`,
  // 上翻/回底:column-reverse 下 scrollTop=0 即视觉底部,向上为负值
  logScrollTop: `(()=>{const el=${LOG};if(!el)return false;el.scrollTop=-el.scrollHeight;return el.scrollTop<0})()`,
  logScrollBottom: `(()=>{const el=${LOG};if(!el)return false;el.scrollTop=0;return true})()`,

  // —— 终端输入/按钮 ——
  interruptEnabled: `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('中断'));return b?!b.disabled:null})()`,
  fillTerminalInput: (text) =>
    `(()=>{const el=document.querySelector('form input:not([type=file])');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${q(text)});el.dispatchEvent(new Event('input',{bubbles:true}));return true})()`,
  fillBudget: (v) =>
    `(()=>{const el=document.querySelector('input[placeholder="如 50000"]');if(!el)return false;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${q(v)});el.dispatchEvent(new Event('input',{bubbles:true}));return true})()`,

  // —— 用户消息回显气泡 ——
  userBubbleWith: (text) =>
    `(()=>{const b=[...document.querySelectorAll('.user-msg')].find(d=>d.textContent.includes(${q(text)}));return !!b})()`,

  // —— 信号按钮(对已退出进程应禁用) ——
  signalButtonsDisabled: `(()=>{const bs=['⏸','▶','TERM','KILL'].map(t=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===t));return bs.every(b=>b&&b.disabled)})()`,
  signalButtonsEnabled: `(()=>{const bs=['⏸','▶','TERM','KILL'].map(t=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===t));return bs.every(b=>b&&!b.disabled)})()`,
  // 事件流里 blocked↔running 抖动条数(修复后应为 0)
  logFlapCount: `(()=>{const el=${LOG};if(!el)return -1;const m=el.textContent.match(/blocked → running|running → blocked/g);return m?m.length:0})()`,

  // —— 全局错误横幅 ——
  errorBannerText: `(()=>{const el=[...document.querySelectorAll('div')].find(d=>d.className.includes('bg-red-500/10'));return el?el.textContent:''})()`,

  // —— 状态栏 ——
  modeBadge: `(()=>{const b=[...document.querySelectorAll('.h-12 span')].find(s=>s.textContent.includes('LIVE')||s.textContent.includes('DEMO'));return b?b.textContent:''})()`,

  // —— 模型管理(testid 稳定锚点) ——
  modelSelectValue: `(()=>{const el=document.querySelector('[data-testid=model-select]');return el?el.value:null})()`,
  setModelSelect: (value) =>
    `(()=>{const el=document.querySelector('[data-testid=model-select]');if(!el)return false;Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,${q(value)});el.dispatchEvent(new Event('change',{bubbles:true}));return true})()`,
  modelSelectError: `(()=>{const el=document.querySelector('[data-testid=model-select-error]');return el?el.textContent:''})()`,
  clickModelManagerBtn: `(()=>{const b=document.querySelector('[data-testid=model-manager-btn]');if(!b)return false;b.click();return true})()`,
  modelManagerVisible: `!!document.querySelector('[data-testid=model-manager]')`,
  modelManagerText: `(()=>{const el=document.querySelector('[data-testid=model-manager]');return el?el.textContent.replace(/\\s+/g,' '):''})()`,
  modelManagerError: `(()=>{const el=document.querySelector('[data-testid=model-manager-error]');return el?el.textContent:''})()`,
  providerCardVisible: (name) => `!!document.querySelector('[data-testid=provider-card-${name}]')`,
  clickProviderDelete: (name) =>
    `(()=>{const b=document.querySelector('[data-testid=provider-delete-${name}]');if(!b)return false;b.click();return true})()`,
  clickModelChip: (model) =>
    `(()=>{const b=document.querySelector('[data-testid=model-chip-${model}]');if(!b)return false;b.click();return true})()`,
  fillProviderField: (testid, value) =>
    `(()=>{const el=document.querySelector('[data-testid=${testid}]');if(!el)return false;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${q(value)});el.dispatchEvent(new Event('input',{bubbles:true}));return true})()`,
  selectProviderType: (value) =>
    `(()=>{const el=document.querySelector('[data-testid=provider-type-select]');if(!el)return false;Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,${q(value)});el.dispatchEvent(new Event('change',{bubbles:true}));return el.value===${q(value)}})()`,
  clickProviderSubmit: `(()=>{const b=document.querySelector('[data-testid=provider-add-submit]');if(!b)return false;b.click();return true})()`,
  spawnModelValue: `(()=>{const el=document.querySelector('[data-testid=spawn-model-select]');return el?el.value:null})()`,
};
