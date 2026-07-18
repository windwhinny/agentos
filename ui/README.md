# AgentOS 进程控制台

AgentOS 运行时的可视化控制台（React + TypeScript + Vite + Tailwind）。

## 两种模式

- **demo 模式**（默认）：AgentOS 内核直接在浏览器里跑——进程机制（PCB、状态机、预算、信号、管道、fork）全部真实，只有大脑是脚本化 Mock。打开页面即自动演示「协调者 spawn 调研员 + 写手、管道串联」全流程。
- **live 模式**：连接 `agentos` 项目的 live server（`npm run server`，默认 :8787），真实 DeepSeek 模型。URL 加 `?server=http://localhost:8787`。

## 功能

- 进程表：ps 树视图（PID/PPID/状态/模型/tokens/耗时）；操作：＋子进程、fork、pipe→、⏸ SIGSTOP、▶ SIGCONT、TERM、KILL
- 终端：attach 任意进程，查看 stdout（assistant/tool/result/stderr），从 stdin 注入用户消息（PID 0）
- spawn 对话框：任务、名称、模型（pro/flash/继承）、token 预算（rlimit）
- 事件流：进程创建/状态迁移/退出（SIGCHLD）
- 管道拓扑：pipeline 连线（● open / ✕ closed）

## 开发

```bash
npm install
npm run build       # 产物 dist/
npm run test:e2e    # e2e 回归(真实 Chrome,零依赖,见 e2e/README.md)
```

浏览器化说明：`src/agentos/` 是主项目内核的浏览器副本（`node:events` 走 `src/shim-events.ts` 垫片，worker_threads 隔离在浏览器不可用，相关入口已移除）。
