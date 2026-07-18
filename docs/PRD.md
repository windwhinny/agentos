**[English](PRD.en.md) | [中文](PRD.md)**

# AgentOS 需求文档（PRD）

- 版本：v1.0
- 日期：2026-07-17
- 状态：已评审

---

## 1. 背景与命题

现有 Agent 框架中，主 Agent 与 SubAgent 是两种不对等的实体：用户只能和主 Agent 交互，SubAgent 是一次性的"函数调用"，缺乏生命周期管理、并发控制和进程间通信能力。

本项目将操作系统的进程模型完整映射到 Agent 运行时：**一切 Agent 皆为 Process**。SubAgent 不再是附属品，而是拥有独立 PID、生命周期、标准 IO、预算配额的进程，支持阻塞/异步执行、并发、fork、信号量同步、信号中断、管道通信，且子进程可以递归地创建子进程。

项目代号 **AgentOS**，使用 Node.js + TypeScript 实现。

## 2. 目标与非目标

### 2.1 目标

1. 提供统一的 `Process` 抽象：主 Agent（PID 1）、SubAgent、用户（PID 0）共用同一套生命周期与通信机制
2. 用户可与任意 Process 交互（attach / detach / 注入消息 / 发信号）
3. 父 Process 可内省其整棵子树的状态与输出
4. Process 之间可通过管道（Pipe）建立点对点通信，支持流水线式编排
5. 启动 Process 时可指定**模型及推理参数**（model、temperature、maxTokens 等），不同 Process 可使用不同模型
6. 提供进程级同步原语（信号量 / 互斥锁 / 屏障）与信号系统
7. 支持 fork（Copy-on-Write 上下文复制）用于多分支探索
8. 支持 checkpoint（进程树快照与恢复）、supervisor（自动重启）、死锁检测、worker_threads 隔离
9. 完整的单元测试与集成测试，含 DeepSeek 真实 API 冒烟测试

### 2.2 非目标

- 分布式多机调度（单进程内运行时，worker_threads 仅做本机隔离）
- 多用户权限体系（用户视为 root，单一信任域）
- LLM 输出的内容安全审核

## 3. 概念模型

| 概念          | 定义                                                                                      |
| ------------- | ----------------------------------------------------------------------------------------- |
| Process       | 系统内唯一实体。拥有 PID、父 PID、状态机、对话上下文、工具白名单、模型配置、预算、标准 IO |
| PID 0（用户） | 终端进程。用户通过 attach 与任意 Process 建立双向管道进行交互                             |
| PID 1（init） | 用户会话的默认入口 Process，无任何内部特权                                                |
| Runtime       | 内核。维护进程表、调度、PID 分配、全局预算、同步原语注册表、管道拓扑                      |
| stdio         | 每个 Process 的 stdin（消息队列）/ stdout（结构化输出流 + 环形缓冲）/ stderr（诊断流）    |
| ExitResult    | 进程退出产物：exitCode、结果文本、用量统计、错误信息                                      |

### 3.1 进程状态机

```
CREATED → READY → RUNNING ⇄ BLOCKED(ON_LLM / ON_TOOL / ON_CHILD / ON_SEM / ON_PIPE)
                  RUNNING ⇄ PAUSED (SIGSTOP / SIGCONT)
                  RUNNING → DONE | FAILED | KILLED
```

### 3.2 概念映射（OS → AgentOS）

| OS                     | AgentOS                                                                |
| ---------------------- | ---------------------------------------------------------------------- |
| fork()                 | 浅复制不可变消息序列，分叉后独立演化（COW 语义）                       |
| exec()                 | 复用进程槽位，更换任务 / 提示词 / 工具集                               |
| wait()                 | join()，回收子进程 ExitResult，防止僵尸进程                            |
| rlimit / cgroup        | token 预算按进程树链式扣减；全局 QPS 限制                              |
| 信号                   | SIGTERM（优雅退出）/ SIGKILL（强制 abort）/ SIGSTOP / SIGCONT / 自定义 |
| 信号量 / 互斥锁 / 屏障 | 同名异步原语，等待方挂起在 Promise 上                                  |
| pipe / mkfifo          | 匿名管道（父子回报通道）+ 命名管道（任意两进程）                       |
| SIGCHLD                | 子进程状态迁移事件                                                     |
| /proc                  | ps() / descendants() / readOutput() / tap() 内省接口                   |
| swap                   | 上下文压缩（可选）：旧消息摘要化换出                                   |

## 4. 功能需求

### 4.1 MVP（必须）

| 编号 | 需求                                                                                           | 验收标准                                                       |
| ---- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| F-1  | Runtime 初始化：全局预算、最大深度/宽度、默认模型参数                                          | 可实例化并返回 ps() 快照                                       |
| F-2  | init Process 创建（PID 1），可配置 system prompt、工具、模型                                   | init 可独立完成一次 LLM 对话                                   |
| F-3  | spawn：创建子 Process，**可指定 model、temperature、maxTokens 等推理参数**，未指定则继承父配置 | 子进程以指定模型运行，usage 中可见模型名                       |
| F-4  | 阻塞执行：`spawn({mode:'blocking'})` 或 `join()` 挂起父进程直至子退出                          | 父状态迁移为 BLOCKED_ON_CHILD，子退出后父恢复并拿到 ExitResult |
| F-5  | 异步执行：spawn 立即返回句柄，进程并发运行                                                     | 多进程并发运行，wall time 显著小于串行                         |
| F-6  | 递归 spawn：子 Process 通过内置工具 `spawn_process` 再创建孙 Process，深度受 maxDepth 限制     | 三层树可建成，超限返回错误                                     |
| F-7  | 预算：token 预算链式扣减（子消耗计入祖先），超额进程以 BUDGET_EXCEEDED 终止                    | 预算耗尽时进程退出码为 BUDGET_EXCEEDED                         |
| F-8  | 取消链：AbortSignal 自父向子树传播，贯穿 LLM 请求与工具调用                                    | cancel 父后整棵树在 1s 内终止                                  |
| F-9  | 信号：SIGTERM（优雅退出）、SIGKILL（强制 abort）                                               | 两种退出路径 exitCode 可区分                                   |
| F-10 | 用户交互：attach(pid) / detach() / send(pid, msg) / 高优先级中断消息                           | 用户消息注入运行中进程的上下文并影响后续行为                   |
| F-11 | 父内省：children() / descendants() / readOutput(pid) / tap(pid)                                | 父可读取子输出缓冲并实时订阅                                   |
| F-12 | ps()：进程树快照（状态、用量、阻塞原因、时长）                                                 | 快照字段完整                                                   |
| F-13 | 工具系统：JSON Schema 声明、进程级白名单、子集收缩校验                                         | 子进程请求超出父白名单的工具被拒绝                             |

### 4.2 V2

| 编号 | 需求                                                                         | 验收标准                                                                |
| ---- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| F-20 | fork()：COW 复制上下文生成兄弟分支，分叉后互不影响                           | 两分支上下文独立演化，fork 本身 O(1) 级开销                             |
| F-21 | Semaphore（计数、超时、公平排队）                                            | 并发许可数严格不超过 N                                                  |
| F-22 | Mutex（所有权校验，仅持有者可释放）                                          | 非持有者 release 抛错                                                   |
| F-23 | Barrier（N 方会合）                                                          | 全部到达前无一方放行                                                    |
| F-24 | 命名管道：`pipe(a,b)` 连接任意两进程，有界队列 + 背压，断管返回 EPIPE        | a 的 stdout 流入 b 的 stdin；队列满时写端阻塞；读端死亡后写端收到 EPIPE |
| F-25 | 管道注入模式：stream / batch / tool（read_pipe 主动读）                      | 三种模式行为符合定义                                                    |
| F-26 | SIGCHLD：子状态迁移通知父                                                    | 父 handler 收到 exit/fail 事件                                          |
| F-27 | checkpoint / restore：进程树序列化与恢复                                     | restore 后进程树结构、上下文、预算一致                                  |
| F-28 | 事件总线：runtime 级 process:created / process:exit / process:blocked 等事件 | 事件可被外部订阅                                                        |

### 4.3 V3

| 编号 | 需求                                                                                    | 验收标准                                 |
| ---- | --------------------------------------------------------------------------------------- | ---------------------------------------- |
| F-40 | 死锁检测：wait-for 图覆盖信号量与管道边，检测到循环即抛 DeadlockError                   | 构造 A/B 循环等待可在 acquire 时检出     |
| F-41 | Supervisor：one-for-one / one-for-all 重启策略、maxRestarts 上限                        | 子进程崩溃后按策略自动重启，超限后停重启 |
| F-42 | Blackboard：共享 KV，CAS 写（expectedVersion）、watch 订阅                              | 并发写冲突可被 CAS 检出                  |
| F-43 | worker_threads 隔离：Process 可在独立 worker 中运行，stdin/信号/退出经 MessagePort 桥接 | worker 进程崩溃不影响 runtime 主线程     |
| F-44 | exec()：复用进程槽位重置任务与上下文                                                    | PID 不变，上下文清空，以新配置运行       |

## 5. 模型与推理参数需求（重点）

1. Process 启动参数 `model` 接受注册表中的模型别名或裸模型 ID
2. 内置模型注册表（DeepSeek）：
   - `deepseek-v4-pro`（别名 `pro`）：强推理模型，用于规划与汇总类 Process
   - `deepseek-v4-flash`（别名 `flash`）：快速模型，用于执行与子任务类 Process
3. 推理参数：`temperature`、`maxTokens`、`topP`，进程级覆盖，未设置继承父进程，均未设置取 runtime 默认值
4. Runtime 默认配置示例：`{ model: 'deepseek-v4-pro', temperature: 0.7 }`
5. 测试环境通过 `.env` 注入 `DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`
6. 所有 LLM 调用记录 `model` 与 `usage`（prompt/completion/total tokens），计入预算并体现在 ps() 快照

## 6. 非功能需求

| 类别   | 要求                                                                                               |
| ------ | -------------------------------------------------------------------------------------------------- |
| 性能   | 单 runtime 支持 100+ 并发逻辑 Process（LLM 调用为 IO 密集，同进程异步即可）；fork 不复制消息体     |
| 可靠性 | 任一 Process 崩溃不传染父与兄弟；所有 join/spawn 支持超时                                          |
| 可观测 | 每次 LLM 调用、工具调用、状态迁移均有结构化日志事件；ps() 可输出树形快照                           |
| 可测试 | MockLLMProvider 支持脚本化响应，全部单元/集成测试不依赖真实 API；真实 API 测试以 `RUN_LIVE=1` 门控 |
| 安全   | API Key 仅存于 .env（已 gitignore）；子进程工具权限只减不增                                        |
| 兼容   | Node >= 20，ESM，TypeScript strict                                                                 |

## 7. 测试需求

1. 单元测试覆盖：PID/状态机、预算链、stdio 缓冲、信号量/互斥锁/屏障、管道背压与 EPIPE、fork COW、死锁检测、blackboard CAS、checkpoint 序列化
2. 集成测试（MockLLM）：spawn/join 阻塞与异步、三层递归 spawn、预算耗尽、取消链、SIGTERM/SIGKILL、用户 attach/send、父子内省、管道编排、supervisor 重启、worker 隔离
3. 冒烟测试（真实 DeepSeek）：`deepseek-v4-pro` 与 `deepseek-v4-flash` 各完成一次真实对话，并验证一次"pro 父 + flash 子"混合模型 spawn
4. 全量测试默认跳过冒烟（无 key 或未设 RUN_LIVE 时 skip）

## 8. 里程碑

| 里程碑   | 内容        | 验收                             |
| -------- | ----------- | -------------------------------- |
| M1 (MVP) | F-1 ~ F-13  | vitest unit + integration 全绿   |
| M2 (V2)  | F-20 ~ F-28 | 全量测试全绿                     |
| M3 (V3)  | F-40 ~ F-44 | 全量测试全绿 + DeepSeek 冒烟通过 |
