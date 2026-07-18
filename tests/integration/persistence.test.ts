import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentRuntime } from '../../src/core/runtime';
import { MockLLMProvider, type MockResponder } from '../../src/llm/mock';
import { SessionStore } from '../../src/store/sqlite-store';
import type { Tool } from '../../src/types';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentos-'));
  dbPath = join(dir, 'test.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const addTool: Tool = {
  name: 'add',
  description: 'add two numbers',
  parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } },
  execute: (args: any) => Number(args.a) + Number(args.b),
};

function makeRuntime(store: SessionStore, responder: MockResponder) {
  return new AgentRuntime({
    providers: [new MockLLMProvider(responder)],
    defaults: { model: { model: 'deepseek-v4-pro' } },
    models: { pro: 'deepseek-v4-pro', flash: 'deepseek-v4-flash' },
    store,
  });
}

describe('持久化：attach + 增量写入', () => {
  it('init 进程完成后，session/process/message 落盘', async () => {
    const store = new SessionStore(dbPath);
    const rt = makeRuntime(store, () => ({ content: 'hello-from-init' }));
    const sid = rt.attachPersistence({ title: 'demo' });
    const init = rt.init({ task: '打招呼' });
    await init.join();

    const snap = store.snapshot(sid)!;
    expect(snap.session.title).toBe('demo');
    expect(snap.processes.length).toBe(1);
    expect(snap.processes[0].state).toBe('done');
    expect(snap.processes[0].exitResult?.output).toBe('hello-from-init');
    // system + user(task) + assistant
    const msgs = snap.messagesByPid.get(1)!;
    expect(msgs.length).toBe(2);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toBe('打招呼');
    expect(msgs[1].role).toBe('assistant');
    expect(msgs[1].content).toBe('hello-from-init');
    // 输出流落盘（V4 流式：assistant chunk data 为 { text }）
    const out = store.getOutput(sid, 1);
    expect(
      out.some(
        (c) => c.type === 'assistant' && (c.data as { text?: string }).text === 'hello-from-init',
      ),
    ).toBe(true);
    store.close();
  });

  it('spawn 子进程，父子拓扑与各自消息落盘', async () => {
    const store = new SessionStore(dbPath);
    const rt = makeRuntime(store, (msgs) => {
      const task = msgs.find((m) => m.role === 'user')?.content ?? '';
      if (task === 'parent') return { content: 'parent-done' };
      return { content: 'child-done' };
    });
    const sid = rt.attachPersistence();
    const init = rt.init({ task: 'parent' });
    const child = init.spawn({ task: 'child' });
    await Promise.all([init.join(), child.join()]);

    const snap = store.snapshot(sid)!;
    expect(snap.processes.length).toBe(2);
    const p2 = snap.processes.find((p) => p.pid === 2)!;
    expect(p2.ppid).toBe(1);
    expect(p2.depth).toBe(1);
    expect(snap.messagesByPid.get(1)!.length).toBe(2);
    expect(snap.messagesByPid.get(2)![1].content).toBe('child-done');
    store.close();
  });

  it('工具调用循环：tool 消息与 assistant 输出均落盘', async () => {
    const store = new SessionStore(dbPath);
    const rt = makeRuntime(store, (msgs, n) =>
      n === 1
        ? { content: '', toolCalls: [{ name: 'add', arguments: { a: 1, b: 2 } }] }
        : { content: `结果是 ${msgs.filter((m) => m.role === 'tool')[0].content}` },
    );
    const sid = rt.attachPersistence();
    const init = rt.init({ task: '算一下', tools: [addTool] });
    await init.join();

    const msgs = store.snapshot(sid)!.messagesByPid.get(1)!;
    // user + assistant(tool_call) + tool + assistant
    expect(msgs.length).toBe(4);
    expect(msgs[2].role).toBe('tool');
    expect(msgs[2].content).toBe('3');
    store.close();
  });
});

describe('持久化：resume 跨 runtime 恢复', () => {
  it('新 runtime 从 store 恢复进程树拓扑与对话上下文', async () => {
    const store = new SessionStore(dbPath);
    const rt1 = makeRuntime(store, (msgs) => {
      const task = msgs.find((m) => m.role === 'user')?.content ?? '';
      if (task === 'parent') return { content: 'parent-out' };
      return { content: 'child-out' };
    });
    const sid = rt1.attachPersistence({ title: 'resume-test' });
    const init = rt1.init({ task: 'parent' });
    const child = init.spawn({ task: 'child' });
    await Promise.all([init.join(), child.join()]);
    const toolRegistry = new Map([['add', addTool]]);
    store.close();

    // 新 runtime，新 store 实例打开同一 db 文件
    const store2 = new SessionStore(dbPath);
    const rt2 = makeRuntime(store2, () => ({ content: 'x' }));
    rt2.resume(sid, { toolRegistry });

    const ps = rt2.ps();
    expect(ps.length).toBe(2);
    const p1 = ps.find((p) => p.pid === 1)!;
    const p2 = ps.find((p) => p.pid === 2)!;
    expect(p1.state).toBe('done');
    expect(p2.ppid).toBe(1);
    expect(p2.state).toBe('done');
    expect(p2.model).toBe('deepseek-v4-pro');

    // 对话上下文恢复
    const proc1 = rt2.get(1)!;
    expect(proc1.context.messages.length).toBe(2);
    expect(proc1.context.messages[1].content).toBe('parent-out');
    const proc2 = rt2.get(2)!;
    expect(proc2.context.messages[1].content).toBe('child-out');

    // 输出流恢复
    const out = store2.getOutput(sid, 1);
    expect(out.some((c) => c.type === 'result' && c.data === 'parent-out')).toBe(true);
    store2.close();
  });

  it('resume 后继续运行：新消息持续落盘', async () => {
    const store = new SessionStore(dbPath);
    const rt1 = makeRuntime(store, () => ({ content: 'first' }));
    const sid = rt1.attachPersistence();
    const init = rt1.init({ task: 'go' });
    await init.join();
    store.close();

    // 恢复
    const store2 = new SessionStore(dbPath);
    const rt2 = makeRuntime(store2, () => ({ content: 'first' }));
    rt2.resume(sid);
    // 恢复后挂了 hook，对已 done 进程无副作用；新建进程会落盘
    const newChild = rt2.get(1)!.spawn({ task: 'new-child' });
    await newChild.join();
    const snap = store2.snapshot(sid)!;
    expect(snap.processes.length).toBe(2);
    expect(snap.processes.find((p) => p.pid === 2)?.exitResult?.output).toBe('first');
    store2.close();
  });

  it('resume 不存在的 session 抛错', () => {
    const store = new SessionStore(dbPath);
    const rt = makeRuntime(store, () => ({ content: 'x' }));
    expect(() => rt.resume('ses_nope')).toThrow('session not found');
    store.close();
  });
});

describe('持久化：detach / flush', () => {
  it('detach 后新进程不再落盘', async () => {
    const store = new SessionStore(dbPath);
    const rt = makeRuntime(store, () => ({ content: 'ok' }));
    const sid = rt.attachPersistence();
    const init = rt.init({ task: 'p' });
    await init.join();
    rt.detachPersistence();
    const child = rt.get(1)!.spawn({ task: 'c' });
    await child.join();
    // 只有 init 落盘
    expect(store.snapshot(sid)!.processes.length).toBe(1);
    store.close();
  });

  it('flush 主动全量落盘 nextPid', () => {
    const store = new SessionStore(dbPath);
    const rt = makeRuntime(store, () => ({ content: 'ok' }));
    const sid = rt.attachPersistence();
    rt.init({ task: 'p' });
    rt.flush();
    expect(store.getSession(sid)!.nextPid).toBe(2);
    store.close();
  });
});
