// —— 消息与工具 ——
export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // JSON string
}

/** 多模态内容块（OpenAI 兼容）：文本或图片（data URL / http URL） */
export type ContentPart =
  { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[];
  /** 思考链（如 deepseek reasoning_content）；不回传给 API */
  reasoning?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  meta?: { from?: number; kind?: string };
}

/** 提取消息的纯文本（多模态时拼接 text 块） */
export function textOf(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p) => p.type === 'text')
    .map((p) => (p as { text: string }).text)
    .join('\n');
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// —— LLM ——
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  signal?: AbortSignal;
}

export interface ChatResponse {
  message: { content: string; reasoning?: string; tool_calls?: ToolCall[] };
  usage: Usage;
  model: string;
}

/** 流式回调：均为「截至目前累积」文本（非增量），便于消费方直接替换渲染 */
export interface StreamHandlers {
  onText?(accumulated: string): void;
  onThinking?(accumulated: string): void;
}

export interface LLMProvider {
  name: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
  /** 可选流式接口；Process 优先使用（中间帧用于实时渲染，最终结果与 chat 一致） */
  chatStream?(req: ChatRequest, handlers: StreamHandlers): Promise<ChatResponse>;
}

export interface ModelConfig {
  model?: string;
  provider?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}

// —— 预算 ——
export interface BudgetQuota {
  tokens?: number;
  turns?: number;
  wallMs?: number;
}

// —— 工具 ——
import type { AgentRuntime } from './core/runtime';
import type { Process } from './core/process';

export interface ToolContext {
  pid: number;
  runtime: AgentRuntime;
  process: Process;
  signal: AbortSignal;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, ctx: ToolContext): unknown | Promise<unknown>;
}

// —— 进程 ——
export type ProcessState =
  'created' | 'ready' | 'running' | 'blocked' | 'paused' | 'done' | 'failed' | 'killed';

export type BlockedReason = 'ON_LLM' | 'ON_TOOL' | 'ON_CHILD' | 'ON_SEM' | 'ON_PIPE' | 'ON_INBOX';

export interface ExitResult {
  pid: number;
  status: 'done' | 'failed' | 'killed';
  reason: string; // DONE / SIGTERM / SIGKILL / BUDGET_EXCEEDED / MAX_TURNS / TIMEOUT / ERROR
  exitCode: number;
  output: string;
  error?: string;
  usage: Usage;
  turns: number;
}

export interface IpcMessage {
  from: number;
  to: number;
  kind: 'user' | 'pipe' | 'interrupt';
  /** 纯文本，或多模态（文本 + 图片 data URL 列表） */
  payload: string | { text: string; images?: string[] };
  ts: number;
}

export interface OutputChunk {
  type: 'assistant' | 'tool' | 'result' | 'progress' | 'stderr' | 'system';
  data: unknown;
  ts: number;
  /** 流式：同一条消息的连续帧共享 id，读取方按 id 取最后一帧 */
  id?: string;
  /** 流式：该消息是否已完成 */
  done?: boolean;
}

export interface SupervisionSpec {
  strategy: 'one-for-one' | 'one-for-all';
  restart: 'always' | 'on-failure' | 'never';
  maxRestarts?: number;
  windowMs?: number;
}

export type WorkerProviderConfig =
  | { provider: 'mock'; script: Array<Record<string, unknown>> }
  | { provider: 'deepseek'; apiKey?: string; baseUrl?: string };

export interface SpawnOptions {
  task: string;
  systemPrompt?: string;
  tools?: Tool[];
  model?: ModelConfig;
  budget?: BudgetQuota;
  name?: string;
  mode?: 'async' | 'blocking';
  isolation?: 'inproc' | 'worker';
  toolModule?: string;
  worker?: WorkerProviderConfig;
  supervision?: SupervisionSpec;
  stdinCapacity?: number;
  stdoutCapacity?: number;
}

export interface ProcessSnapshot {
  pid: number;
  ppid: number;
  name?: string;
  state: ProcessState;
  blockedReason?: BlockedReason;
  depth: number;
  model: string;
  provider: string;
  usage: Usage;
  budgetUsed: { tokens: number; turns: number };
  turns: number;
  children: number[];
  createdAt: number;
  uptimeMs: number;
  exit?: { status: string; reason: string };
}
