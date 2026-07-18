import { describe, it, expect } from 'vitest';
import { Budget } from '../../src/core/budget';
import { BudgetExceededError } from '../../src/errors';

describe('Budget（预算链）', () => {
  it('token 扣减与剩余查询', () => {
    const b = new Budget({ tokens: 100 });
    b.consumeTokens(30);
    expect(b.usedTokens).toBe(30);
    expect(b.remaining().tokens).toBe(70);
  });

  it('超支抛 BudgetExceededError', () => {
    const b = new Budget({ tokens: 20 });
    b.consumeTokens(15);
    expect(() => b.consumeTokens(15)).toThrow(BudgetExceededError);
  });

  it('子预算消耗沿父链扣减', () => {
    const parent = new Budget({ tokens: 25 });
    const child = new Budget({ tokens: 1000 }, parent);
    child.consumeTokens(15);
    expect(parent.usedTokens).toBe(15);
    expect(() => child.consumeTokens(15)).toThrow(BudgetExceededError);
    expect(parent.usedTokens).toBe(30);
  });

  it('turns 配额', () => {
    const b = new Budget({ turns: 2 });
    b.consumeTurn();
    b.consumeTurn();
    expect(() => b.consumeTurn()).toThrow(/turn budget/);
  });

  it('wall 时钟配额', async () => {
    const b = new Budget({ wallMs: 30 });
    await new Promise((r) => setTimeout(r, 50));
    expect(() => b.checkWall()).toThrow(/wall/);
  });

  it('无配额项不限制', () => {
    const b = new Budget({});
    b.consumeTokens(1e9);
    expect(b.remaining().tokens).toBeUndefined();
  });
});
