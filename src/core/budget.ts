import { BudgetExceededError } from '../errors';
import type { BudgetQuota } from '../types';

/** 树链预算：消耗沿父链逐级扣减，任一级不足即抛 BudgetExceededError */
export class Budget {
  private _usedTokens = 0;
  private _usedTurns = 0;
  private readonly startedAt: number = Date.now();

  constructor(
    readonly quota: BudgetQuota = {},
    private readonly parent?: Budget,
  ) {}

  get usedTokens(): number {
    return this._usedTokens;
  }

  get usedTurns(): number {
    return this._usedTurns;
  }

  consumeTokens(n: number): void {
    this._usedTokens += n;
    if (this.quota.tokens !== undefined && this._usedTokens > this.quota.tokens) {
      throw new BudgetExceededError(
        'tokens',
        `token budget exceeded (${this._usedTokens}/${this.quota.tokens})`,
      );
    }
    this.parent?.consumeTokens(n);
  }

  consumeTurn(): void {
    this._usedTurns += 1;
    if (this.quota.turns !== undefined && this._usedTurns > this.quota.turns) {
      throw new BudgetExceededError(
        'turns',
        `turn budget exceeded (${this._usedTurns}/${this.quota.turns})`,
      );
    }
    this.parent?.consumeTurn();
  }

  checkWall(): void {
    if (this.quota.wallMs !== undefined && Date.now() - this.startedAt > this.quota.wallMs) {
      throw new BudgetExceededError('wall', `wall budget exceeded (${this.quota.wallMs}ms)`);
    }
    this.parent?.checkWall();
  }

  remaining(): BudgetQuota {
    return {
      tokens: this.quota.tokens === undefined ? undefined : this.quota.tokens - this._usedTokens,
      turns: this.quota.turns === undefined ? undefined : this.quota.turns - this._usedTurns,
    };
  }

  snapshot(): { quota: BudgetQuota; usedTokens: number; usedTurns: number; startedAt: number } {
    return {
      quota: { ...this.quota },
      usedTokens: this._usedTokens,
      usedTurns: this._usedTurns,
      startedAt: this.startedAt,
    };
  }

  static restore(
    snap: { quota: BudgetQuota; usedTokens: number; usedTurns: number; startedAt: number },
    parent?: Budget,
  ): Budget {
    const b = new Budget(snap.quota, parent);
    b._usedTokens = snap.usedTokens;
    b._usedTurns = snap.usedTurns;
    (b as unknown as { startedAt: number }).startedAt = snap.startedAt;
    return b;
  }
}
