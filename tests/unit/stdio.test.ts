import { describe, it, expect } from 'vitest';
import { StdinQueue, StdoutStream } from '../../src/ipc/stdio';
import { PipeClosedError } from '../../src/errors';

const msg = (payload: string, from = 0) => ({
  from,
  to: 1,
  kind: 'user' as const,
  payload,
  ts: Date.now(),
});

describe('StdinQueue', () => {
  it('write + drain 保持顺序', async () => {
    const q = new StdinQueue(10);
    await q.write(msg('a'));
    await q.write(msg('b'));
    const out = q.drain();
    expect(out.map((m) => m.payload)).toEqual(['a', 'b']);
    expect(q.drain()).toEqual([]);
  });

  it('interrupt 消息插到队首', async () => {
    const q = new StdinQueue(10);
    await q.write(msg('normal'));
    await q.write({ ...msg('urgent'), kind: 'interrupt' });
    expect(q.drain()[0].payload).toBe('urgent');
  });

  it('队列满时写端阻塞（背压），drain 后放行', async () => {
    const q = new StdinQueue(1);
    await q.write(msg('x'));
    let unblocked = false;
    const p = q.write(msg('y')).then(() => {
      unblocked = true;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(unblocked).toBe(false);
    q.drain();
    await p;
    expect(unblocked).toBe(true);
  });

  it('close 后写入抛 EPIPE', async () => {
    const q = new StdinQueue(10);
    q.close();
    await expect(q.write(msg('z'))).rejects.toThrow(PipeClosedError);
  });
});

describe('StdoutStream', () => {
  it('push + read + since 过滤', () => {
    const s = new StdoutStream(10);
    const t0 = Date.now();
    s.push({ type: 'assistant', data: 'hello', ts: Date.now() });
    expect(s.read().length).toBe(1);
    expect(s.read(t0 + 1000).length).toBe(0);
  });

  it('环形缓冲超容量淘汰最旧', () => {
    const s = new StdoutStream(3);
    for (let i = 0; i < 5; i++) s.push({ type: 'assistant', data: i, ts: i });
    expect(s.read().map((c) => c.data)).toEqual([2, 3, 4]);
  });

  it('tap 实时订阅且可退订', () => {
    const s = new StdoutStream(10);
    const seen: unknown[] = [];
    const off = s.tap((c) => seen.push(c.data));
    s.push({ type: 'assistant', data: 'one', ts: 1 });
    off();
    s.push({ type: 'assistant', data: 'two', ts: 2 });
    expect(seen).toEqual(['one']);
  });
});
