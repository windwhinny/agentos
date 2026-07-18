# AgentOS 技术设计文档

- 版本：v1.0（对应 PRD v1.0）
- 日期：2026-07-17

---

## 1. 总体架构

```
┌──────────────────────────────────────────────────────┐
│ 用户接口层  UserAPI (PID 0): attach/detach/send/tap   │
├──────────────────────────────────────────────────────┤
│ 内核层      AgentRuntime: 进程表 / PID 分配 / 调度     │
│             ps / pipe 拓扑 / 事件总线 / checkpoint     │
├──────────────────────────────────────────────────────┤
│ 进程层      Process: 状态机 + ReAct loop + stdio       │
│             spawn / fork / exec / join / signal        │
├──────────────────────────────────────────────────────┤
│ 同步层      Semaphore / Mutex / Barrier + wait-for 图  │
├──────────────────────────────────────────────────────┤
│ IPC 层      StdinQueue / StdoutStream / Pipe / 黑板    │
├──────────────────────────────────────────────────────┤
│ 资源层      Budget(树链) / AbortController 取消链      │
├──────────────────────────────────────────────────────┤
│ 模型层      LLMProvider: deepseek / mock (可注册)      │
├──────────────────────────────────────────────────────┤
│ 隔离层      同进程异步(默认) / worker_threads(V3)      │
└──────────────────────────────────────────────────────┘
```

设计要点：

1. **单内核多进程**：Node 单线程事件循环天然适合 LLM 这种 IO 密集型并发——所有"逻辑进程"是同一线程上的异步任务，调度器即事件循环本身，不存在真正的上下文切换开销
2. **一切皆 Process**：用户（PID 0）、init（PID 1）、subagent 走同一份代码；UserAPI 只是 PID 0 的适配器
3. **不可变消息序列**：对话消息一旦产生即不可变，fork 只做数组浅拷贝，实现 O(1) COW
4. **取消即信号**：AbortController 树与进程树同构，SIGKILL = abort()，SIGTERM = 置标志位在 step 边界检查

## 2. 核心数据结构

### 2.1 Process（PCB）

```ts
interface ProcessConfig {
  task: string; // 任务描述（首条 user 消息）
  systemPrompt?: string; // 人格定义
  tools?: Tool[]; // 工具白名单（必须 ⊆ 父进程）
  model?: ModelConfig; // 模型与推理参数（见 2.3）
  budget?: Partial<BudgetQuota>; // token / 轮次 / 时限配额
  name?: string; // 人类可读名（可重名）
  mode?: 'async' | 'blocking'; // spawn 语义
  isolation?: 'inproc' | 'worker'; // 执行载体
  supervision?: SupervisionSpec; // 重启策略
  pipeIn?: PipeEndpoint[]; // 入向管道
}

type ProcessState =
  | 'created'
  | 'ready'
  | 'running'
  | 'blocked' // + blockedReason
  | 'paused' // SIGSTOP
  | 'done'
  | 'failed'
  | 'killed';

type BlockedReason = 'ON_LLM' | 'ON_TOOL' | 'ON_CHILD' | 'ON_SEM' | 'ON_PIPE' | 'ON_INBOX';
```

PCB 字段：`pid / ppid / name / state / blockedReason / children:Set<pid> / context / modelConfig / budget / usage / abort / stdio / depth / createdAt / exitResult`

### 2.2 上下文（Context）

```ts
interface Context {
  messages: ChatMessage[]; // 不可变消息序列；push 前判 shared 标记
  shared: boolean; // fork 后为 true，写时先 slice（COW）
}
```

消息追加统一走 `appendMessage(msg)`：`if (shared) { messages = messages.slice(); shared = false }`，消息对象本身永不修改（Object.freeze）。

### 2.3 模型配置（三级继承）

```ts
interface ModelConfig {
  model?: string; // 'deepseek-v4-pro' | 'deepseek-v4-flash' | 别名
  provider?: string; // 'deepseek' | 'mock' | 自定义
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}
```

解析顺序：进程显式配置 → 父进程配置 → runtime 默认配置。runtime 内置别名表 `{ pro: 'deepseek-v4-pro', flash: 'deepseek-v4-flash' }`。

## 3. 进程运行循环（ReAct loop）

```
async run():
  state = running
  while true:
    await stepBoundary():       # step 边界
      - abort 置位?  → throw KillExit(SIGKILL)
      - SIGTERM 置位? → 优雅退出(reason=SIGTERM, 结果=部分产出)
      - SIGSTOP 置位? → state=paused, 等 SIGCONT
      - 预算(wall)超? → throw BudgetExceeded
    drainInbox():               # stdin 队列 → user 消息入上下文(interrupt 优先)
    state=blocked(ON_LLM)
    res = llm.chat(messages, tools, modelConfig, signal)
    state=running
    budget.consumeTokens(res.usage)   # 链式扣减祖先预算
    turns++; budget.consumeTurn()
    appendMessage(assistant); emit stdout({type:'assistant'})
    if res 无 tool_calls: 结果 = content; break
    for call of tool_calls:     # 同批工具并发执行
      state=blocked(ON_TOOL)
      out = await tool.execute(args, ctx)
      appendMessage(tool result); emit stdout({type:'tool'})
  exit(DONE)
```

关键点：

- **step 边界可中断**：所有信号/暂停/预算检查集中在循环顶部，保证 SIGSTOP 后可安全序列化
- **drainInbox 时机**：每轮 LLM 调用前消费 stdin；注入消息以 `role:'user'` 入上下文，meta 注明来源（`from: 0` 为用户）
- **usage 链式记账**：`budget.consumeTokens(n)` 沿父链逐级扣减，任一级不足即抛出 BudgetExceeded，异常由消费方进程承担

## 4. spawn / join / fork / exec

### 4.1 spawn

1. 校验：深度 < maxDepth、兄弟数 < maxWidth、工具白名单 ⊆ 父
2. 分配 PID，建 PCB；budget 挂为父 budget 子节点；AbortController 挂为父 signal 子节点
3. mode='async'：微任务启动 run()，立即返回句柄
4. mode='blocking'：启动后父 `state=blocked(ON_CHILD)`，`await child.join()`，恢复原状态

### 4.2 join(pid, {timeout})

- 等待目标进程到达终态，返回 ExitResult；超时抛 TimeoutError（不杀目标进程）
- 同一进程可被多方 join（父、用户、兄弟），结果共享——join 只是订阅终态

### 4.3 fork（COW）

```
fork(hint?):
  child = spawn-like 新 PCB，ppid = self.ppid  （与自身同级，兄弟分支）
  child.context = { messages: this.context.messages, shared: true }
  this.context.shared = true
  if hint: child 追加一条 user(hint)   # 触发 slice，实现写时复制
  启动并返回句柄
```

数组浅拷贝延迟到首次 append；消息体永不复制。

### 4.4 exec

复用 PID：清空 context、替换工具集/模型配置、重置 usage 与 abort、状态回 ready、重跑 run()。用于"同一进程槽位跑下一个任务"。

## 5. 信号系统

| 信号    | 实现                                | 语义                                                     |
| ------- | ----------------------------------- | -------------------------------------------------------- |
| SIGTERM | 置 `flags.term`，step 边界检查      | 优雅退出：当前 step 完成后退出，返回部分结果，exitCode=0 |
| SIGKILL | `abortController.abort()`，级联子树 | 立即中止进行中的 LLM 请求/工具调用，exitCode=137         |
| SIGSTOP | 置 `flags.stop`                     | step 边界进入 paused，挂起等待                           |
| SIGCONT | 清 `flags.stop` + notify            | 恢复 running（restore 后的进程也在此启动）               |
| SIGCHLD | 子进程终态时向父发事件              | 父可 `on('SIGCHLD', handler)`                            |
| 自定义  | `on(signal, handler)`               | 用户定义语义                                             |

## 6. 同步原语与死锁检测

### 6.1 Semaphore

```ts
class Semaphore {
  constructor(count: number);
  async acquire(holder: Pid, timeoutMs?): Promise<Permit>; // 公平 FIFO 队列
  release(permit): void;
}
```

- 等待方挂在 Promise 上（不占线程）；进程等待期间 `state=blocked(ON_SEM)`
- acquire 注册 wait-for 边：`holder -> 当前所有持有者`；检出环即抛 `DeadlockError`
- timeout 到期自动出队，抛 TimeoutError

### 6.2 Mutex

`Semaphore(1)` + owner 校验：仅持有者可 release，否则抛错。

### 6.3 Barrier

`new Barrier(n)`：`await barrier.wait()` 计数到 n 时全部放行；支持超时。

### 6.4 wait-for 图（V3 死锁检测）

- 节点：PID；边：`P 等待 Q 持有的资源`
- 注册点：Semaphore.acquire 排队时、Pipe 背压阻塞时
- 检测：加边前 DFS 查环；发现环 → 本次等待抛 DeadlockError，边不入图
- 资源释放/等待结束 → 删边

## 7. IPC：stdio 与管道

### 7.1 stdio

```ts
class StdinQueue {
  // 有界队列，满则背压
  async write(msg: IpcMessage): Promise<void>; // interrupt 插队首
  drain(): IpcMessage[]; // run loop 消费
  close(): void; // 写端随后收到 EPIPE
}
class StdoutStream {
  // 环形缓冲(默认1000条) + EventEmitter
  push(chunk: OutputChunk): void;
  read(since?): OutputChunk[];
  tap(listener): Unsubscribe;
}
```

`IpcMessage = { from: pid, to: pid, kind: 'user'|'pipe'|'interrupt', payload: string, ts }`
`OutputChunk = { type: 'assistant'|'tool'|'result'|'progress'|'stderr'|'system', data, ts }`

### 7.2 命名管道

```ts
runtime.pipe(a, b, { name?, mode?: 'stream'|'batch'|'tool', capacity? }): Pipe
```

- 实现：tap(a.stdout) → 过滤（默认转 assistant 文本）→ b.stdin.write()，转发链串行化
- **背压**：b.stdin 满 → forward 等待，期间向 wait-for 图注册 `a -> b` 边；进程 stdin 容量可配
- **断管**：b 终态 → stdin.close() → 写端收到 `EPIPE`（PipeClosedError）；自动转发停止并记 a 的 stderr
- **注入模式**：stream（每条即一条 user 消息）/ batch（攒批）/ tool（写入独立 pipeInbox，b 用内置工具 `read_pipe` 主动拉取）

### 7.3 匿名管道

父进程可直接 tap 子进程 stdout（progress 回报），无需显式建管。

### 7.4 Blackboard（V3）

```ts
class Blackboard {
  read(key): { value; version } | undefined;
  write(key, value, expectedVersion?): boolean; // CAS；version 不符返回 false
  watch(key, cb): Unsubscribe;
}
```

## 8. 预算与配额（rlimit / cgroup）

```ts
class Budget {
  constructor(quota: { tokens?; turns?; wallMs? }, parent?: Budget);
  consumeTokens(n): void; // 自身扣减后递归 parent；任一级不足抛 BudgetExceeded
  consumeTurn(): void;
  checkWall(): void;
  remaining(): Quota;
}
```

- runtime 全局预算 = 根 Budget；init 挂其下；层层分摊
- 超支进程退出：`killed`，reason=`BUDGET_EXCEEDED`，结果含部分产出
- 全局防 fork bomb：maxDepth、maxWidth、全局 Budget 三重闸门

## 9. 用户接口（PID 0）

```ts
class UserAPI {
  attach(pid): void             // 用户进程挂到目标进程（内部走 stdin 直连 + tap）
  detach(): void
  send(pid | undefined, text, {priority}): void   // 默认发向 attach 目标
  tap(pid, cb): Unsubscribe
  ps(): ProcessSnapshot[]
}
```

- 同会话同一时刻一个前台 attach，tap 不限
- 用户消息在目标进程的 audit 中标记 `from: 0`

## 10. 模型层

```ts
interface LLMProvider {
  name: string;
  chat(req: ChatRequest): Promise<ChatResponse>; // 支持 AbortSignal
}
```

- `DeepSeekProvider`：OpenAI 兼容协议，`POST {baseUrl}/chat/completions`；tools/tool_calls 透传；默认超时 60s；支持 AbortSignal
- `MockLLMProvider`：脚本队列或 `(messages, callCount, req) => step` 函数；记录全部调用（断言用）；数组脚本可序列化（worker 内重建用）
- 运行时按 `ModelConfig.provider` 选择 provider；同一 runtime 可混用

## 11. Checkpoint / Restore

```
snapshot = runtime.checkpoint():
  序列化进程表：pid/ppid/name/state/config/messages/usage/budget/nextPid
  running/blocked -> 记录原状态
runtime.restore(snapshot):
  重建 PCB 树；running/blocked 恢复为 paused（flags.stop=true，未启动）；
  终态保持；SIGCONT 后从新 run loop 继续（消息序列已在）
```

约束：LLM 非确定性 → 恢复是"从检查点继续"，不是精确重放；worker 隔离进程不参与 checkpoint；内存快照保留工具引用，JSON 序列化会丢失工具（文档注明）。

## 12. Supervisor（V3）

```ts
interface SupervisionSpec {
  strategy: 'one-for-one' | 'one-for-all';
  restart: 'always' | 'on-failure' | 'never';
  maxRestarts: number; // 默认 3
  windowMs?: number; // 滑动窗口，默认 60s
}
```

- 由 runtime 内嵌 supervisor 实现：SIGCHLD 触发评估
- one-for-one：重启崩溃的子进程（同 config，新 PID）
- one-for-all：崩溃子进程 + 其受管兄弟全部 kill 后重启
- 窗口内重启次数超限 → 放弃，保持 FAILED

## 13. worker_threads 隔离（V3）

```
父线程: WorkerProcess extends Process（覆盖 doStart）
  - new Worker(worker-entry.mjs, { workerData: 可序列化 config })
  - stdin 写入 -> postMessage('stdin')；signal -> postMessage / terminate()
  - port.on('message') -> stdout chunk / usage / exit
worker 内: 自包含 mini-runtime（provider 按配置重建 + toolModule 路径动态 import）
```

- 配置必须可序列化：工具经 `toolModule`（模块路径）声明；mock provider 用数组脚本
- worker 崩溃（error/exit 非 0）→ 进程 FAILED，主线程不受影响
- 预算：worker 内自记账，exit 时上报 usage；超支由父发 SIGKILL

## 14. 目录结构

```
agentos/
├── docs/{PRD.md, DESIGN.md}
├── src/
│   ├── index.ts                # 公共导出
│   ├── types.ts                # 消息/配置/结果类型
│   ├── errors.ts               # 错误族
│   ├── utils.ts                # abortableSleep 等
│   ├── llm/{provider.ts, deepseek.ts, mock.ts}
│   ├── sync/{semaphore.ts, mutex.ts, barrier.ts, waitfor.ts}
│   ├── ipc/{stdio.ts, pipe.ts, blackboard.ts}
│   ├── core/{budget.ts, process.ts, runtime.ts, builtin-tools.ts,
│   │         supervisor.ts, checkpoint.ts, user.ts}
│   └── worker/{worker-process.ts, worker-entry.mjs}
├── tests/
│   ├── unit/        (budget / stdio / semaphore / mutex-barrier / waitfor / pipe / fork / blackboard / checkpoint)
│   └── integration/ (mvp / v2 / v3 / deepseek.live)
├── examples/demo.ts
└── {package.json, tsconfig.json, vitest.config.ts, .env, README.md}
```

## 15. 测试策略

| 层       | 手段                                                                                        |
| -------- | ------------------------------------------------------------------------------------------- |
| 单元     | 纯逻辑：预算链/同步原语/管道背压/COW/wait-for 图/序列化，无 LLM                             |
| 集成     | MockLLMProvider 脚本化 tool_calls，驱动完整 run loop；断言状态迁移、stdout、exit code       |
| 冒烟     | `RUN_LIVE=1` 门控，DeepSeek pro/flash 各一次真实对话 + 一次混合模型 spawn；无 key 自动 skip |
| 断言重点 | 状态机迁移序列、预算扣减数额、stdout chunk 序列、wait-for 环检出、checkpoint 恢复后字段一致 |

## 16. 风险与权衡

| 风险                                 | 对策                                                             |
| ------------------------------------ | ---------------------------------------------------------------- |
| fork COW 的"假共享"bug（误改消息体） | 消息对象 Object.freeze；append 统一入口                          |
| 管道背压导致全链阻塞                 | capacity 有界 + ON_PIPE 状态可见 + wait-for 图覆盖管道边         |
| 用户注入破坏父进程预期               | audit 标记来源；父可读子输出看到用户插话                         |
| LLM 不确定性 → 集成测试 flaky        | 集成测试全部走 Mock；真实 API 仅冒烟且断言宽松（非空、有 usage） |
| worker 内工具不可序列化              | toolModule 路径约定 + 启动时校验                                 |
