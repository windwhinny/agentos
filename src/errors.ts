export class AgentOSError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class BudgetExceededError extends AgentOSError {
  constructor(
    readonly kind: 'tokens' | 'turns' | 'wall',
    message?: string,
  ) {
    super(message ?? `budget exceeded: ${kind}`, 'BUDGET_EXCEEDED');
  }
}

export class DeadlockError extends AgentOSError {
  constructor(message = 'deadlock detected') {
    super(message, 'DEADLOCK');
  }
}

export class KilledError extends AgentOSError {
  constructor(readonly reason: string = 'SIGKILL') {
    super(`process killed: ${reason}`, 'KILLED');
  }
}

export class TermExit extends AgentOSError {
  constructor() {
    super('SIGTERM received', 'SIGTERM');
  }
}

/** 用户中断当前生成（Codex Esc 语义）：携带已生成的部分内容，进程转 ON_INBOX 等待 */
export class InterruptedError extends AgentOSError {
  constructor(
    readonly partialText: string,
    readonly partialThinking: string,
  ) {
    super('generation interrupted by user', 'EINTR');
  }
}

export class PipeClosedError extends AgentOSError {
  constructor(message = 'EPIPE: pipe closed') {
    super(message, 'EPIPE');
  }
}

export class TimeoutError extends AgentOSError {
  constructor(message = 'operation timed out') {
    super(message, 'TIMEOUT');
  }
}

export class ToolNotAllowedError extends AgentOSError {
  constructor(toolName: string) {
    super(`tool not allowed: ${toolName}`, 'TOOL_NOT_ALLOWED');
  }
}

export class MaxDepthError extends AgentOSError {
  constructor(message: string) {
    super(message, 'MAX_DEPTH');
  }
}

export class MaxWidthError extends AgentOSError {
  constructor(message: string) {
    super(message, 'MAX_WIDTH');
  }
}

export class ProcessNotFoundError extends AgentOSError {
  constructor(pid: number) {
    super(`process not found: ${pid}`, 'ENOENT');
  }
}

export class PermissionError extends AgentOSError {
  constructor(message: string) {
    super(message, 'EPERM');
  }
}
