**[English](PRD.en.md) | [中文](PRD.md)**

# AgentOS Requirements Document (PRD)

- Version: v1.0
- Date: 2026-07-17
- Status: Reviewed

---

## 1. Background and Thesis

In existing Agent frameworks, the main Agent and SubAgents are two unequal entities: users can only interact with the main Agent, while a SubAgent is a one-shot "function call" lacking lifecycle management, concurrency control, and inter-process communication.

This project maps the operating system process model completely onto the Agent runtime: **every Agent is a Process**. A SubAgent is no longer an accessory, but a process with its own PID, lifecycle, standard IO, and budget quota, supporting blocking/asynchronous execution, concurrency, fork, semaphore synchronization, signal interruption, and pipe communication — and a child process can recursively create child processes of its own.

Project codename **AgentOS**, implemented in Node.js + TypeScript.

## 2. Goals and Non-Goals

### 2.1 Goals

1. Provide a unified `Process` abstraction: the main Agent (PID 1), SubAgents, and the user (PID 0) share the same lifecycle and communication mechanisms
2. Users can interact with any Process (attach / detach / inject messages / send signals)
3. A parent Process can introspect the state and output of its entire subtree
4. Processes can establish point-to-point communication via pipes, enabling pipeline-style orchestration
5. **Model and inference parameters** (model, temperature, maxTokens, etc.) can be specified when starting a Process; different Processes may use different models
6. Provide process-level synchronization primitives (semaphores / mutexes / barriers) and a signal system
7. Support fork (Copy-on-Write context duplication) for multi-branch exploration
8. Support checkpoint (process tree snapshots and restore), supervisor (automatic restart), deadlock detection, and worker_threads isolation
9. Complete unit and integration tests, including a DeepSeek real-API smoke test

### 2.2 Non-Goals

- Distributed multi-machine scheduling (single-process runtime; worker_threads provide local isolation only)
- Multi-user permission system (the user is treated as root, single trust domain)
- Content safety review of LLM outputs

## 3. Conceptual Model

| Concept       | Definition                                                                                                       |
| ------------- | ---------------------------------------------------------------------------------------------------------------- |
| Process       | The sole entity in the system. Has a PID, parent PID, state machine, conversation context, tool whitelist, model configuration, budget, and standard IO |
| PID 0 (user)  | Terminal process. The user interacts with any Process by establishing a bidirectional pipe via attach            |
| PID 1 (init)  | The default entry Process of a user session, with no internal privileges whatsoever                              |
| Runtime       | The kernel. Maintains the process table, scheduling, PID allocation, the global budget, the synchronization primitive registry, and the pipe topology |
| stdio         | Each Process's stdin (message queue) / stdout (structured output stream + ring buffer) / stderr (diagnostic stream) |
| ExitResult    | Process exit artifact: exitCode, result text, usage statistics, error information                                |

### 3.1 Process State Machine

```
CREATED → READY → RUNNING ⇄ BLOCKED(ON_LLM / ON_TOOL / ON_CHILD / ON_SEM / ON_PIPE)
                  RUNNING ⇄ PAUSED (SIGSTOP / SIGCONT)
                  RUNNING → DONE | FAILED | KILLED
```

### 3.2 Concept Mapping (OS → AgentOS)

| OS                     | AgentOS                                                                          |
| ---------------------- | -------------------------------------------------------------------------------- |
| fork()                 | Shallow-copies the immutable message sequence; the branches evolve independently after forking (COW semantics) |
| exec()                 | Reuses the process slot while swapping the task / prompt / toolset               |
| wait()                 | join(), reaps the child's ExitResult, preventing zombie processes                |
| rlimit / cgroup        | token budget deducted along the process tree chain; global QPS limit             |
| signals                | SIGTERM (graceful exit) / SIGKILL (forced abort) / SIGSTOP / SIGCONT / custom    |
| semaphore / mutex / barrier | Same-name async primitives; waiters suspend on Promises                     |
| pipe / mkfifo          | Anonymous pipes (child-to-parent reporting channel) + named pipes (any two processes) |
| SIGCHLD                | Child process state transition events                                            |
| /proc                  | ps() / descendants() / readOutput() / tap() introspection interfaces             |
| swap                   | Context compression (optional): old messages are summarized and swapped out      |

## 4. Functional Requirements

### 4.1 MVP (Required)

| ID   | Requirement                                                                                                                     | Acceptance Criteria                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| F-1  | Runtime initialization: global budget, max depth/width, default model parameters                                                | Can be instantiated and returns a ps() snapshot                    |
| F-2  | init Process creation (PID 1), with configurable system prompt, tools, and model                                                | init can independently complete one LLM conversation               |
| F-3  | spawn: creates a child Process, **with the ability to specify model, temperature, maxTokens and other inference parameters**; unspecified parameters inherit the parent's configuration | The child runs with the specified model, and the model name is visible in usage |
| F-4  | Blocking execution: `spawn({mode:'blocking'})` or `join()` suspends the parent until the child exits                            | Parent transitions to BLOCKED_ON_CHILD; after the child exits, the parent resumes and receives the ExitResult |
| F-5  | Asynchronous execution: spawn returns a handle immediately; processes run concurrently                                          | Multiple processes run concurrently; wall time is significantly shorter than serial execution |
| F-6  | Recursive spawn: a child Process creates grandchild Processes via the built-in `spawn_process` tool; depth is limited by maxDepth | A three-level tree can be built; exceeding the limit returns an error |
| F-7  | Budget: token budget deducted along the chain (child consumption counts toward ancestors); over-budget processes terminate with BUDGET_EXCEEDED | When the budget is exhausted, the process exit code is BUDGET_EXCEEDED |
| F-8  | Cancellation chain: an AbortSignal propagates from parent to child subtree, cutting through LLM requests and tool calls         | After cancelling the parent, the entire tree terminates within 1s  |
| F-9  | Signals: SIGTERM (graceful exit), SIGKILL (forced abort)                                                                        | The two exit paths have distinguishable exitCodes                  |
| F-10 | User interaction: attach(pid) / detach() / send(pid, msg) / high-priority interrupt messages                                    | User messages are injected into the context of a running process and affect subsequent behavior |
| F-11 | Parent introspection: children() / descendants() / readOutput(pid) / tap(pid)                                                   | The parent can read child output buffers and subscribe in real time |
| F-12 | ps(): process tree snapshot (state, usage, blocking reason, duration)                                                           | Snapshot fields are complete                                       |
| F-13 | Tool system: JSON Schema declarations, per-process whitelists, subset-shrinking validation                                      | A child requesting tools outside the parent's whitelist is rejected |

### 4.2 V2

| ID   | Requirement                                                                  | Acceptance Criteria                                                      |
| ---- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| F-20 | fork(): COW context duplication creating a sibling branch; branches do not affect each other after forking | The two branches' contexts evolve independently; fork itself has O(1)-level overhead |
| F-21 | Semaphore (counting, timeout, fair queuing)                                  | Concurrent permits strictly never exceed N                               |
| F-22 | Mutex (ownership verification; only the holder may release)                  | A non-holder calling release throws an error                             |
| F-23 | Barrier (N-party rendezvous)                                                 | No party is released until all have arrived                              |
| F-24 | Named pipes: `pipe(a,b)` connects any two processes, bounded queue + backpressure, broken pipe returns EPIPE | a's stdout flows into b's stdin; the writer blocks when the queue is full; the writer receives EPIPE after the reader dies |
| F-25 | Pipe injection modes: stream / batch / tool (active reads via read_pipe)     | All three modes behave as defined                                        |
| F-26 | SIGCHLD: notifies the parent of child state transitions                      | The parent handler receives exit/fail events                             |
| F-27 | checkpoint / restore: process tree serialization and restore                 | After restore, process tree structure, context, and budget are consistent |
| F-28 | Event bus: runtime-level events such as process:created / process:exit / process:blocked | Events can be subscribed to externally                                   |

### 4.3 V3

| ID   | Requirement                                                                                  | Acceptance Criteria                                |
| ---- | -------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| F-40 | Deadlock detection: a wait-for graph covering semaphore and pipe edges; cycles throw a DeadlockError when detected | Constructing an A/B circular wait can be detected at acquire time |
| F-41 | Supervisor: one-for-one / one-for-all restart strategies, maxRestarts cap                    | After a child crashes it restarts automatically per the strategy; restarts stop beyond the cap |
| F-42 | Blackboard: shared KV with CAS writes (expectedVersion) and watch subscriptions              | Concurrent write conflicts can be detected via CAS |
| F-43 | worker_threads isolation: a Process can run in a dedicated worker; stdin/signals/exit are bridged via MessagePort | A worker process crash does not affect the runtime main thread |
| F-44 | exec(): reuses the process slot and resets the task and context                              | PID unchanged, context cleared, runs with the new configuration |

## 5. Model and Inference Parameter Requirements (Key)

1. The Process startup parameter `model` accepts a model alias from the registry or a bare model ID
2. Built-in model registry (DeepSeek):
   - `deepseek-v4-pro` (alias `pro`): strong reasoning model, for planning and summarization Processes
   - `deepseek-v4-flash` (alias `flash`): fast model, for execution and subtask Processes
3. Inference parameters: `temperature`, `maxTokens`, `topP`; overridable per process, inherited from the parent when unset, and falling back to the runtime default when unset everywhere
4. Example runtime default configuration: `{ model: 'deepseek-v4-pro', temperature: 0.7 }`
5. The test environment injects `DEEPSEEK_API_KEY` and `DEEPSEEK_BASE_URL` via `.env`
6. Every LLM call records `model` and `usage` (prompt/completion/total tokens), which count toward the budget and appear in ps() snapshots

## 6. Non-Functional Requirements

| Category     | Requirement                                                                                                                        |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Performance  | A single runtime supports 100+ concurrent logical Processes (LLM calls are IO-bound, so async within one process suffices); fork does not copy message bodies |
| Reliability  | A crash in any Process does not propagate to its parent or siblings; all join/spawn calls support timeouts                         |
| Observability | Every LLM call, tool call, and state transition emits a structured log event; ps() can output a tree-shaped snapshot              |
| Testability  | MockLLMProvider supports scripted responses; all unit/integration tests run without the real API; real-API tests are gated behind `RUN_LIVE=1` |
| Security     | API keys live only in .env (gitignored); a child's tool permissions can only shrink, never grow                                    |
| Compatibility | Node >= 20, ESM, TypeScript strict                                                                                                |

## 7. Testing Requirements

1. Unit test coverage: PID/state machine, budget chain, stdio buffers, semaphore/mutex/barrier, pipe backpressure and EPIPE, fork COW, deadlock detection, blackboard CAS, checkpoint serialization
2. Integration tests (MockLLM): blocking and async spawn/join, three-level recursive spawn, budget exhaustion, cancellation chain, SIGTERM/SIGKILL, user attach/send, parent-child introspection, pipe orchestration, supervisor restarts, worker isolation
3. Smoke tests (real DeepSeek): `deepseek-v4-pro` and `deepseek-v4-flash` each complete one real conversation, plus one verification of a mixed-model "pro parent + flash child" spawn
4. The full test suite skips smoke tests by default (skipped when no key is present or RUN_LIVE is unset)

## 8. Milestones

| Milestone | Scope       | Acceptance                                |
| --------- | ----------- | ----------------------------------------- |
| M1 (MVP)  | F-1 ~ F-13  | vitest unit + integration all green       |
| M2 (V2)   | F-20 ~ F-28 | Full test suite all green                 |
| M3 (V3)   | F-40 ~ F-44 | Full test suite all green + DeepSeek smoke passes |
