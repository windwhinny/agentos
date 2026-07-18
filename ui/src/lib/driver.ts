import type { OutputChunk, ProcessSnapshot } from '@/agentos/types';

export interface SpawnParams {
  task: string;
  name?: string;
  model?: string;
  budgetTokens?: number;
}

/** 供应商视图（已脱敏，无 apiKey） */
export interface ProviderView {
  name: string;
  type: string;
  baseUrl?: string;
  models: string[];
  hasKey: boolean;
}

/** 模型注册表视图状态 */
export interface ModelsState {
  providers: ProviderView[];
  defaultModel: string;
}

/** 录入供应商的输入（models 为数组，由 driver 负责序列化） */
export interface AddProviderInput {
  name: string;
  type: 'openai' | 'anthropic';
  apiKey: string;
  baseUrl?: string;
  models: string[];
}

export interface Driver {
  mode: 'demo' | 'live';
  /** 连接层错误回调（目前仅 live:SSE 断开/恢复）；null 表示已恢复 */
  onError?: ((msg: string | null) => void) | null;
  init(): Promise<void>;
  ps(): ProcessSnapshot[];
  pipelines(): Array<{ fromPid: number; toPid: number; mode: string; closed: boolean }>;
  spawn(ppid: number, params: SpawnParams): Promise<number>;
  fork(pid: number, hint?: string): Promise<number>;
  signal(pid: number, sig: string): Promise<void>;
  send(pid: number, text: string, images?: string[]): Promise<void>;
  interrupt(pid: number): Promise<void>;
  pipe(fromPid: number, toPid: number): Promise<void>;
  output(pid: number): OutputChunk[];
  subscribe(cb: () => void): () => void;
  subscribeOutput(cb: (pid: number, chunk: OutputChunk) => void): () => void;
  // —— 模型管理（可选；不实现的 driver 视为不支持，UI 隐藏相关控件）——
  getModels?(): Promise<ModelsState>;
  addProvider?(input: AddProviderInput): Promise<ModelsState>;
  removeProvider?(name: string): Promise<ModelsState>;
  setDefaultModel?(model: string): Promise<ModelsState>;
}
