// Anthropic Messages API 兼容 provider：把内部 ChatMessage 协议转换为 Anthropic blocks 协议
// （system 提升为顶层字段、tool_calls → tool_use、tool 结果合并为 user 消息内的 tool_result），
// 支持非流式 chat 与 SSE 流式 chatStream，usage/abort/timeout 行为与 openai.ts 对齐。
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  LLMProvider,
  StreamHandlers,
  ToolCall,
} from '../types';
import { textOf } from '../types';
import { AbortError } from '../utils';

type AnthropicBlock = Record<string, unknown>;
interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicBlock[];
}

/** 多模态 ContentPart → Anthropic block（data URL 转 base64 source，http URL 转 url source） */
function toAnthropicContent(content: ChatMessage['content']): string | AnthropicBlock[] {
  if (typeof content === 'string') return content;
  return content.map((p) => {
    if (p.type === 'text') return { type: 'text', text: p.text };
    const url = p.image_url.url;
    const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
    if (m) return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
    return { type: 'image', source: { type: 'url', url } };
  });
}

/** 内部消息 → Anthropic { system, messages }；连续 tool 消息合并进同一条 user 消息 */
function toAnthropic(messages: ChatMessage[]): { system?: string; messages: AnthropicMessage[] } {
  const systemParts: string[] = [];
  const out: AnthropicMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      const t = textOf(m.content);
      if (t) systemParts.push(t);
      continue;
    }
    if (m.role === 'tool') {
      // Anthropic 要求 tool_result 包在 user 消息里；连续 tool 结果合并为同一条 user 消息
      const block: AnthropicBlock = {
        type: 'tool_result',
        tool_use_id: m.tool_call_id ?? '',
        content: textOf(m.content),
      };
      const last = out[out.length - 1];
      if (
        last &&
        last.role === 'user' &&
        Array.isArray(last.content) &&
        last.content.every((b) => b.type === 'tool_result')
      ) {
        last.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
      continue;
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const blocks: AnthropicBlock[] = [];
      const t = textOf(m.content);
      if (t) blocks.push({ type: 'text', text: t });
      for (const tc of m.tool_calls) {
        let input: unknown = {};
        try {
          input = JSON.parse(tc.arguments || '{}');
        } catch {
          input = {};
        }
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
      }
      out.push({ role: 'assistant', content: blocks });
      continue;
    }
    out.push({ role: m.role, content: toAnthropicContent(m.content) });
  }
  return { ...(systemParts.length ? { system: systemParts.join('\n') } : {}), messages: out };
}

export interface AnthropicOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  defaultHeaders?: Record<string, string>; // 自定义 header，如代理 / 自定义网关
  name?: string; // provider 名（registry 区分多实例用），默认 'anthropic'
}

/** Anthropic Messages API 兼容 provider */
export class AnthropicProvider implements LLMProvider {
  readonly name: string;
  constructor(private readonly opts: AnthropicOptions) {
    this.name = opts.name ?? 'anthropic';
  }

  /** 可序列化配置（worker 内重建用，仅含显式设置项，apiKey 以引用传递） */
  get serializableConfig(): AnthropicOptions {
    const cfg: AnthropicOptions = { apiKey: this.opts.apiKey };
    if (this.opts.baseUrl !== undefined) cfg.baseUrl = this.opts.baseUrl;
    if (this.opts.timeoutMs !== undefined) cfg.timeoutMs = this.opts.timeoutMs;
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
    const { system, messages } = toAnthropic(req.messages);
    return JSON.stringify({
      model: req.model,
      messages,
      ...(system !== undefined ? { system } : {}),
      ...(req.tools?.length
        ? {
            tools: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters,
            })),
          }
        : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.topP !== undefined ? { top_p: req.topP } : {}),
      max_tokens: req.maxTokens ?? 4096, // Anthropic 必填
      ...(stream ? { stream: true } : {}),
    });
  }

  private headers(): Record<string, string> {
    // defaultHeaders 置于末尾，允许自定义网关覆盖 x-api-key 等
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': this.opts.apiKey,
      'anthropic-version': '2023-06-01',
    };
    if (this.opts.defaultHeaders) Object.assign(headers, this.opts.defaultHeaders);
    return headers;
  }

  private url(): string {
    return `${this.opts.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`;
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
      if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as any;
      let content = '';
      const tool_calls: ToolCall[] = [];
      for (const b of data.content ?? []) {
        if (b.type === 'text') content += b.text ?? '';
        else if (b.type === 'tool_use') {
          tool_calls.push({
            id: b.id ?? '',
            name: b.name ?? '',
            arguments: JSON.stringify(b.input ?? {}),
          });
        }
      }
      const promptTokens = data.usage?.input_tokens ?? 0;
      const completionTokens = data.usage?.output_tokens ?? 0;
      return {
        message: { content, ...(tool_calls.length ? { tool_calls } : {}) },
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
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

  /** SSE 流式：text_delta / thinking_delta / input_json_delta 累积推送 */
  async chatStream(req: ChatRequest, handlers: StreamHandlers): Promise<ChatResponse> {
    const { controller, cleanup } = this.wireAbort(req);
    try {
      const res = await fetch(this.url(), {
        method: 'POST',
        headers: this.headers(),
        body: this.buildBody(req, true),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
      if (!res.body) throw new Error('Anthropic API: empty stream body');

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
          let evt: any;
          try {
            evt = JSON.parse(payload);
          } catch {
            continue;
          }
          if (evt.type === 'message_start') {
            const msg = evt.message ?? {};
            if (msg.model) model = msg.model;
            if (msg.usage) {
              usage.promptTokens = msg.usage.input_tokens ?? 0;
              usage.completionTokens = msg.usage.output_tokens ?? 0;
            }
          } else if (evt.type === 'content_block_start') {
            const b = evt.content_block;
            if (b?.type === 'tool_use') {
              toolParts.set(evt.index ?? 0, {
                id: b.id ?? '',
                name: b.name ?? '',
                arguments: '',
              });
            }
          } else if (evt.type === 'content_block_delta') {
            const d = evt.delta ?? {};
            if (d.type === 'text_delta') {
              content += d.text ?? '';
              handlers.onText?.(content);
            } else if (d.type === 'thinking_delta') {
              reasoning += d.thinking ?? '';
              handlers.onThinking?.(reasoning);
            } else if (d.type === 'input_json_delta') {
              const cur = toolParts.get(evt.index ?? 0) ?? { id: '', name: '', arguments: '' };
              cur.arguments += d.partial_json ?? '';
              toolParts.set(evt.index ?? 0, cur);
            }
          } else if (evt.type === 'message_delta') {
            // output_tokens 为累计值，直接采用
            if (evt.usage?.output_tokens !== undefined) {
              usage.completionTokens = evt.usage.output_tokens;
            }
          }
          // ping / content_block_stop / message_stop 等仅标志阶段结束，忽略
        }
      }
      usage.totalTokens = usage.promptTokens + usage.completionTokens;
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
