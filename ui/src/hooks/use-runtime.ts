import { useEffect, useMemo, useRef, useState } from 'react';
import type { AddProviderInput, Driver, ModelsState, SpawnParams } from '@/lib/driver';
import { LocalDriver } from '@/lib/local-driver';
import { RemoteDriver } from '@/lib/remote-driver';
import type { OutputChunk, ProcessSnapshot } from '@/agentos/types';
import { useI18n } from '@/i18n';

export interface LogEntry {
  ts: number;
  text: string;
}

export function useRuntime() {
  const { t } = useI18n();
  // 挂载期 effect 里的常驻回调(subscribe/init)闭包捕获的是首次渲染的 t,
  // 经 ref 转发,保证切换语言后新产生的事件流日志仍按当前语言输出
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);
  const [driver, setDriver] = useState<Driver | null>(null);
  const [mode, setMode] = useState<'demo' | 'live'>('demo');
  const [snaps, setSnaps] = useState<ProcessSnapshot[]>([]);
  const [pipes, setPipes] = useState<Array<{ fromPid: number; toPid: number; mode: string; closed: boolean }>>([]);
  const [outputs, setOutputs] = useState<Record<number, OutputChunk[]>>({});
  // 用户消息回显:内核 stdout 只承载进程输出,用户 stdin 消息不在其中——
  // 这里在 UI 层补 echo(按 pid 分桶,渲染时与进程输出按 ts 归并),否则用户看不到自己发过什么
  const [echoes, setEchoes] = useState<Record<number, OutputChunk[]>>({});
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [selectedPid, setSelectedPid] = useState<number>(1);
  const [error, setError] = useState<string | null>(null);
  /** 模型注册表；undefined 表示 driver 不支持或尚未加载成功（UI 隐藏模型控件） */
  const [models, setModels] = useState<ModelsState | undefined>(undefined);
  const prevStates = useRef(new Map<number, string>());

  const log = (text: string) => setLogs((prev) => [...prev.slice(-199), { ts: Date.now(), text }]);

  useEffect(() => {
    const server = new URLSearchParams(window.location.search).get('server');
    const d: Driver = server ? new RemoteDriver(server) : new LocalDriver();
    setMode(d.mode);
    d.onError = (msg) => setError(msg); // SSE 断开/恢复（live）
    const offState = d.subscribe(() => {
      const next = d.ps();
      // diff 生成事件日志
      for (const s of next) {
        const prev = prevStates.current.get(s.pid);
        // blocked↔running 是每次 LLM 调用/工具执行的正常抖动,一秒好几条,刷屏无信息量——不记
        const churn =
          (prev === 'blocked' && s.state === 'running') || (prev === 'running' && s.state === 'blocked');
        if (prev === undefined)
          log(tRef.current('log.processCreated', { pid: s.pid, name: s.name ?? '', ppid: s.ppid, model: s.model }));
        else if (prev !== s.state && !churn)
          log(tRef.current('log.stateChange', { pid: s.pid, prev, next: s.state }) + (s.exit ? ` (${s.exit.reason})` : ''));
        prevStates.current.set(s.pid, s.state);
      }
      setSnaps([...next]);
      setPipes([...d.pipelines()]);
    });
    const offOut = d.subscribeOutput((pid, chunk) => {
      setOutputs((prev) => {
        const list = [...(prev[pid] ?? [])];
        if (chunk.id) {
          // 流式帧：同 id 覆盖（纯函数更新，可安全重放）
          const i = list.findIndex((c) => c.id === chunk.id);
          if (i >= 0) list[i] = chunk;
          else list.push(chunk);
        } else {
          list.push(chunk);
        }
        return { ...prev, [pid]: list.slice(-500) };
      });
    });
    d.init()
      .then(() => {
        const init = d.ps();
        for (const s of init) {
          prevStates.current.set(s.pid, s.state);
          // 立即求值缓冲区：若在 updater 内读可变缓冲区，排在后面的 append 更新会重复叠加
          const buffered = d.output(s.pid);
          setOutputs((prev) => ({ ...prev, [s.pid]: buffered }));
        }
        setSnaps(init);
        setPipes(d.pipelines());
        log(tRef.current('log.runtimeReady', { mode: d.mode, count: init.length }));
        setDriver(d);
        // 模型注册表：加载失败不阻断控制台主流程，models 保持 undefined
        if (d.getModels) {
          d.getModels()
            .then(setModels)
            .catch((e) => log(tRef.current('log.modelsLoadFailed', { message: (e as Error)?.message ?? String(e) })));
        }
      })
      .catch((e) => setError(String(e)));
    return () => {
      offState();
      offOut();
    };
  }, []);

  const select = (pid: number) => {
    setSelectedPid(pid);
    if (driver) {
      const buffered = driver.output(pid); // 立即求值，理由同上
      setOutputs((prev) => ({ ...prev, [pid]: buffered }));
    }
  };

  /** 包装所有操作:驱动层错误不再静默(unhandled rejection),统一落入事件流 */
  const guard = <T>(what: string, fn: () => Promise<T>): Promise<T | null> =>
    fn().catch((e) => {
      log(t('log.actionFailed', { what, message: (e as Error)?.message ?? String(e) }));
      return null;
    });

  const actions = {
    spawn: async (ppid: number, params: SpawnParams): Promise<number | null> => {
      if (!driver) return null;
      return guard('spawn', async () => {
        const pid = await driver.spawn(ppid, params);
        log(t('log.spawned', { pid, ppid, model: params.model ? t('log.spawnedModel', { model: params.model }) : '' }));
        return pid;
      });
    },
    fork: async (pid: number, hint?: string): Promise<number | null> => {
      if (!driver) return null;
      return guard('fork', async () => {
        const child = await driver.fork(pid, hint);
        log(t('log.forked', { pid, child }));
        return child;
      });
    },
    signal: async (pid: number, sig: string) => {
      if (!driver) return;
      await guard(`signal ${sig}`, async () => {
        await driver.signal(pid, sig);
        log(t('log.signal', { sig, pid }));
      });
    },
    send: async (pid: number, text: string, images?: string[]) => {
      if (!driver) return;
      await guard('send', async () => {
        await driver.send(pid, text, images);
        const echo: OutputChunk = { type: 'user', data: { text, images }, ts: Date.now() };
        setEchoes((prev) => ({ ...prev, [pid]: [...(prev[pid] ?? []), echo].slice(-100) }));
        log(t('log.sent', { pid, text: text.slice(0, 40), images: images?.length ? t('log.sentImages', { count: images.length }) : '' }));
      });
    },
    interrupt: async (pid: number) => {
      if (!driver) return;
      await guard('interrupt', async () => {
        await driver.interrupt(pid);
        log(t('log.interrupted', { pid }));
      });
    },
    pipe: async (a: number, b: number) => {
      if (!driver) return;
      // 管道环守卫:若 b 已能经开放管道到达 a,则 a→b 会成环(输出在环上无限循环)
      const open = driver.pipelines().filter((p) => !p.closed);
      const reaches = (from: number, target: number, seen = new Set<number>()): boolean => {
        if (from === target) return true;
        if (seen.has(from)) return false;
        seen.add(from);
        return open.filter((p) => p.fromPid === from).some((p) => reaches(p.toPid, target, seen));
      };
      if (reaches(b, a)) {
        log(t('log.pipeCycleRejected', { a, b }));
        return;
      }
      await guard('pipe', async () => {
        await driver.pipe(a, b);
        log(t('log.piped', { a, b }));
        setPipes([...driver.pipelines()]);
      });
    },
    // —— 模型管理:错误直接 throw 给调用方(组件负责红字展示/回退),不走 guard 吞错 ——
    addProvider: async (input: AddProviderInput): Promise<ModelsState> => {
      if (!driver?.addProvider) throw new Error(t('modelManager.unsupported'));
      const next = await driver.addProvider(input);
      setModels(next);
      log(t('log.providerAdded', { name: input.name, count: input.models.length }));
      return next;
    },
    removeProvider: async (name: string): Promise<ModelsState> => {
      if (!driver?.removeProvider) throw new Error(t('modelManager.unsupported'));
      const next = await driver.removeProvider(name);
      setModels(next);
      log(t('log.providerRemoved', { name }));
      return next;
    },
    setDefaultModel: async (model: string): Promise<ModelsState> => {
      if (!driver?.setDefaultModel) throw new Error(t('modelManager.unsupported'));
      const next = await driver.setDefaultModel(model);
      setModels(next);
      log(t('log.defaultModelSet', { model }));
      return next;
    },
  };

  // 渲染视图:进程输出 + 用户回显按时间归并(echo 不落 driver,attach 重取不会被覆盖)
  const view = useMemo(() => {
    const pids = new Set([...Object.keys(outputs), ...Object.keys(echoes)].map(Number));
    const merged: Record<number, OutputChunk[]> = {};
    for (const pid of pids) {
      merged[pid] = [...(outputs[pid] ?? []), ...(echoes[pid] ?? [])].sort((a, b) => a.ts - b.ts);
    }
    return merged;
  }, [outputs, echoes]);

  return { driver, mode, snaps, pipes, outputs: view, logs, selectedPid, select, actions, error, models };
}
