# AgentOS

**[English](README.md) | [中文](README.zh-CN.md)**

> 一切 Agent 皆为进程（Process）。把操作系统进程模型完整映射到 Agent 运行时。

Node.js + TypeScript 实现的多 Agent 运行时：统一 `Process` 抽象（主 Agent、SubAgent、用户皆为进程）、阻塞/异步执行、并发、fork（COW）、信号量同步、信号系统、管道通信、递归 spawn、模型参数化启动、checkpoint、supervisor、死锁检测、worker_threads 隔离、SQLite session 持久化、流式输出、用户中断（EINTR）、多模态输入、多供应商模型管理、REST + SSE live server、React 双语控制台。

![AgentOS 进程控制台](docs/images/console.png)

## 特性一览

- **完整进程模型**：init/spawn/fork/join/exec、信号（SIGTERM/SIGKILL/SIGSTOP/SIGCONT/SIGCHLD）、树链预算（rlimit）、进程内省（ps/readOutput/tap）
- **进程间通信**：管道（stream/batch/tool 三模式，背压 + EPIPE）、信号量/互斥锁/屏障（带 wait-for 死锁检测）、共享黑板（CAS KV）
- **健壮性**：checkpoint/restore、supervisor（one-for-one / one-for-all）、worker_threads 隔离、SQLite session 持久化（跨 runtime resume）
- **交互体验**：流式输出（同帧 id 合并）、thinking 落账、中断续聊（EINTR → ON_INBOX）、图片多模态注入
- **多模型供应商**：OpenAI 兼容协议 / Anthropic Messages API / DeepSeek 三种 provider，支持运行时动态注册、按模型路由；控制台可录入/删除供应商、切换默认模型
- **可视化控制台**：React 进程控制台（进程表、终端、事件流、管道拓扑），中英文一键切换；另有零依赖 CDP e2e 套件（20 条用例）守护 UI 行为

## 快速开始

```bash
npm install
npm test              # 内核全部单元 + 集成测试（MockLLM，无需 API Key）
npm run test:live     # DeepSeek 真实 API 冒烟（需要 .env 里的 OPENAI_API_KEY）
npm run typecheck
npm run lint          # ESLint
npm run format        # Prettier 格式化
npm run server        # Live server（REST + SSE，默认 :8787，需 OPENAI_API_KEY）
```

`.env`：

```
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.deepseek.com
```

## 60 秒上手

```ts
import { AgentRuntime, DeepSeekProvider } from './src/index';

const rt = new AgentRuntime({
  providers: [new DeepSeekProvider({ apiKey: process.env.OPENAI_API_KEY! })],
  defaults: { model: { model: 'deepseek-v4-pro', temperature: 0.7 } },
  models: { pro: 'deepseek-v4-pro', flash: 'deepseek-v4-flash' }, // 别名
  budget: { tokens: 500_000 }, // 全局预算（防 fork bomb 闸门之一）
  maxDepth: 4,
});

// PID 1：init 进程（无特权，只是默认 attach 点）
const init = rt.init({ task: '调研 Agent 运行时设计', model: { model: 'pro' } });

// 异步 spawn：可覆盖模型与推理参数
const child = init.spawn({ task: '子任务：查资料', model: { model: 'flash', maxTokens: 2000 } });

// 阻塞等待（也可 spawn({ mode: 'blocking' })）
const result = await child.join({ timeoutMs: 60_000 });
console.log(result.output, result.usage);

// 用户（PID 0）与任意进程交互（可附图片，多模态）
rt.user.attach(init.pid);
await rt.user.send(undefined, '补充一下：重点看进程模型', { priority: 'high' });
await rt.user.send(child.pid, '这张图里的架构怎么评价？', { images: [dataUrl] });

// 流式输出：stdout 上同一条消息的多帧共享 chunk.id，末帧 done=true
child.stdout.tap((c) => c.id && process.stdout.write((c.data as { text: string }).text));

// 中断（Codex Esc 语义）：停当前生成、保留部分输出、转 ON_INBOX 等下一条消息
child.interrupt();

// fork：COW 复制上下文，两个分支独立探索
const a = init.fork('走保守路线');
const b = init.fork('走激进路线');

// 管道：一个进程的 stdout 流入另一个进程的 stdin
rt.pipe(a.pid, b.pid, { mode: 'stream' });

// 信号量 / 互斥锁 / 屏障（带 wait-for 死锁检测）
const sem = rt.semaphore(3);
await sem.acquire(init.pid);
sem.release(init.pid);

// 信号
rt.signal(child.pid, 'SIGTERM'); // step 边界优雅退出
rt.signal(init.pid, 'SIGKILL'); // 级联强制终止整棵子树

// 内省
console.log(rt.ps()); // 进程树快照
console.log(rt.readOutput(init.pid, a.pid));

// checkpoint / restore
const snap = rt.checkpoint();
// rt2.restore(snap) -> SIGCONT 继续
```

## 多 LLM Provider 与模型管理

内置三种 provider：`OpenAIProvider`（通用 OpenAI Chat Completions 兼容协议，可接 OpenAI / Moonshot / vLLM / Ollama 等）、`AnthropicProvider`（Messages API，SSE 流式）、`DeepSeekProvider`（含 reasoning 支持）。每个进程可独立指定 `provider` + `model`：

```ts
import { AgentRuntime, OpenAIProvider, AnthropicProvider, DeepSeekProvider } from './src/index';

const rt = new AgentRuntime({
  providers: [
    new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY! }),
    new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! }),
    new DeepSeekProvider({ apiKey: process.env.OPENAI_API_KEY! }),
  ],
});

// 运行时动态注册供应商并绑定模型清单（resolveModel 按模型自动路由）
rt.registerProvider(new OpenAIProvider({ name: 'grok', apiKey: '...', baseUrl: 'https://api.x.ai/v1' }), {
  models: ['grok-3'],
});
rt.setDefaultModel('grok-3'); // 之后未显式指定模型的 spawn 都用它

// OpenAI 做规划
const planner = rt.init({ task: '...', model: { model: 'gpt-4o', provider: 'openai' } });
// DeepSeek 做执行
const executor = planner.spawn({
  task: '...',
  model: { model: 'deepseek-v4-pro', provider: 'deepseek' },
});
```

## Session 持久化（SQLite）

对齐 opencode 的 `session/message/part` 三表结构，扩展 `process` 表存进程树拓扑。支持跨 runtime 实例 resume——重启后恢复进程树状态、对话上下文、输出流。

```ts
import { AgentRuntime, SessionStore } from './src/index';

const store = new SessionStore('./agentos.db');
const rt = new AgentRuntime({ providers: [...], store });

// 新建 session 并自动持久化后续所有进程
const sid = rt.attachPersistence({ title: '调研会话' });

// ... 运行进程树 ...

// 跨 runtime 恢复：进程拓扑 + 对话上下文 + 预算
// 工具函数不可序列化，通过 toolRegistry 按 name 重新绑定
const rt2 = new AgentRuntime({ providers: [...], store });
rt2.resume(sid, { toolRegistry: new Map([['my_tool', myTool]]) });
```

表结构（WAL 模式）：

| 表        | 语义                              | 对齐             |
| --------- | --------------------------------- | ---------------- |
| `session` | 一次 Runtime 会话（含整棵进程树） | opencode session |
| `process` | 进程树拓扑与状态（AgentOS 特色）  | —                |
| `message` | 对话上下文 ChatMessage            | opencode message |
| `part`    | 输出流 OutputChunk                | opencode part    |

## 进程模型速查

| OS                              | AgentOS                                                             |
| ------------------------------- | ------------------------------------------------------------------- |
| init (PID 1)                    | 主 Agent，无特权的根进程                                            |
| 终端 (PID 0)                    | 用户，`attach` 即与目标进程建立通道                                 |
| spawn / exec                    | `spawn()` / `exec()`（复用 PID 换新任务）                           |
| fork()                          | `fork()` COW 上下文分支                                             |
| wait()                          | `join()` 回收 ExitResult                                            |
| rlimit                          | `Budget` 树链：token/turns/wallMs 按树扣减                          |
| SIGTERM/SIGKILL/SIGSTOP/SIGCONT | 同名信号；SIGCHLD 通知父进程                                        |
| Ctrl+C / EINTR                  | `interrupt()` 中断当前生成：部分输出落账、注入中断标记、转 ON_INBOX |
| 信号量/互斥锁/屏障              | `Semaphore` / `Mutex` / `Barrier` + wait-for 死锁检测               |
| pipe                            | `pipe(a,b)` stream/batch/tool 三模式，背压 + EPIPE                  |
| /proc                           | `ps()` / `descendants()` / `readOutput()` / `tap()`                 |
| checkpoint/restore              | `checkpoint()` / `restore()`                                        |
| supervisor (OTP)                | one-for-one / one-for-all + maxRestarts                             |
| 进程隔离                        | 同进程异步（默认）/ `isolation: 'worker'`                           |

## 前端控制台与 live server

`server/index.ts` 把运行时暴露为 REST + SSE，配合 `ui/` 目录的 React 控制台可视化操作：

```bash
OPENAI_API_KEY=sk-... npm run server    # 默认 :8787
```

| 端点                | 说明                                                                      |
| ------------------- | ------------------------------------------------------------------------- |
| GET /api/state      | 全量快照（ps + pipes + 各进程 stdout 历史）                               |
| GET /api/events     | SSE：state 变更 / output chunk 实时推送                                   |
| POST /api/spawn     | { ppid, task, name?, model?, budgetTokens? } -> { pid }                   |
| POST /api/fork      | { pid, hint? } -> { pid }                                                 |
| POST /api/signal    | { pid, sig }（SIGTERM/SIGKILL/SIGSTOP/SIGCONT）                           |
| POST /api/send      | { pid, text, images? }（用户 = PID 0 注入 stdin；images 为 dataURL 数组） |
| POST /api/interrupt | { pid }（中断当前生成，进程转 ON_INBOX）                                  |
| POST /api/pipe      | { fromPid, toPid, mode? }                                                 |

模型管理（注册表持久化在 `server/models.json`，含 apiKey，已 gitignore，勿提交）：

| 端点                        | 说明                                                                        |
| --------------------------- | --------------------------------------------------------------------------- |
| GET /api/models             | { providers（脱敏，无 apiKey）, defaultModel }                              |
| POST /api/providers         | { name, type: openai\|anthropic, apiKey, baseUrl?, models: "a,b" }          |
| DELETE /api/providers/:name | 删除供应商；默认模型随之消失时回退到剩余第一个模型                          |
| POST /api/default-model     | { model } 切换控制台默认模型（影响之后新 spawn 的进程，不影响运行中进程） |

启动时若无 `models.json`，用 `OPENAI_API_KEY` 播种 deepseek 供应商（pro + flash）并写回。

### React 控制台（`ui/`）

```bash
cd ui && npm install && npm run dev     # Vite 开发服务器
```

两种模式：

- **demo 模式**（默认）：AgentOS 内核直接在浏览器里跑（进程机制真实，大脑为脚本化 Mock），打开即演示
- **live 模式**：URL 加 `?server=http://localhost:8787` 连接 live server，真实模型驱动

功能：进程表树视图（PID/PPID/状态/模型/tokens）、终端（attach + stdin 注入 + 中断）、spawn 对话框、事件流、管道拓扑、**模型切换与管理**（顶栏下拉切换默认模型；「⚙ 模型」面板录入/删除供应商、点模型 chip 设默认）、**中英文切换**（顶栏语言按钮，localStorage 持久化）。

![英文界面](docs/images/console-en.png)

### UI e2e（零依赖 CDP 套件）

`ui/e2e/` 是不用 Playwright 的 e2e：Node 内置 CDP 直连系统 Chrome（headless），内置假 live server（REST + SSE + 模型管理端点 + 请求记录），逐条断言真实渲染行为。

```bash
cd ui && npm run test:e2e            # 20 条用例（dist 存在则复用）
cd ui && npm run test:e2e -- --build # 强制重建后跑
cd ui && npm run test:e2e -- --only 18  # 只跑文件名含 18 的用例
```

覆盖：流式去重/自动滚动、spawn/fork 自动 attach、信号生命周期、中断续聊、管道成环防护、操作失败可见性、SSE 断连横幅、用户消息回显、事件流钉底、模型管理与默认联动、中英文切换等。每条用例都经过变异验证（故意改坏实现，确认用例会失败）。

另有可视化 QA 脚本（真后端 + 真浏览器逐步截图）：`node e2e/qa-visual.mjs`、`node e2e/qa-models.mjs`、`node e2e/qa-i18n.mjs`。

## 里程碑与测试

| 里程碑       | 内容                                                                                                                                        | 测试                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| MVP          | 生命周期、spawn/join、模型参数化、预算、信号、用户交互、内省、工具白名单                                                                    | `tests/integration/mvp.test.ts`           |
| V2           | fork COW、同步原语、管道三模式、SIGCHLD、事件总线、checkpoint                                                                               | `tests/integration/v2.test.ts`            |
| V3           | 死锁检测、supervisor、blackboard、worker 隔离、exec                                                                                         | `tests/integration/v3.test.ts`            |
| V4 交互      | 流式帧按 id 合并、thinking 落账、中断全流程（EINTR->ON_INBOX->续聊）、ON_INBOX 可 SIGKILL、图片多模态消息                                   | `tests/unit/streaming.test.ts`            |
| 持久化       | SQLite session/message/part/process 四表、attach/resume/flush、跨 runtime 恢复、工具 registry 重建                                          | `tests/integration/persistence.test.ts`   |
| 多供应商     | OpenAI/Anthropic/DeepSeek 三 provider、运行时注册表、按模型路由                                                                             | `tests/unit/anthropic.test.ts`            |
| 冒烟         | DeepSeek v4 pro/flash 真实对话、混合 spawn、工具调用                                                                                        | `tests/integration/deepseek.live.test.ts` |
| 真实模型 E2E | 无 Mock：递归 spawn、预算三种终止、SIGKILL/SIGTERM、用户注入、管道复述、fork、信号量互斥、supervisor 重启、checkpoint 恢复、worker 真实对话 | `tests/integration/live.e2e.test.ts`      |
| 控制台 UI    | 零依赖 CDP e2e（真 Chrome 真渲染）                                                                                                          | `ui/e2e/tests/`（20 条）                  |

当前状态：**内核 vitest 116 项（96 项 Mock 全绿 + 4 冒烟 + 16 真实模型 E2E，live 测试无 Key 时 skip）；UI e2e 20/20 通过**。

## 文档

- [需求文档（PRD）](docs/PRD.md)
- [技术设计文档](docs/DESIGN.md)

## 结构

```
src/
├── types.ts / errors.ts / utils.ts
├── llm/         # LLMProvider：openai（通用兼容）/ anthropic（Messages API）/ deepseek / mock
├── core/        # Process(PCB+ReAct loop+流式+中断) / Runtime(内核+供应商注册表) / Budget(树链)
│                # builtin-tools(spawn_process 等系统调用) / supervisor / checkpoint / user(PID 0)
├── sync/        # Semaphore / Mutex / Barrier / WaitForGraph
├── ipc/         # StdinQueue(背压) / StdoutStream(环形缓冲+流式合并) / Pipe / Blackboard
├── store/       # SessionStore（SQLite：session/message/part/process 四表 + WAL）
└── worker/      # WorkerProcess + worker-entry.mjs（自包含 mini-runtime）
server/
├── index.ts     # REST + SSE live server（前端控制台后端）
└── models.ts    # 模型供应商注册表（models.json 持久化，含密钥勿提交）
ui/              # React + Vite + Tailwind 控制台（独立 package.json）
├── src/i18n.tsx # 中英文语言包 + Provider（顶栏切换，localStorage 持久化）
└── e2e/         # 零依赖 CDP e2e runner + 20 条用例 + 可视化 QA 脚本
```

注意：checkpoint 的内存快照保留工具引用；JSON 序列化快照会丢失工具函数（恢复后需重新注册）。SQLite 持久化同理——`resume` 时通过 `toolRegistry` 按 name 重新绑定工具。worker 内进程不能再 spawn 子进程（mini-runtime 无内核），也不参与 checkpoint/持久化。`ui/src/agentos/` 是内核的浏览器副本（`node:events` 走垫片，worker_threads 不可用），用于 demo 模式。
