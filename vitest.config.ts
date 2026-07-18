import { defineConfig } from 'vitest/config';
import { readFileSync, existsSync } from 'node:fs';

// 轻量 .env 加载（无第三方依赖）
try {
  if (existsSync('.env')) {
    for (const line of readFileSync('.env', 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
} catch {
  /* ignore */
}

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    // ui/e2e 是自定义 CDP runner 的用例(非 vitest),不纳入收集
    exclude: ['**/node_modules/**', 'ui/**'],
  },
});
