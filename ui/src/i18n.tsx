import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type Lang = 'zh' | 'en';

const STORAGE_KEY = 'agentos-lang';

/** 中文为基准字典（缺 key 时的 fallback），新增 key 必须先加在这里 */
const zh = {
  // —— App 顶栏/全局 ——
  'app.subtitle': '进程控制台',
  'app.modeLive': 'LIVE · DeepSeek',
  'app.modeDemo': 'DEMO · Mock（?server=http://localhost:8787 切真实模型）',
  'app.modelLabel': '模型',
  'app.modelSelectTitle': '控制台默认模型：影响之后新 spawn 的进程，不影响运行中的进程',
  'app.noDefaultModel': '（无默认模型）',
  'app.modelManagerBtn': '⚙ 模型',
  'app.processStats': '进程 {total}（活跃 {alive}）',
  'app.tokenStats': 'tokens {count}',
  'app.connectFailed': '连接失败：{error}（将以 demo 提示展示；检查 server 地址）',
  'app.forkPrompt': 'fork PID {pid}：给分支一个提示（可留空）',
  'app.pipeTip': '管道源 PID {pid} —— 点击目标进程行完成连接（再次点击 pipe→ 取消）',
  'app.langToggleTitle': '切换到 English',

  // —— ProcessTable 进程表 ——
  'table.title': '进程表 ps（{count}）',
  'table.pid0Note': 'PID 0 = 用户',
  'table.colPid': 'PID',
  'table.colName': 'NAME',
  'table.colState': 'STATE',
  'table.colModel': 'MODEL',
  'table.colTokens': 'TOKENS',
  'table.colTime': 'TIME',
  'table.actionSpawn': '＋子进程',
  'table.actionSpawnTitle': '以此进程为父 spawn 子进程',
  'table.actionFork': 'fork',
  'table.actionForkTitle': 'COW 复制上下文创建兄弟分支',
  'table.actionPipe': 'pipe→',
  'table.actionPipeTitle': '把该进程 stdout 管道到另一进程（再点目标行）',
  'table.actionSigstop': '⏸',
  'table.actionSigstopTitle': 'SIGSTOP 暂停',
  'table.actionSigcont': '▶',
  'table.actionSigcontTitle': 'SIGCONT 恢复',
  'table.actionSigterm': 'TERM',
  'table.actionSigtermTitle': 'SIGTERM 优雅退出',
  'table.actionSigkill': 'KILL',
  'table.actionSigkillTitle': 'SIGKILL 强制终止（级联）',
  'table.actionDisabledTitle': '{title}（进程已退出，信号无效）',

  // —— Terminal 终端 ——
  'terminal.attachPrefix': '终端 attach →',
  'terminal.attachName': '（{name}）',
  'terminal.generating': '● 生成中',
  'terminal.turnInfo': '{state}{reason} · {turns} 轮',
  'terminal.empty': '（暂无输出 —— 进程尚未产出或已被回收）',
  'terminal.thinkingStreaming': '思考中…',
  'terminal.thinkingDone': '思考过程',
  'terminal.thinkingChars': '{count} 字',
  'terminal.toolArgs': '参数',
  'terminal.toolResult': '结果',
  'terminal.placeholderAlive': '向该进程 stdin 注入消息（可贴图）…',
  'terminal.placeholderExited': '进程已退出，发送将唤醒它继续对话',
  'terminal.attachImageTitle': '上传图片（多模态注入）',
  'terminal.interrupt': '⏹ 中断',
  'terminal.interruptTitle': '中断当前生成（进程转入等待输入）',
  'terminal.send': '发送',

  // —— BottomBar 事件流/管道拓扑 ——
  'bottom.eventLog': '事件流',
  'bottom.pipeline': '管道拓扑 pipeline',
  'bottom.noPipes': '（暂无管道 —— 选中进程后点 pipe→ 再点目标行）',
  'bottom.pipeOpen': '● open',
  'bottom.pipeClosed': '✕ closed',

  // —— SpawnDialog spawn 对话框 ——
  'spawn.title': 'spawn 子进程',
  'spawn.parentInfo': '（父 PID {pid}）',
  'spawn.taskLabel': '任务描述 *',
  'spawn.taskPlaceholder': '子进程要完成的任务…',
  'spawn.nameLabel': '名称',
  'spawn.namePlaceholder': '可选',
  'spawn.modelLabel': '模型（继承可留空）',
  'spawn.inheritOption': '（继承父进程）',
  'spawn.defaultSuffix': '（默认）',
  'spawn.budgetLabel': 'token 预算（rlimit，留空不限）',
  'spawn.budgetPlaceholder': '如 50000',
  'spawn.cancel': '取消',
  'spawn.submit': 'spawn',

  // —— ModelManager 模型管理 ——
  'modelManager.title': '模型管理',
  'modelManager.subtitle': '（默认模型影响之后新 spawn 的进程）',
  'modelManager.close': '关闭',
  'modelManager.empty': '尚未注册任何供应商，请在下方录入。',
  'modelManager.missingKey': '缺 apiKey',
  'modelManager.delete': '删除',
  'modelManager.deleting': '删除中…',
  'modelManager.isDefault': '当前默认模型',
  'modelManager.setDefault': '设为默认模型',
  'modelManager.addProviderHeading': '录入供应商',
  'modelManager.nameLabel': '名称 *',
  'modelManager.namePlaceholder': '如 my-openai',
  'modelManager.typeLabel': '类型 *',
  'modelManager.baseUrlLabel': 'baseUrl（可选）',
  'modelManager.apiKeyLabel': 'apiKey *',
  'modelManager.modelsLabel': '模型列表 *（逗号分隔）',
  'modelManager.errNameRequired': '供应商名称不能为空',
  'modelManager.errKeyRequired': 'apiKey 不能为空',
  'modelManager.errModelsRequired': '模型列表不能为空（逗号分隔）',
  'modelManager.submit': '录入供应商',
  'modelManager.submitting': '录入中…',
  'modelManager.unsupported': '当前模式不支持模型管理',

  // —— use-runtime 事件流日志 ——
  'log.processCreated': '+ PID {pid} {name} 创建（父 {ppid}，模型 {model}）',
  'log.stateChange': 'PID {pid}: {prev} → {next}',
  'log.runtimeReady': 'runtime 就绪（{mode} 模式，共 {count} 个进程）',
  'log.modelsLoadFailed': '✗ 模型注册表加载失败: {message}',
  'log.actionFailed': '✗ {what} 失败: {message}',
  'log.spawned': 'spawn: PID {pid}（父 {ppid}）{model}',
  'log.spawnedModel': ' 模型={model}',
  'log.forked': 'fork: PID {pid} → 分支 PID {child}',
  'log.signal': 'signal: {sig} → PID {pid}',
  'log.sent': 'send → PID {pid}: {text}{images}',
  'log.sentImages': '（附 {count} 张图）',
  'log.interrupted': 'interrupt: ⏹ PID {pid} 当前生成被中断',
  'log.pipeCycleRejected': '✗ pipe 被拒绝: PID {a} → PID {b} 会形成管道环(输出将在环上无限循环)',
  'log.piped': 'pipe: PID {a} → PID {b}',
  'log.providerAdded': 'provider 录入成功: {name}（{count} 个模型）',
  'log.providerRemoved': 'provider 已删除: {name}',
  'log.defaultModelSet': '默认模型 → {model}（影响之后新 spawn 的进程，运行中进程不受影响）',
} as const;

export type I18nKey = keyof typeof zh;

/** 英文完整字典：类型强制与 zh 同形，漏 key 会在编译期报错 */
const en: Record<I18nKey, string> = {
  'app.subtitle': 'Process Console',
  'app.modeLive': 'LIVE · DeepSeek',
  'app.modeDemo': 'DEMO · Mock (?server=http://localhost:8787 for real model)',
  'app.modelLabel': 'Model',
  'app.modelSelectTitle': 'Console default model: affects newly spawned processes; running processes unaffected',
  'app.noDefaultModel': '(no default model)',
  'app.modelManagerBtn': '⚙ Models',
  'app.processStats': 'processes {total} (alive {alive})',
  'app.tokenStats': 'tokens {count}',
  'app.connectFailed': 'Connection failed: {error} (demo hints will be shown; check server address)',
  'app.forkPrompt': 'fork PID {pid}: give the branch a hint (optional)',
  'app.pipeTip': 'Pipe source PID {pid} — click a target process row to connect (click pipe→ again to cancel)',
  'app.langToggleTitle': 'Switch to Chinese',

  'table.title': 'Process Table ps ({count})',
  'table.pid0Note': 'PID 0 = user',
  'table.colPid': 'PID',
  'table.colName': 'NAME',
  'table.colState': 'STATE',
  'table.colModel': 'MODEL',
  'table.colTokens': 'TOKENS',
  'table.colTime': 'TIME',
  'table.actionSpawn': '＋child',
  'table.actionSpawnTitle': 'Spawn a child process with this process as parent',
  'table.actionFork': 'fork',
  'table.actionForkTitle': 'COW-copy the context to create a sibling branch',
  'table.actionPipe': 'pipe→',
  'table.actionPipeTitle': "Pipe this process's stdout to another process (then click the target row)",
  'table.actionSigstop': '⏸',
  'table.actionSigstopTitle': 'SIGSTOP pause',
  'table.actionSigcont': '▶',
  'table.actionSigcontTitle': 'SIGCONT resume',
  'table.actionSigterm': 'TERM',
  'table.actionSigtermTitle': 'SIGTERM graceful exit',
  'table.actionSigkill': 'KILL',
  'table.actionSigkillTitle': 'SIGKILL force kill (cascading)',
  'table.actionDisabledTitle': '{title} (process exited; signal has no effect)',

  'terminal.attachPrefix': 'terminal attach →',
  'terminal.attachName': ' ({name})',
  'terminal.generating': '● generating',
  'terminal.turnInfo': '{state}{reason} · {turns} turns',
  'terminal.empty': '(no output yet — the process has produced nothing or has been reaped)',
  'terminal.thinkingStreaming': 'thinking…',
  'terminal.thinkingDone': 'thought process',
  'terminal.thinkingChars': '{count} chars',
  'terminal.toolArgs': 'args',
  'terminal.toolResult': 'result',
  'terminal.placeholderAlive': 'Inject a message into this process stdin (paste images OK)…',
  'terminal.placeholderExited': 'Process exited; sending will wake it to continue the conversation',
  'terminal.attachImageTitle': 'Upload images (multimodal injection)',
  'terminal.interrupt': '⏹ Interrupt',
  'terminal.interruptTitle': 'Interrupt current generation (process waits for input)',
  'terminal.send': 'Send',

  'bottom.eventLog': 'Event Stream',
  'bottom.pipeline': 'Pipeline Topology',
  'bottom.noPipes': '(no pipes — select a process, click pipe→, then click a target row)',
  'bottom.pipeOpen': '● open',
  'bottom.pipeClosed': '✕ closed',

  'spawn.title': 'spawn child process',
  'spawn.parentInfo': '(parent PID {pid})',
  'spawn.taskLabel': 'Task *',
  'spawn.taskPlaceholder': 'What the child process should do…',
  'spawn.nameLabel': 'Name',
  'spawn.namePlaceholder': 'optional',
  'spawn.modelLabel': 'Model (leave empty to inherit)',
  'spawn.inheritOption': '(inherit from parent)',
  'spawn.defaultSuffix': '(default)',
  'spawn.budgetLabel': 'token budget (rlimit, empty = unlimited)',
  'spawn.budgetPlaceholder': 'e.g. 50000',
  'spawn.cancel': 'Cancel',
  'spawn.submit': 'spawn',

  'modelManager.title': 'Model Manager',
  'modelManager.subtitle': '(default model affects newly spawned processes)',
  'modelManager.close': 'Close',
  'modelManager.empty': 'No providers registered yet — add one below.',
  'modelManager.missingKey': 'missing apiKey',
  'modelManager.delete': 'Delete',
  'modelManager.deleting': 'Deleting…',
  'modelManager.isDefault': 'Current default model',
  'modelManager.setDefault': 'Set as default model',
  'modelManager.addProviderHeading': 'Add Provider',
  'modelManager.nameLabel': 'Name *',
  'modelManager.namePlaceholder': 'e.g. my-openai',
  'modelManager.typeLabel': 'Type *',
  'modelManager.baseUrlLabel': 'baseUrl (optional)',
  'modelManager.apiKeyLabel': 'apiKey *',
  'modelManager.modelsLabel': 'Models * (comma-separated)',
  'modelManager.errNameRequired': 'Provider name is required',
  'modelManager.errKeyRequired': 'apiKey is required',
  'modelManager.errModelsRequired': 'Model list is required (comma-separated)',
  'modelManager.submit': 'Add Provider',
  'modelManager.submitting': 'Adding…',
  'modelManager.unsupported': 'Model management is not supported in the current mode',

  'log.processCreated': '+ PID {pid} {name} created (parent {ppid}, model {model})',
  'log.stateChange': 'PID {pid}: {prev} → {next}',
  'log.runtimeReady': 'runtime ready ({mode} mode, {count} processes)',
  'log.modelsLoadFailed': '✗ failed to load model registry: {message}',
  'log.actionFailed': '✗ {what} failed: {message}',
  'log.spawned': 'spawn: PID {pid} (parent {ppid}){model}',
  'log.spawnedModel': ' model={model}',
  'log.forked': 'fork: PID {pid} → branch PID {child}',
  'log.signal': 'signal: {sig} → PID {pid}',
  'log.sent': 'send → PID {pid}: {text}{images}',
  'log.sentImages': ' (+{count} images)',
  'log.interrupted': 'interrupt: ⏹ PID {pid} generation interrupted',
  'log.pipeCycleRejected': '✗ pipe rejected: PID {a} → PID {b} would create a pipe cycle (output would loop forever)',
  'log.piped': 'pipe: PID {a} → PID {b}',
  'log.providerAdded': 'provider added: {name} ({count} models)',
  'log.providerRemoved': 'provider removed: {name}',
  'log.defaultModelSet': 'default model → {model} (affects newly spawned processes; running processes unaffected)',
};

const DICTS: Record<Lang, Record<string, string>> = { zh, en };

export type I18nVars = Record<string, string | number>;

/** key 查表 + {name} 插值；当前语言缺 key 时 fallback 到 zh 并 console.warn，不抛错 */
export function translate(lang: Lang, key: I18nKey, vars?: I18nVars): string {
  let template = DICTS[lang][key];
  if (template === undefined) {
    console.warn(`[i18n] missing key "${key}" for lang "${lang}", falling back to zh`);
    template = DICTS.zh[key];
  }
  if (template === undefined) {
    console.warn(`[i18n] missing key "${key}" in zh dictionary`);
    return key;
  }
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (raw, name: string) =>
    vars[name] !== undefined ? String(vars[name]) : raw,
  );
}

export interface I18nValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: I18nKey, vars?: I18nVars) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

/** 语言持久化 + <html lang> 同步；默认必须中文（e2e 以中文文本匹配按钮） */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      return saved === 'en' || saved === 'zh' ? saved : 'zh';
    } catch {
      return 'zh';
    }
  });

  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    try {
      window.localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      // 隐私模式等场景写入失败可忽略，语言仅在本次会话内生效
    }
  }, [lang]);

  const value = useMemo<I18nValue>(
    () => ({ lang, setLang, t: (key, vars) => translate(lang, key, vars) }),
    [lang],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used within <I18nProvider>');
  return ctx;
}
