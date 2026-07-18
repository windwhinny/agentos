# AgentOS 控制台 e2e 测试

每个已发现的前端 bug 对应一条端到端用例,真实 Chrome(DevTools Protocol)驱动构建产物,零 npm 依赖(Node.js >= 22 内置 WebSocket/fetch + 系统 Chrome)。

## 运行

```bash
cd ui
npm run test:e2e              # dist 存在则直接使用,否则先构建
npm run test:e2e -- --build   # 强制重新构建 dist
npm run test:e2e -- --only 05 # 只跑文件名含 05 的用例
```

环境要求:Node.js >= 22、本机装有 Chrome/Chromium(找不到时设 `CHROME_PATH`)。headless 运行,不需要 API Key(demo 用例跑浏览器内核 + Mock 大脑;live 用例跑内置的假 live server)。

## 用例 ↔ bug 对照

| 用例 | 回归的 bug | 修复位置 |
| --- | --- | --- |
| `tests/01-terminal-result-dedupe.test.mjs` | 进程退出后最终消息在终端渲染两遍(assistant + result chunk 内容相同) | `src/components/Terminal.tsx` `dedupeResult` |
| `tests/02-pipe-cancel-toggle.test.mjs` | pipe→ 提示「再次点击取消」但点击无效 | `src/App.tsx` pipeSource 切换 |
| `tests/03-spawn-auto-attach.test.mjs` | spawn 后终端停留在父进程,看不到新进程输出 | `src/App.tsx` spawn/fork 后自动 select |
| `tests/04-stream-autoscroll.test.mjs` | 流式输出期间终端不自动滚到底(滚动依赖 `chunks.length`,同 id 覆盖时不变) | `src/components/Terminal.tsx` 滚动依赖 merged 数组 |
| `tests/05-remote-stream-merge.test.mjs` | live 模式 attach/重切进程后,终端被流式中间帧刷满(未按 `chunk.id` 合并) | `src/lib/remote-driver.ts` SSE 缓冲按 id 合并 |
| `tests/06-spawn-model-passthrough.test.mjs` | spawn 对话框的模型选择未透传(demo 驱动曾丢弃 `params.model`);同时断言 `budgetTokens` 透传 | `src/lib/local-driver.ts` / `remote-driver.ts` 参数透传契约 |
| `tests/07-fork-auto-attach.test.mjs` | fork 后终端不自动 attach 到新分支(window.prompt 由 CDP 自动接受) | `src/App.tsx` fork 后自动 select |
| `tests/08-signals-lifecycle.test.mjs` | 信号全流程回归:SIGSTOP→paused、SIGCONT→恢复、SIGTERM→done、SIGKILL 级联终止子树(用无限循环的写手剧本,任务文本含「摘要」进写手分支、不能含「调研结论」否则第一轮就退出) | 内核信号语义(step-boundary) |
| `tests/09-interrupt-resume.test.mjs` | 中断当前生成后进程应可继续对话(⏹ 中断 → 进程存活 → 再发消息有响应) | 中断后续聊语义 |
| `tests/10-pipe-cycle-guard.test.mjs` | UI 可造 A↔B 管道环,输出在环上无限循环;修复后建环被拒绝并落事件流 | `src/hooks/use-runtime.ts` `actions.pipe` 开放管道图 DFS 环守卫 |
| `tests/11-action-error-feedback.test.mjs` | 驱动层操作失败静默(unhandled rejection),用户无任何反馈;修复后失败落事件流(✗ 前缀,假 server 注入 500) | `src/hooks/use-runtime.ts` `guard` 包装所有 actions |
| `tests/12-eventlog-pinned-bottom.test.mjs` | 事件流只追加不滚动,新事件压在可视区外;修复后钉底、上翻可读历史、回底后新事件仍钉底 | `src/components/BottomBar.tsx` `flex-col-reverse` |
| `tests/13-sse-disconnect-banner.test.mjs` | live 模式 SSE 断开后页面静默停滞;修复后错误横幅提示、重连恢复清除(假 server 投毒 SSE,必须最后运行) | `src/lib/remote-driver.ts` `es.onerror`/`es.onopen` → `onError` |
| `tests/14-user-message-echo.test.mjs` | 用户发送的消息从不在终端渲染,对话只剩机器侧输出(可视化 QA 截图实证) | `src/hooks/use-runtime.ts` 发送回显 + `src/components/Terminal.tsx` 用户气泡 |
| `tests/15-demo-send-revive.test.mjs` | demo 模式向已退出进程发消息 → EPIPE 消息丢失(placeholder 谎称滞留 stdin;浏览器内核缺 `revive()`) | `src/agentos/core/process.ts` 补 `revive()` + `src/lib/local-driver.ts` send 对齐 server |
| `tests/16-signal-disabled-exited.test.mjs` | 对已退出进程点信号按钮静默无效,看起来「按钮坏了」 | `src/components/ProcessTable.tsx` 已退出禁用信号按钮 |
| `tests/17-eventlog-no-flapping.test.mjs` | 事件流被 blocked↔running 抖动刷屏(单次 demo 剧本 22 条),关键事件被淹没 | `src/hooks/use-runtime.ts` 状态 diff 跳过抖动 |

每条用例都做过变异验证(mutation check):临时回退对应修复,用例必然失败;恢复修复后通过。

## 结构

```
e2e/
├── run.mjs              # 运行器:构建 → 静态服务(:7199) → 假 live server(:8899) → headless Chrome → 逐条执行
├── qa-visual.mjs        # 可视化手工 QA:真后端(DeepSeek)+ 真 Chrome 逐步操作,每步截图到 artifacts/qa/
├── lib/
│   ├── cdp.mjs          # Chrome 启动 + DevTools Protocol 客户端(evalJs/waitFor/截图/控制台错误收集)
│   ├── dom.mjs          # 页面侧 DOM 探针(进程表/终端/对话框/管道提示/事件流——事件流容器走「事件流」标题定位,与实现类名解耦)
│   └── servers.mjs      # dist 静态服务 + 假 AgentOS live server(REST + SSE,可注入流式帧/500 错误/SSE 投毒)
├── tests/*.test.mjs     # 用例(导出 mode: 'demo' | 'live',默认导出 async run(ctx))
└── artifacts/           # 失败时自动截图(gitignore)
```

新用例:在 `tests/` 加 `NN-name.test.mjs`,`export const mode = 'demo' | 'live'`,默认导出 `async ({ page, dom, assert, fake, sleep }) => {}`。live 模式指向假 server,`fake.emit(pid, frames)` 注入流式 chunk,`fake.spawnRequests` 可读请求体,任务文本含 `__fail__` 触发 /api/spawn 500,`fake.poisonSse()` 让后续 /api/events 持续 503。fork 的 `window.prompt` 由 CDP 自动接受(promptText=`e2e分支提示`)。

页面 JS 异常 / `console.error` 会导致用例失败。
