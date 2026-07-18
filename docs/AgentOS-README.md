# AgentOS

> 一切 Agent 皆为进程（Process）。把操作系统进程模型完整映射到 Agent 运行时。

Node.js + TypeScript 实现的多 Agent 运行时：统一 `Process` 抽象（主 Agent、SubAgent、用户皆为进程）、阻塞/异步执行、并发、fork（COW）、信号量同步、信号系统、管道通信、递归 spawn、模型参数化启动、checkpoint、supervisor、死锁检测、worker_threads 隔离。

## 快速开始

```bash
npm install
npm test              # 全部单元 + 集成测试（MockLLM，无需 API Key）
npm run test:live     # DeepSeek 真实 API 冒烟（需要 .env 里的 DEEPSEEK_API_KEY）
npm run typecheck
```

`.env`：

```
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_BASE_URL=https://api.deepseek.com
```

## 60 秒上手

```ts
import { AgentRuntime, DeepSeekProvider } from './src/index';

const rt = new AgentRuntime({
  providers: [new DeepSeekProvider({ apiKey: process.env.DEEPSEEK_API_KEY! })],
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

// 用户（PID 0）与任意进程交互
rt.user.attach(init.pid);
await rt.user.send(undefined, '补充一下：重点看进程模型', { priority: 'high' });

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
// rt2.restore(snap) → SIGCONT 继续
```

## 进程模型速查

| OS                              | AgentOS                                               |
| ------------------------------- | ----------------------------------------------------- |
| init (PID 1)                    | 主 Agent，无特权的根进程                              |
| 终端 (PID 0)                    | 用户，`attach` 即与目标进程建立通道                   |
| spawn / exec                    | `spawn()` / `exec()`（复用 PID 换新任务）             |
| fork()                          | `fork()` COW 上下文分支                               |
| wait()                          | `join()` 回收 ExitResult                              |
| rlimit                          | `Budget` 树链：token/turns/wallMs 按树扣减            |
| SIGTERM/SIGKILL/SIGSTOP/SIGCONT | 同名信号；SIGCHLD 通知父进程                          |
| 信号量/互斥锁/屏障              | `Semaphore` / `Mutex` / `Barrier` + wait-for 死锁检测 |
| pipe                            | `pipe(a,b)` stream/batch/tool 三模式，背压 + EPIPE    |
| /proc                           | `ps()` / `descendants()` / `readOutput()` / `tap()`   |
| checkpoint/restore              | `checkpoint()` / `restore()`                          |
| supervisor (OTP)                | one-for-one / one-for-all + maxRestarts               |
| 进程隔离                        | 同进程异步（默认）/ `isolation: 'worker'`             |

## 里程碑与测试

| 里程碑 | 内容                                                                     | 测试                                      |
| ------ | ------------------------------------------------------------------------ | ----------------------------------------- |
| MVP    | 生命周期、spawn/join、模型参数化、预算、信号、用户交互、内省、工具白名单 | `tests/integration/mvp.test.ts`           |
| V2     | fork COW、同步原语、管道三模式、SIGCHLD、事件总线、checkpoint            | `tests/integration/v2.test.ts`            |
| V3     | 死锁检测、supervisor、blackboard、worker 隔离、exec                      | `tests/integration/v3.test.ts`            |
| 冒烟   | DeepSeek v4 pro/flash 真实对话、混合 spawn、工具调用                     | `tests/integration/deepseek.live.test.ts` |

当前状态：**66 单元/集成测试 + 4 冒烟测试全部通过**。

## 文档

- [需求文档（PRD）](docs/PRD.md)
- [技术设计文档](docs/DESIGN.md)

## 结构

```
src/
├── types.ts / errors.ts / utils.ts
├── llm/         # LLMProvider：deepseek（OpenAI 兼容）/ mock（脚本化）
├── core/        # Process(PCB+ReAct loop) / Runtime(内核) / Budget(树链)
│                # builtin-tools(spawn_process 等系统调用) / supervisor / checkpoint / user(PID 0)
├── sync/        # Semaphore / Mutex / Barrier / WaitForGraph
├── ipc/         # StdinQueue(背压) / StdoutStream(环形缓冲) / Pipe / Blackboard
└── worker/      # WorkerProcess + worker-entry.mjs（自包含 mini-runtime）
```

注意：checkpoint 的内存快照保留工具引用；JSON 序列化快照会丢失工具函数（恢复后需重新注册）。worker 内进程不能再 spawn 子进程（mini-runtime 无内核），也不参与 checkpoint。
