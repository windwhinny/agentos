import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionStore, toSerializableSpawnOptions } from '../../src/store/sqlite-store';
import type { ChatMessage, OutputChunk, SpawnOptions } from '../../src/types';

let store: SessionStore;
let sid: string;

beforeEach(() => {
  store = new SessionStore(':memory:');
  sid = store.createSession({ title: 'test-session' });
});

afterEach(() => {
  store.close();
});

const msg = (role: ChatMessage['role'], content: string): ChatMessage => ({ role, content });

const chunk = (type: OutputChunk['type'], data: unknown): OutputChunk => ({
  type,
  data,
  ts: Date.now(),
});

describe('SessionStore: session CRUD', () => {
  it('createSession 返回 ses_ 前缀 id，getSession 读回', () => {
    expect(sid).toMatch(/^ses_/);
    const s = store.getSession(sid)!;
    expect(s.title).toBe('test-session');
    expect(s.nextPid).toBe(1);
    expect(s.runtimeMeta).toEqual({});
  });

  it('listSessions 按更新时间倒序', () => {
    const s2 = store.createSession({ title: 'second' });
    const list = store.listSessions();
    expect(list.length).toBe(2);
    expect(list[0].id).toBe(s2);
  });

  it('setNextPid / updateSessionTitle', () => {
    store.setNextPid(sid, 42);
    store.updateSessionTitle(sid, 'renamed');
    const s = store.getSession(sid)!;
    expect(s.nextPid).toBe(42);
    expect(s.title).toBe('renamed');
  });

  it('deleteSession 级联清理 process/message/part', () => {
    store.upsertProcess(sid, makeRec(1));
    store.appendMessage(sid, 1, msg('user', 'hi'));
    store.appendOutput(sid, 1, chunk('assistant', 'hello'));
    expect(store.stats(sid)).toEqual({ processes: 1, messages: 1, parts: 1 });
    store.deleteSession(sid);
    expect(store.getSession(sid)).toBeUndefined();
    expect(store.stats(sid)).toEqual({ processes: 0, messages: 0, parts: 0 });
  });
});

describe('SessionStore: process 读写', () => {
  it('upsertProcess 插入与更新（ON CONFLICT）', () => {
    store.upsertProcess(sid, makeRec(1, { state: 'running' }));
    expect(store.getProcesses(sid)[0].state).toBe('running');
    // 同 pid 再写，更新状态
    store.upsertProcess(
      sid,
      makeRec(1, {
        state: 'done',
        exitResult: {
          pid: 1,
          status: 'done',
          reason: 'DONE',
          exitCode: 0,
          output: 'ok',
          usage: zero,
          turns: 1,
        },
      }),
    );
    const p = store.getProcesses(sid)[0];
    expect(p.state).toBe('done');
    expect(p.exitResult?.output).toBe('ok');
  });

  it('getProcesses 按 pid 排序', () => {
    store.upsertProcess(sid, makeRec(3));
    store.upsertProcess(sid, makeRec(1));
    store.upsertProcess(sid, makeRec(2));
    const pids = store.getProcesses(sid).map((p) => p.pid);
    expect(pids).toEqual([1, 2, 3]);
  });

  it('spawnOptions 中 tools 函数被降级为 toolNames', () => {
    const opts: SpawnOptions = {
      task: 't',
      tools: [
        { name: 'a', description: 'd', parameters: {}, execute: () => 1 },
        { name: 'b', description: 'd', parameters: {}, execute: () => 2 },
      ],
    };
    const serial = toSerializableSpawnOptions(opts);
    expect(serial.toolNames).toEqual(['a', 'b']);
    expect((serial as Record<string, unknown>).tools).toBeUndefined();
    store.upsertProcess(sid, makeRec(1, { spawnOptions: serial }));
    const back = store.getProcesses(sid)[0];
    expect(back.spawnOptions.toolNames).toEqual(['a', 'b']);
  });
});

describe('SessionStore: message / output', () => {
  it('appendMessage 按 pid 分组、按时间排序', () => {
    store.appendMessage(sid, 1, msg('user', 'first'));
    store.appendMessage(sid, 2, msg('user', 'other-proc'));
    store.appendMessage(sid, 1, msg('assistant', 'second'));
    const m1 = store.getMessages(sid, 1);
    expect(m1.length).toBe(2);
    expect(m1[0].message.content).toBe('first');
    expect(m1[1].message.content).toBe('second');
    const all = store.getMessages(sid);
    expect(all.length).toBe(3);
  });

  it('appendOutput 按 pid 取回，保序', () => {
    store.appendOutput(sid, 1, chunk('assistant', 'a'));
    store.appendOutput(sid, 1, chunk('tool', { name: 'x' }));
    store.appendOutput(sid, 1, chunk('result', 'done'));
    const out = store.getOutput(sid, 1);
    expect(out.length).toBe(3);
    expect(out[0].type).toBe('assistant');
    expect(out[2].data).toBe('done');
  });
});

describe('SessionStore: snapshot', () => {
  it('snapshot 聚合 session + processes + messagesByPid', () => {
    store.upsertProcess(sid, makeRec(1));
    store.upsertProcess(sid, makeRec(2, { ppid: 1 }));
    store.appendMessage(sid, 1, msg('user', 'p1'));
    store.appendMessage(sid, 2, msg('assistant', 'p2'));
    const snap = store.snapshot(sid)!;
    expect(snap.processes.length).toBe(2);
    expect(snap.messagesByPid.get(1)!.length).toBe(1);
    expect(snap.messagesByPid.get(2)![0].content).toBe('p2');
  });

  it('snapshot 不存在的 session 返回 undefined', () => {
    expect(store.snapshot('ses_nope')).toBeUndefined();
  });
});

// -- helpers --

const zero = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

function makeRec(
  pid: number,
  over: Partial<{
    ppid: number;
    state: string;
    spawnOptions: Record<string, unknown>;
    exitResult: Record<string, unknown>;
  }> = {},
): import('../../src/store/sqlite-store').ProcessRecord {
  return {
    pid,
    ppid: over.ppid ?? 0,
    state: (over.state ?? 'running') as import('../../src/types').ProcessState,
    model: 'deepseek-v4-pro',
    provider: 'mock',
    usage: { ...zero },
    budget: { quota: {}, usedTokens: 0, usedTurns: 0, startedAt: Date.now() },
    turns: 0,
    depth: pid === 1 ? 0 : 1,
    spawnOptions: (over.spawnOptions ?? { task: 't' }) as never,
    createdAt: Date.now(),
    exitResult: over.exitResult as never,
  };
}
