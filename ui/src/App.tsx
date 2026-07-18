import { useState } from 'react';
import { useRuntime } from '@/hooks/use-runtime';
import { useI18n } from '@/i18n';
import { ProcessTable } from '@/components/ProcessTable';
import { Terminal } from '@/components/Terminal';
import { SpawnDialog } from '@/components/SpawnDialog';
import { ModelManager } from '@/components/ModelManager';
import { BottomBar } from '@/components/BottomBar';

export default function App() {
  const { t, lang, setLang } = useI18n();
  const { mode, snaps, pipes, outputs, logs, selectedPid, select, actions, error, models } = useRuntime();
  const [spawnParent, setSpawnParent] = useState<number | null>(null);
  const [pipeSource, setPipeSource] = useState<number | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);
  const [modelErr, setModelErr] = useState<string | null>(null);

  const selected = snaps.find((s) => s.pid === selectedPid);
  const alive = snaps.filter((s) => !['done', 'failed', 'killed'].includes(s.state)).length;
  const totalTokens = snaps.reduce((acc, s) => acc + s.usage.totalTokens, 0);
  const allModels = models ? models.providers.flatMap((p) => p.models) : undefined;

  // 受控 select:失败后 models state 未变,select 自然回退到原值;红字提示短暂停留
  const onDefaultModelChange = (m: string) => {
    setModelErr(null);
    actions.setDefaultModel(m).catch((e: unknown) => {
      setModelErr((e as Error)?.message ?? String(e));
      window.setTimeout(() => setModelErr(null), 6000);
    });
  };

  const onSelect = (pid: number) => {
    if (pipeSource !== null && pid !== pipeSource) {
      actions.pipe(pipeSource, pid);
      setPipeSource(null);
    }
    select(pid);
  };

  const onAction = (pid: number, action: string) => {
    if (action === 'spawn') setSpawnParent(pid);
    else if (action === 'fork') {
      const hint = window.prompt(t('app.forkPrompt', { pid })) ?? undefined;
      actions.fork(pid, hint || undefined).then((child) => child != null && select(child));
    } else if (action === 'pipe') setPipeSource((cur) => (cur === pid ? null : pid)); // 再次点击同一进程 pipe→ 取消
    else actions.signal(pid, action);
  };

  return (
    <div className="h-screen w-screen bg-zinc-950 text-zinc-200 flex flex-col overflow-hidden">
      {/* 顶栏 */}
      <div className="h-12 border-b border-zinc-800 flex items-center px-4 gap-4 shrink-0">
        <div className="font-mono text-sm">
          <span className="text-emerald-400 font-bold">AgentOS</span>
          <span className="text-zinc-500 ml-2">{t('app.subtitle')}</span>
        </div>
        <span
          className={`text-[10px] font-mono px-2 py-0.5 rounded border ${
            mode === 'live'
              ? 'border-emerald-500/40 text-emerald-400'
              : 'border-amber-500/40 text-amber-400'
          }`}
        >
          {mode === 'live' ? t('app.modeLive') : t('app.modeDemo')}
        </span>
        <div className="ml-auto flex items-center gap-4 text-[11px] font-mono text-zinc-500">
          {models && (
            <div className="flex items-center gap-2">
              <label className="text-zinc-500" htmlFor="model-select">
                {t('app.modelLabel')}
              </label>
              <select
                id="model-select"
                data-testid="model-select"
                value={models.defaultModel}
                onChange={(e) => onDefaultModelChange(e.target.value)}
                title={t('app.modelSelectTitle')}
                className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-[11px] font-mono text-zinc-300 outline-none hover:border-zinc-600"
              >
                {!models.defaultModel && (
                  <option value="" disabled>
                    {t('app.noDefaultModel')}
                  </option>
                )}
                {models.providers.map((p) =>
                  p.models.map((m) => (
                    <option key={`${p.name}/${m}`} value={m}>
                      {p.name}/{m}
                    </option>
                  )),
                )}
              </select>
              <button
                data-testid="model-manager-btn"
                onClick={() => setManagerOpen(true)}
                className="px-2 py-1 rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500"
              >
                {t('app.modelManagerBtn')}
              </button>
              {modelErr && (
                <span data-testid="model-select-error" className="text-red-400 max-w-[260px] truncate" title={modelErr}>
                  ✗ {modelErr}
                </span>
              )}
            </div>
          )}
          <button
            data-testid="lang-toggle"
            onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}
            title={t('app.langToggleTitle')}
            className="px-2 py-1 rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500"
          >
            {lang === 'zh' ? 'EN' : '中'}
          </button>
          <span>{t('app.processStats', { total: snaps.length, alive })}</span>
          <span>{t('app.tokenStats', { count: totalTokens })}</span>
        </div>
      </div>

      {error && (
        <div
          data-testid="error-banner"
          className="px-4 py-2 bg-red-500/10 border-b border-red-500/30 text-red-400 text-xs font-mono"
        >
          {t('app.connectFailed', { error })}
        </div>
      )}

      {/* 主区 */}
      <div className="flex-1 flex min-h-0">
        <div className="w-[520px] border-r border-zinc-800 shrink-0">
          <ProcessTable snaps={snaps} selectedPid={selectedPid} pipeSource={pipeSource} onSelect={onSelect} onAction={onAction} />
        </div>
        <div className="flex-1 min-w-0">
          <Terminal
            pid={selectedPid}
            snap={selected}
            chunks={outputs[selectedPid] ?? []}
            onSend={(t, imgs) => actions.send(selectedPid, t, imgs)}
            onInterrupt={() => actions.interrupt(selectedPid)}
          />
        </div>
      </div>

      <BottomBar logs={logs} pipes={pipes} />

      {spawnParent !== null && (
        <SpawnDialog
          parentPid={spawnParent}
          mode={mode}
          models={allModels}
          defaultModel={models?.defaultModel}
          onClose={() => setSpawnParent(null)}
          onSubmit={(params) => {
            const ppid = spawnParent;
            setSpawnParent(null);
            actions.spawn(ppid, params).then((pid) => pid != null && select(pid)); // spawn 后自动 attach 新进程
          }}
        />
      )}

      {managerOpen && models && (
        <ModelManager
          models={models}
          onClose={() => setManagerOpen(false)}
          onAddProvider={actions.addProvider}
          onRemoveProvider={actions.removeProvider}
          onSetDefault={actions.setDefaultModel}
        />
      )}

      {pipeSource !== null && (
        <div
          data-testid="pipe-tip"
          className="fixed bottom-40 left-1/2 -translate-x-1/2 px-4 py-2 bg-cyan-500/15 border border-cyan-500/40 rounded text-cyan-300 text-xs font-mono z-40"
        >
          {t('app.pipeTip', { pid: pipeSource })}
        </div>
      )}
    </div>
  );
}
