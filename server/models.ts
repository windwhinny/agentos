/**
 * 模型供应商注册表 —— 持久化到 server/models.json（含 apiKey，勿提交 git）。
 *
 * 结构：{ providers: [{ name, type, baseUrl?, apiKey, models[] }], defaultModel }
 * 启动时加载；无文件则用 OPENAI_API_KEY 播种 deepseek 供应商并写回。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { LLMProvider } from '../src/types';
import { OpenAIProvider } from '../src/llm/openai';
import { AnthropicProvider } from '../src/llm/anthropic';
import { DeepSeekProvider } from '../src/llm/deepseek';

export type ProviderType = 'openai' | 'anthropic' | 'deepseek';

export interface ProviderEntry {
  name: string;
  type: ProviderType;
  baseUrl?: string;
  apiKey: string;
  models: string[];
}

export interface ModelRegistry {
  providers: ProviderEntry[];
  defaultModel: string;
}

/** 下发给 UI 的脱敏视图（绝不含 apiKey） */
export interface ProviderView {
  name: string;
  type: ProviderType;
  baseUrl?: string;
  models: string[];
  hasKey: boolean;
}

const FILE = path.resolve(import.meta.dirname, 'models.json');

export function loadRegistry(): ModelRegistry {
  if (fs.existsSync(FILE)) {
    return JSON.parse(fs.readFileSync(FILE, 'utf8')) as ModelRegistry;
  }
  // 播种：保持原行为（deepseek 双模型 + 默认 pro）
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('[agentos-server] 缺少 OPENAI_API_KEY 且没有 models.json，无法启动');
    process.exit(1);
  }
  const seed: ModelRegistry = {
    providers: [
      {
        name: 'deepseek',
        type: 'deepseek',
        apiKey,
        models: ['deepseek-v4-pro', 'deepseek-v4-flash'],
      },
    ],
    defaultModel: 'deepseek-v4-pro',
  };
  saveRegistry(seed);
  return seed;
}

export function saveRegistry(reg: ModelRegistry): void {
  fs.writeFileSync(FILE, JSON.stringify(reg, null, 2) + '\n', { mode: 0o600 });
}

export function buildProvider(entry: ProviderEntry): LLMProvider {
  const opts = { apiKey: entry.apiKey, baseUrl: entry.baseUrl, name: entry.name };
  switch (entry.type) {
    case 'openai':
      return new OpenAIProvider(opts);
    case 'anthropic':
      return new AnthropicProvider(opts);
    case 'deepseek':
      // DeepSeekProvider 的 name 固定为 'deepseek'，仅允许单实例
      return new DeepSeekProvider({ apiKey: entry.apiKey, baseUrl: entry.baseUrl });
  }
}

export function toView(reg: ModelRegistry): { providers: ProviderView[]; defaultModel: string } {
  return {
    defaultModel: reg.defaultModel,
    providers: reg.providers.map((p) => ({
      name: p.name,
      type: p.type,
      baseUrl: p.baseUrl,
      models: p.models,
      hasKey: !!p.apiKey,
    })),
  };
}
