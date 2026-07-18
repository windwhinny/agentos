import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  LLMProvider,
  StreamHandlers,
  ToolCall,
} from '../types';
import { AbortError } from '../utils';

// 内联实现 OpenAI 消息转换，避免与 deepseek.ts 耦合
function toOpenAI(m: ChatMessage): Record<string, unknown> {
  const base: Record<string, unknown> = { role: m.role, content: m.content };
  if (m.tool_calls) {
    base.tool_calls = m.tool_calls.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: tc.arguments },
    }));
  }
  if (m.tool_call_id) base.tool_call_id = m.tool_call_id;
  if (m.name) base.name = m.name;
  return base;
}

export interface OpenAIOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  organization?: string; // OpenAI org header
  defaultHeaders?: Record<string, string>; // 自定义 header，如代理 / 自定义网关
  name?: string; // provider 名（registry 区分多实例用），默认 'openai'
}

/** 通用 OpenAI Chat Completions 兼容协议 provider */
export class OpenAIProvider implements LLMProvider {
  readonly name: string;
  constructor(private readonly opts: OpenAIOptions) {
    this.name = opts.name ?? 'openai';
  }

  /** 可序列化配置（worker 内重建用，仅含显式设置项，apiKey 以引用传递） */
  get serializableConfig(): OpenAIOptions {
    const cfg: OpenAIOptions = { apiKey: this.opts.apiKey };
    if (this.opts.baseUrl !== undefined) cfg.baseUrl = this.opts.baseUrl;
    if (this.opts.timeoutMs !== undefined) cfg.timeoutMs = this.opts.timeoutMs;
    if (this.opts.organization !== undefined) cfg.organization = this.opts.organization;
    if (this.opts.defaultHeaders !== undefined) cfg.defaultHeaders = this.opts.defaultHeaders;
    if (this.opts.name !== undefined) cfg.name = this.opts.name;
    return cfg;
  }

  private wireAbort(req: ChatRequest): { controller: AbortController; cleanup: () => void } {
    const controller = new AbortController();
    const timeoutMs = this.opts.timeoutMs ?? 60_000;
    const timer = setTimeout(
      () => controller.abort(new Error(`llm timeout ${timeoutMs}ms`)),
      timeoutMs,
    );
    const onOuterAbort = () => controller.abort(req.signal!.reason);
    if (req.signal?.aborted) controller.abort(req.signal.reason);
    else req.signal?.addEventListener('abort', onOuterAbort, { once: true });
    return {
      controller,
      cleanup: () => {
        clearTimeout(timer);
        req.signal?.removeEventListener('abort', onOuterAbort);
      },
    };
  }

  private buildBody(req: ChatRequest, stream: boolean): string {
    return JSON.stringify({
      model: req.model,
      messages: req.messages.map(toOpenAI),
      ...(req.tools?.length
        ? {
            tools: req.tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
          }
        : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
      ...(req.topP !== undefined ? { top_p: req.topP } : {}),
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    });
  }

  private headers(): Record<string, string> {
    // defaultHeaders 置于末尾，允许自定义网关覆盖 Authorization 等
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.opts.apiKey}`,
    };
    if (this.opts.organization) headers['OpenAI-Organization'] = this.opts.organization;
    if (this.opts.defaultHeaders) Object.assign(headers, this.opts.defaultHeaders);
    return headers;
  }

  private url(): string {
    return `${this.opts.baseUrl ?? 'https://api.openai.com/v1'}/chat/completions`;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const { controller, cleanup } = this.wireAbort(req);
    try {
      const res = await fetch(this.url(), {
        method: 'POST',
        headers: this.headers(),
        body: this.buildBody(req, false),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as any;
      const msg = data.choices?.[0]?.message ?? {};
      const tool_calls = msg.tool_calls?.map((tc: any) => ({
        id: tc.id,
        name: tc.function?.name ?? '',
        arguments: tc.function?.arguments ?? '{}',
      }));
      return {
        message: { content: msg.content ?? '', tool_calls },
        usage: {
          promptTokens: data.usage?.prompt_tokens ?? 0,
          completionTokens: data.usage?.completion_tokens ?? 0,
          totalTokens: data.usage?.total_tokens ?? 0,
        },
        model: data.model ?? req.model,
      };
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') throw new AbortError();
      throw err;
    } finally {
      cleanup();
    }
  }

  /** SSE 流式：delta.content / delta.reasoning_content / delta.tool_calls 累积推送 */
  async chatStream(req: ChatRequest, handlers: StreamHandlers): Promise<ChatResponse> {
    const { controller, cleanup } = this.wireAbort(req);
    try {
      const res = await fetch(this.url(), {
        method: 'POST',
        headers: this.headers(),
        body: this.buildBody(req, true),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${await res.text()}`);
      if (!res.body) throw new Error('OpenAI API: empty stream body');

      let content = '';
      let reasoning = '';
      const toolParts = new Map<number, ToolCall>();
      let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      let model = req.model;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const payload = t.slice(5).trim();
          if (payload === '[DONE]') continue;
          let evt: any;
          try {
            evt = JSON.parse(payload);
          } catch {
            continue;
          }
          if (evt.model) model = evt.model;
          if (evt.usage) {
            usage = {
              promptTokens: evt.usage.prompt_tokens ?? 0,
              completionTokens: evt.usage.completion_tokens ?? 0,
              totalTokens: evt.usage.total_tokens ?? 0,
            };
          }
          const delta = evt.choices?.[0]?.delta;
          if (!delta) continue;
          if (delta.reasoning_content) {
            reasoning += delta.reasoning_content;
            handlers.onThinking?.(reasoning);
          }
          if (delta.content) {
            content += delta.content;
            handlers.onText?.(content);
          }
          for (const tc of delta.tool_calls ?? []) {
            const idx = tc.index ?? 0;
            const cur = toolParts.get(idx) ?? { id: '', name: '', arguments: '' };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name += tc.function.name;
            if (tc.function?.arguments) cur.arguments += tc.function.arguments;
            toolParts.set(idx, cur);
          }
        }
      }
      const tool_calls = toolParts.size
        ? [...toolParts.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c)
        : undefined;
      if (!usage.totalTokens) {
        // 代理不回 usage 时的粗估（保证预算链有账可记）
        const promptChars = req.messages.reduce(
          (a, m) => a + JSON.stringify(m.content ?? '').length,
          0,
        );
        usage = {
          promptTokens: Math.ceil(promptChars / 4),
          completionTokens: Math.ceil((content.length + reasoning.length) / 4),
          totalTokens: 0,
        };
        usage.totalTokens = usage.promptTokens + usage.completionTokens;
      }
      return {
        message: {
          content,
          ...(reasoning ? { reasoning } : {}),
          ...(tool_calls?.length ? { tool_calls } : {}),
        },
        usage,
        model,
      };
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') throw new AbortError();
      throw err;
    } finally {
      cleanup();
    }
  }
}
