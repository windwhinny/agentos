import { Budget } from './budget';
import { Process } from './process';
import type { AgentRuntime } from './runtime';
import type {
  ChatMessage,
  ExitResult,
  ModelConfig,
  ProcessState,
  SpawnOptions,
  Usage,
} from '../types';

export interface ProcessSnapshotEntry {
  pid: number;
  ppid: number;
  name?: string;
  state: ProcessState;
  spawnOptions: SpawnOptions;
  modelParams: ModelConfig;
  messages: ChatMessage[];
  usage: Usage;
  turns: number;
  budget: ReturnType<Budget['snapshot']>;
  exitResult?: ExitResult;
  createdAt: number;
  exitedAt?: number;
}

export interface RuntimeSnapshot {
  version: 1;
  nextPid: number;
  processes: ProcessSnapshotEntry[];
}

export function takeCheckpoint(runtime: AgentRuntime): RuntimeSnapshot {
  const processes = [...runtime.allProcesses()].map((p) => ({
    pid: p.pid,
    ppid: p.ppid,
    name: p.name,
    state: p.state,
    spawnOptions: p.spawnOptions,
    modelParams: p.modelParams,
    messages: [...p.context.messages],
    usage: { ...p.usage },
    turns: p.turns,
    budget: p.budget.snapshot(),
    exitResult: p.exitResult,
    createdAt: p.createdAt,
    exitedAt: p.exitedAt,
  }));
  return { version: 1, nextPid: runtime.currentNextPid, processes };
}

export function restoreCheckpoint(runtime: AgentRuntime, snap: RuntimeSnapshot): void {
  runtime.restorePids(snap.nextPid);
  for (const entry of [...snap.processes].sort((a, b) => a.pid - b.pid)) {
    Process.restore(entry, runtime);
  }
}
