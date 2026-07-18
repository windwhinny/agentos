**[English](DESIGN.en.md) | [中文](DESIGN.md)**

# AgentOS Technical Design Document

- Version: v1.0 (corresponds to PRD v1.0)
- Date: 2026-07-17

---

## 1. Overall Architecture

```
┌──────────────────────────────────────────────────────┐
│ User interface layer  UserAPI (PID 0): attach/detach/send/tap  │
├──────────────────────────────────────────────────────┤
│ Kernel layer          AgentRuntime: process table / PID allocation / scheduling │
│                       ps / pipe topology / event bus / checkpoint │
├──────────────────────────────────────────────────────┤
│ Process layer         Process: state machine + ReAct loop + stdio │
│                       spawn / fork / exec / join / signal │
├──────────────────────────────────────────────────────┤
│ Sync layer            Semaphore / Mutex / Barrier + wait-for graph │
├──────────────────────────────────────────────────────┤
│ IPC layer             StdinQueue / StdoutStream / Pipe / Blackboard │
├──────────────────────────────────────────────────────┤
│ Resource layer        Budget (tree chain) / AbortController cancellation chain │
├──────────────────────────────────────────────────────┤
│ Model layer           LLMProvider: deepseek / mock (registerable) │
├──────────────────────────────────────────────────────┤
│ Isolation layer       In-process async (default) / worker_threads (V3) │
└──────────────────────────────────────────────────────┘
```

Design highlights:

1. **Single kernel, multiple processes**: Node's single-threaded event loop is a natural fit for IO-bound LLM concurrency — every "logical process" is an async task on the same thread; the scheduler is the event loop itself, and there is no real context-switching overhead.
2. **Everything is a Process**: the user (PID 0), init (PID 1), and subagents all run the same code; UserAPI is just an adapter for PID 0.
3. **Immutable message sequence**: once produced, a conversation message is immutable; fork performs only a shallow array copy, achieving O(1) COW.
4. **Cancellation is signaling**: the AbortController tree mirrors the process tree; SIGKILL = abort(), SIGTERM = set a flag checked at the step boundary.

## 2. Core Data Structures

### 2.1 Process (PCB)

```ts
interface ProcessConfig {
  task: string; // task description (first user message)
  systemPrompt?: string; // persona definition
  tools?: Tool[]; // tool whitelist (must be ⊆ parent's)
  model?: ModelConfig; // model and inference parameters (see 2.3)
  budget?: Partial<BudgetQuota>; // token / turn / wall-clock quota
  name?: string; // human-readable name (may be duplicated)
  mode?: 'async' | 'blocking'; // spawn semantics
  isolation?: 'inproc' | 'worker'; // execution carrier
  supervision?: SupervisionSpec; // restart policy
  pipeIn?: PipeEndpoint[]; // inbound pipes
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

PCB fields: `pid / ppid / name / state / blockedReason / children:Set<pid> / context / modelConfig / budget / usage / abort / stdio / depth / createdAt / exitResult`

### 2.2 Context

```ts
interface Context {
  messages: ChatMessage[]; // immutable message sequence; check the shared flag before push
  shared: boolean; // true after fork; slice before writing (COW)
}
```

All message appends go through `appendMessage(msg)`: `if (shared) { messages = messages.slice(); shared = false }`. Message objects themselves are never mutated (Object.freeze).

### 2.3 Model Configuration (Three-Level Inheritance)

```ts
interface ModelConfig {
  model?: string; // 'deepseek-v4-pro' | 'deepseek-v4-flash' | alias
  provider?: string; // 'deepseek' | 'mock' | custom
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}
```

Resolution order: process explicit config → parent process config → runtime default config. The runtime ships with a built-in alias table `{ pro: 'deepseek-v4-pro', flash: 'deepseek-v4-flash' }`.

## 3. Process Run Loop (ReAct loop)

```
async run():
  state = running
  while true:
    await stepBoundary():       # step boundary
      - abort flag set?   → throw KillExit(SIGKILL)
      - SIGTERM flag set? → graceful exit(reason=SIGTERM, result=partial output)
      - SIGSTOP flag set? → state=paused, wait for SIGCONT
      - budget (wall) exceeded? → throw BudgetExceeded
    drainInbox():               # stdin queue → user messages into context (interrupts first)
    state=blocked(ON_LLM)
    res = llm.chat(messages, tools, modelConfig, signal)
    state=running
    budget.consumeTokens(res.usage)   # chain-charge ancestor budgets
    turns++; budget.consumeTurn()
    appendMessage(assistant); emit stdout({type:'assistant'})
    if res has no tool_calls: result = content; break
    for call of tool_calls:     # run the same batch of tools concurrently
      state=blocked(ON_TOOL)
      out = await tool.execute(args, ctx)
      appendMessage(tool result); emit stdout({type:'tool'})
  exit(DONE)
```

Key points:

- **Interruptible step boundary**: all signal/pause/budget checks are concentrated at the top of the loop, so a process can be safely serialized after SIGSTOP.
- **drainInbox timing**: stdin is consumed before each LLM call; injected messages enter the context as `role:'user'`, with meta noting the source (`from: 0` means the user).
- **Chained usage accounting**: `budget.consumeTokens(n)` deducts level by level up the parent chain; any level with insufficient balance throws BudgetExceeded, and the exception is borne by the consuming process.

## 4. spawn / join / fork / exec

### 4.1 spawn

1. Validation: depth < maxDepth, sibling count < maxWidth, tool whitelist ⊆ parent's
2. Allocate a PID and create the PCB; attach budget as a child node of the parent budget; attach AbortController as a child node of the parent signal
3. mode='async': start run() in a microtask and return a handle immediately
4. mode='blocking': after starting, the parent sets `state=blocked(ON_CHILD)`, runs `await child.join()`, then restores its previous state

### 4.2 join(pid, {timeout})

- Wait for the target process to reach a terminal state and return the ExitResult; on timeout, throw TimeoutError (does not kill the target process).
- The same process can be joined by multiple parties (parent, user, siblings) sharing the same result — join merely subscribes to the terminal state.

### 4.3 fork (COW)

```
fork(hint?):
  child = spawn-like new PCB, ppid = self.ppid  (same level as self, sibling branch)
  child.context = { messages: this.context.messages, shared: true }
  this.context.shared = true
  if hint: append a user(hint) message to child  # triggers slice, implementing copy-on-write
  start and return a handle
```

The shallow array copy is deferred until the first append; message bodies are never copied.

### 4.4 exec

Reuse the PID: clear the context, replace the toolset/model config, reset usage and abort, return state to ready, and re-run run(). Used for "running the next task in the same process slot".

## 5. Signal System

| Signal  | Implementation                        | Semantics                                                            |
| ------- | ------------------------------------- | -------------------------------------------------------------------- |
| SIGTERM | Set `flags.term`, checked at step boundary | Graceful exit: exit after the current step completes, return partial results, exitCode=0 |
| SIGKILL | `abortController.abort()`, cascades down the subtree | Immediately abort the in-flight LLM request/tool call, exitCode=137 |
| SIGSTOP | Set `flags.stop`                      | Enter paused at the step boundary and suspend                        |
| SIGCONT | Clear `flags.stop` + notify           | Resume running (restored processes also start here)                  |
| SIGCHLD | Event sent to the parent when a child reaches a terminal state | Parent can `on('SIGCHLD', handler)`                    |
| Custom  | `on(signal, handler)`                 | User-defined semantics                                               |

## 6. Synchronization Primitives and Deadlock Detection

### 6.1 Semaphore

```ts
class Semaphore {
  constructor(count: number);
  async acquire(holder: Pid, timeoutMs?): Promise<Permit>; // fair FIFO queue
  release(permit): void;
}
```

- Waiters hang on a Promise (no thread occupied); while waiting, `state=blocked(ON_SEM)`.
- acquire registers wait-for edges: `holder -> all current holders`; if a cycle is detected, throw `DeadlockError`.
- On timeout, the waiter is automatically dequeued and TimeoutError is thrown.

### 6.2 Mutex

`Semaphore(1)` + owner check: only the holder may release, otherwise an error is thrown.

### 6.3 Barrier

`new Barrier(n)`: `await barrier.wait()` releases everyone once the count reaches n; timeout supported.

### 6.4 wait-for Graph (V3 Deadlock Detection)

- Nodes: PIDs; edges: `P is waiting for a resource held by Q`
- Registration points: when queueing in Semaphore.acquire, when blocked on Pipe backpressure
- Detection: DFS cycle check before adding an edge; if a cycle is found → this wait throws DeadlockError and the edge is not added
- On resource release / end of waiting → remove the edge

## 7. IPC: stdio and Pipes

### 7.1 stdio

```ts
class StdinQueue {
  // bounded queue; applies backpressure when full
  async write(msg: IpcMessage): Promise<void>; // interrupts jump to the front
  drain(): IpcMessage[]; // consumed by the run loop
  close(): void; // writers subsequently receive EPIPE
}
class StdoutStream {
  // ring buffer (default 1000 entries) + EventEmitter
  push(chunk: OutputChunk): void;
  read(since?): OutputChunk[];
  tap(listener): Unsubscribe;
}
```

`IpcMessage = { from: pid, to: pid, kind: 'user'|'pipe'|'interrupt', payload: string, ts }`
`OutputChunk = { type: 'assistant'|'tool'|'result'|'progress'|'stderr'|'system', data, ts }`

### 7.2 Named Pipes

```ts
runtime.pipe(a, b, { name?, mode?: 'stream'|'batch'|'tool', capacity? }): Pipe
```

- Implementation: tap(a.stdout) → filter (converts to assistant text by default) → b.stdin.write(); the forwarding chain is serialized.
- **Backpressure**: when b.stdin is full → forward waits, and an `a -> b` edge is registered in the wait-for graph during the wait; process stdin capacity is configurable.
- **Broken pipe**: when b reaches a terminal state → stdin.close() → the writer receives `EPIPE` (PipeClosedError); automatic forwarding stops and the event is logged to a's stderr.
- **Injection modes**: stream (each chunk becomes one user message) / batch (accumulate into batches) / tool (write to a separate pipeInbox; b actively pulls with the built-in `read_pipe` tool)

### 7.3 Anonymous Pipes

A parent can directly tap a child's stdout (progress reporting) without explicitly creating a pipe.

### 7.4 Blackboard (V3)

```ts
class Blackboard {
  read(key): { value; version } | undefined;
  write(key, value, expectedVersion?): boolean; // CAS; returns false on version mismatch
  watch(key, cb): Unsubscribe;
}
```

## 8. Budget and Quota (rlimit / cgroup)

```ts
class Budget {
  constructor(quota: { tokens?; turns?; wallMs? }, parent?: Budget);
  consumeTokens(n): void; // deduct self, then recurse into parent; any insufficient level throws BudgetExceeded
  consumeTurn(): void;
  checkWall(): void;
  remaining(): Quota;
}
```

- The runtime global budget is the root Budget; init hangs under it; budgets are apportioned level by level.
- A process that overspends exits as `killed`, reason=`BUDGET_EXCEEDED`, with partial output in the result.
- Global fork-bomb protection: three gates — maxDepth, maxWidth, and the global Budget.

## 9. User Interface (PID 0)

```ts
class UserAPI {
  attach(pid): void             // attach the user process to a target process (internally: direct stdin wiring + tap)
  detach(): void
  send(pid | undefined, text, {priority}): void   // defaults to the attach target
  tap(pid, cb): Unsubscribe
  ps(): ProcessSnapshot[]
}
```

- One foreground attach per session at a time; tap is unlimited.
- User messages are marked `from: 0` in the target process's audit.

## 10. Model Layer

```ts
interface LLMProvider {
  name: string;
  chat(req: ChatRequest): Promise<ChatResponse>; // supports AbortSignal
}
```

- `DeepSeekProvider`: OpenAI-compatible protocol, `POST {baseUrl}/chat/completions`; tools/tool_calls passed through; default timeout 60s; supports AbortSignal.
- `MockLLMProvider`: a script queue or a `(messages, callCount, req) => step` function; records all calls (for assertions); array scripts are serializable (for rebuilding inside a worker).
- The runtime selects a provider by `ModelConfig.provider`; providers can be mixed within the same runtime.

## 11. Checkpoint / Restore

```
snapshot = runtime.checkpoint():
  serialize the process table: pid/ppid/name/state/config/messages/usage/budget/nextPid
  running/blocked -> record the original state
runtime.restore(snapshot):
  rebuild the PCB tree; running/blocked are restored as paused (flags.stop=true, not started);
  terminal states are preserved; after SIGCONT, continue from a fresh run loop (the message sequence is already in place)
```

Constraints: LLM non-determinism → restore means "continue from the checkpoint", not exact replay; worker-isolated processes do not participate in checkpoint; in-memory snapshots keep tool references, while JSON serialization loses tools (noted in documentation).

## 12. Supervisor (V3)

```ts
interface SupervisionSpec {
  strategy: 'one-for-one' | 'one-for-all';
  restart: 'always' | 'on-failure' | 'never';
  maxRestarts: number; // default 3
  windowMs?: number; // sliding window, default 60s
}
```

- Implemented as a supervisor embedded in the runtime: evaluation is triggered by SIGCHLD.
- one-for-one: restart the crashed child (same config, new PID).
- one-for-all: kill the crashed child plus all its supervised siblings, then restart them.
- If restart count exceeds the limit within the window → give up and stay FAILED.

## 13. worker_threads Isolation (V3)

```
Parent thread: WorkerProcess extends Process (overrides doStart)
  - new Worker(worker-entry.mjs, { workerData: serializable config })
  - stdin write -> postMessage('stdin'); signal -> postMessage / terminate()
  - port.on('message') -> stdout chunk / usage / exit
Inside worker: self-contained mini-runtime (provider rebuilt from config + toolModule path dynamically imported)
```

- The config must be serializable: tools are declared via `toolModule` (module path); the mock provider uses array scripts.
- Worker crash (error / non-zero exit) → process FAILED; the main thread is unaffected.
- Budget: the worker keeps its own books and reports usage on exit; overspending is enforced by the parent sending SIGKILL.

## 14. Directory Structure

```
agentos/
├── docs/{PRD.md, DESIGN.md}
├── src/
│   ├── index.ts                # public exports
│   ├── types.ts                # message/config/result types
│   ├── errors.ts               # error family
│   ├── utils.ts                # abortableSleep, etc.
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

## 15. Testing Strategy

| Tier             | Approach                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------- |
| Unit             | Pure logic: budget chain / sync primitives / pipe backpressure / COW / wait-for graph / serialization; no LLM |
| Integration      | MockLLMProvider scripted tool_calls driving the full run loop; assert state transitions, stdout, exit code |
| Smoke            | Gated by `RUN_LIVE=1`; one real conversation each with DeepSeek pro/flash plus one mixed-model spawn; auto-skip without a key |
| Assertion focus  | State machine transition sequences, budget deduction amounts, stdout chunk sequences, wait-for cycle detection, field consistency after checkpoint restore |

## 16. Risks and Trade-offs

| Risk                                          | Mitigation                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------------- |
| "False sharing" bug in fork COW (mutating a message body) | Object.freeze on message objects; single unified append entry point |
| Pipe backpressure blocking the whole chain    | Bounded capacity + visible ON_PIPE state + wait-for graph covering pipe edges |
| User injection breaking parent expectations   | Audit marks the source; the parent can read child output and see the user interjection |
| LLM non-determinism → flaky integration tests | All integration tests use Mock; real API only in smoke tests with loose assertions (non-empty, has usage) |
| Tools not serializable inside a worker        | toolModule path convention + validation at startup                          |
