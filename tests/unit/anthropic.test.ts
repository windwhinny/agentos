import { describe, it, expect, vi, afterEach } from 'vitest';
import { AnthropicProvider } from '../../src/llm/anthropic';
import type { ChatRequest } from '../../src/types';

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sseResponse(sse: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(sse));
      c.close();
    },
  });
  return new Response(stream, { status: 200 });
}

/** 取 mock fetch 第 0 次调用的 { url, init, body } */
function callArgs(mockFetch: ReturnType<typeof vi.fn>) {
  const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
  return { url, init, body: JSON.parse(init.body as string) };
}

describe('AnthropicProvider.chat（非流式）', () => {
  it('请求头/消息转换正确，响应解析为 ChatResponse', async () => {
    const mockFetch = vi.fn(async () =>
      jsonResponse({
        model: 'claude-sonnet-4-20250514',
        content: [
          { type: 'text', text: '好的，我来查一下。' },
          { type: 'tool_use', id: 'toolu_01', name: 'get_weather', input: { city: 'Paris' } },
        ],
        usage: { input_tokens: 120, output_tokens: 34 },
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const provider = new AnthropicProvider({ apiKey: 'sk-test-key' });
    const req: ChatRequest = {
      model: 'claude-sonnet-4-20250514',
      messages: [
        { role: 'system', content: '你是助手。' },
        { role: 'user', content: '巴黎天气如何？' },
        {
          role: 'assistant',
          content: '我查一下。',
          tool_calls: [{ id: 'toolu_00', name: 'get_weather', arguments: '{"city":"Paris"}' }],
        },
        { role: 'tool', content: '晴，25°C', tool_call_id: 'toolu_00' },
        { role: 'tool', content: '湿度 40%', tool_call_id: 'toolu_00' },
      ],
      tools: [
        {
          name: 'get_weather',
          description: '查询天气',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      ],
      temperature: 0.5,
      topP: 0.9,
    };
    const res = await provider.chat(req);

    // —— 请求格式 ——
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const { url, init, body } = callArgs(mockFetch);
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-test-key');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['Content-Type']).toBe('application/json');

    // system 提升为顶层字段，不进 messages
    expect(body.system).toBe('你是助手。');
    expect(body.messages.some((m: any) => m.role === 'system')).toBe(false);

    // user 普通文本
    expect(body.messages[0]).toEqual({ role: 'user', content: '巴黎天气如何？' });

    // assistant 带 tool_calls → text + tool_use blocks（arguments 反序列化为 input 对象）
    expect(body.messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: '我查一下。' },
        { type: 'tool_use', id: 'toolu_00', name: 'get_weather', input: { city: 'Paris' } },
      ],
    });

    // 连续 tool 消息合并为一条 user 消息里的多个 tool_result blocks
    expect(body.messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_00', content: '晴，25°C' },
        { type: 'tool_result', tool_use_id: 'toolu_00', content: '湿度 40%' },
      ],
    });
    expect(body.messages).toHaveLength(3);

    // 工具与参数透传
    expect(body.tools).toEqual([
      {
        name: 'get_weather',
        description: '查询天气',
        input_schema: { type: 'object', properties: { city: { type: 'string' } } },
      },
    ]);
    expect(body.temperature).toBe(0.5);
    expect(body.top_p).toBe(0.9);
    expect(body.max_tokens).toBe(4096); // Anthropic 必填，默认 4096
    expect(body.stream).toBeUndefined();

    // —— 响应解析 ——
    expect(res.message.content).toBe('好的，我来查一下。');
    expect(res.message.tool_calls).toEqual([
      { id: 'toolu_01', name: 'get_weather', arguments: '{"city":"Paris"}' },
    ]);
    expect(res.usage).toEqual({ promptTokens: 120, completionTokens: 34, totalTokens: 154 });
    expect(res.model).toBe('claude-sonnet-4-20250514');
  });
});

describe('AnthropicProvider.chatStream（SSE 流式）', () => {
  it('累积 text/tool_use 增量，usage 来自 message_start + message_delta', async () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-20250514","usage":{"input_tokens":12,"output_tokens":1}}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"，世界"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"get_weather"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"Paris\\"}"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":1}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":25}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');

    const mockFetch = vi.fn(async () => sseResponse(sse));
    vi.stubGlobal('fetch', mockFetch);

    const provider = new AnthropicProvider({ apiKey: 'sk-test-key' });
    const texts: string[] = [];
    const res = await provider.chatStream(
      {
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: '打个招呼' }],
      },
      { onText: (acc) => texts.push(acc) },
    );

    // 请求带 stream: true
    const { body } = callArgs(mockFetch);
    expect(body.stream).toBe(true);

    // onText 收到累积文本
    expect(texts).toEqual(['你好', '你好，世界']);
    expect(res.message.content).toBe('你好，世界');

    // input_json_delta 拼成完整 JSON
    expect(res.message.tool_calls).toEqual([
      { id: 'toolu_1', name: 'get_weather', arguments: '{"city":"Paris"}' },
    ]);
    expect(JSON.parse(res.message.tool_calls![0].arguments)).toEqual({ city: 'Paris' });

    // usage：input_tokens 来自 message_start，output_tokens 来自 message_delta（累计值）
    expect(res.usage).toEqual({ promptTokens: 12, completionTokens: 25, totalTokens: 37 });
    expect(res.model).toBe('claude-sonnet-4-20250514');
  });
});

describe('AnthropicProvider 错误处理', () => {
  it('HTTP 429 抛出带状态码的错误', async () => {
    const mockFetch = vi.fn(async () => new Response('rate limited', { status: 429 }));
    vi.stubGlobal('fetch', mockFetch);

    const provider = new AnthropicProvider({ apiKey: 'sk-test-key' });
    await expect(
      provider.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow('Anthropic API 429');
  });
});
