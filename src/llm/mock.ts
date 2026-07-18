import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  LLMProvider,
  StreamHandlers,
  Usage,
} from '../types';
import { abortableSleep } from '../utils';

export interface MockStep {
  content?: string;
  /** 思考链（模拟 reasoning_content，用于测试折叠 thinking 渲染） */
  thinking?: string;
  toolCalls?: Array<{ name: string; arguments?: Record<string, unknown> }>;
  usage?: Partial<Usage>;
  delayMs?: number;
  error?: Error;
}

export type MockResponder = (
  messages: ChatMessage[],
  callCount: number,
  req: ChatRequest,
) => MockStep | Promise<MockStep>;

/** 把文本切成至多 maxPieces 段（模拟流式 token 到达） */
function splitPieces(text: string, maxPieces: number): string[] {
  if (!text) return [];
  const size = Math.max(1, Math.ceil(text.length / maxPieces));
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/** 脚本化 LLM：数组（FIFO）或函数（按消息内容路由），记录全部调用供断言 */
export class MockLLMProvider implements LLMProvider {
  readonly name = 'mock';
  readonly calls: ChatRequest[] = [];
  private count = 0;
  private queue: MockStep[] | undefined;
  private responder: MockResponder | undefined;
  private readonly streamDelayMs: number;

  constructor(script: MockStep[] | MockResponder, opts?: { streamDelayMs?: number }) {
    if (Array.isArray(script)) this.queue = [...script];
    else this.responder = script;
    this.streamDelayMs = opts?.streamDelayMs ?? 5;
  }

  /** 数组脚本可序列化（worker 内重建用） */
  get serializableScript(): MockStep[] | undefined {
    return this.queue ? [...this.queue] : undefined;
  }

  private async nextStep(req: ChatRequest): Promise<{ n: number; step: MockStep }> {
    this.calls.push(req);
    const n = ++this.count;
    const step = this.responder ? await this.responder(req.messages, n, req) : this.queue?.shift();
    if (!step) throw new Error('mock script exhausted');
    return { n, step };
  }

  private buildResponse(n: number, step: MockStep, req: ChatRequest): ChatResponse {
    const tool_calls = step.toolCalls?.map((tc, i) => ({
      id: `call_${n}_${i}`,
      name: tc.name,
      arguments: JSON.stringify(tc.arguments ?? {}),
    }));
    const usage: Usage = {
      promptTokens: step.usage?.promptTokens ?? 10,
      completionTokens: step.usage?.completionTokens ?? 5,
      totalTokens: step.usage?.totalTokens ?? 15,
    };
    return {
      message: {
        content: step.content ?? '',
        ...(step.thinking ? { reasoning: step.thinking } : {}),
        tool_calls,
      },
      usage,
      model: req.model,
    };
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const { n, step } = await this.nextStep(req);
    if (step.delayMs) await abortableSleep(step.delayMs, req.signal);
    if (step.error) throw step.error;
    return this.buildResponse(n, step, req);
  }

  /** 模拟流式：delayMs 视为「首 token 前时延」，随后分段推送 thinking / content */
  async chatStream(req: ChatRequest, handlers: StreamHandlers): Promise<ChatResponse> {
    const { n, step } = await this.nextStep(req);
    if (step.delayMs) await abortableSleep(step.delayMs, req.signal);
    if (step.error) throw step.error;
    let acc = '';
    for (const p of splitPieces(step.thinking ?? '', 12)) {
      acc += p;
      handlers.onThinking?.(acc);
      await abortableSleep(this.streamDelayMs, req.signal);
    }
    acc = '';
    for (const p of splitPieces(step.content ?? '', 12)) {
      acc += p;
      handlers.onText?.(acc);
      await abortableSleep(this.streamDelayMs, req.signal);
    }
    return this.buildResponse(n, step, req);
  }
}
