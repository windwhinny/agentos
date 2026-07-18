import type { ProcessSnapshot } from '@/agentos/types';
import { useI18n } from '@/i18n';

const STATE_STYLE: Record<string, string> = {
  running: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  blocked: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  paused: 'bg-sky-500/15 text-sky-400 border-sky-500/30',
  done: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30',
  failed: 'bg-red-500/15 text-red-400 border-red-500/30',
  killed: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  created: 'bg-zinc-500/15 text-zinc-500 border-zinc-500/30',
  ready: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30',
};

interface Props {
  snaps: ProcessSnapshot[];
  selectedPid: number;
  pipeSource: number | null;
  onSelect: (pid: number) => void;
  onAction: (pid: number, action: string) => void;
}

export function ProcessTable({ snaps, selectedPid, pipeSource, onSelect, onAction }: Props) {
  const { t } = useI18n();
  const ACTIONS = [
    { key: 'spawn', label: t('table.actionSpawn'), title: t('table.actionSpawnTitle') },
    { key: 'fork', label: t('table.actionFork'), title: t('table.actionForkTitle') },
    { key: 'pipe', label: t('table.actionPipe'), title: t('table.actionPipeTitle') },
    { key: 'SIGSTOP', label: t('table.actionSigstop'), title: t('table.actionSigstopTitle') },
    { key: 'SIGCONT', label: t('table.actionSigcont'), title: t('table.actionSigcontTitle') },
    { key: 'SIGTERM', label: t('table.actionSigterm'), title: t('table.actionSigtermTitle') },
    { key: 'SIGKILL', label: t('table.actionSigkill'), title: t('table.actionSigkillTitle') },
  ];
  const selectedSnap = snaps.find((s) => s.pid === selectedPid);
  // 已退出进程的信号是静默 no-op(内核不报错也不生效),点按钮看起来「无响应」——直接禁用
  const selectedExited = !selectedSnap || ['done', 'failed', 'killed'].includes(selectedSnap.state);
  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 text-[11px] uppercase tracking-wider text-zinc-500 border-b border-zinc-800 flex justify-between">
        <span>{t('table.title', { count: snaps.length })}</span>
        <span className="text-zinc-600">{t('table.pid0Note')}</span>
      </div>
      <div className="flex-1 overflow-auto">
        <table className="w-full text-xs font-mono">
          <thead className="sticky top-0 bg-zinc-950 text-zinc-500">
            <tr className="text-left border-b border-zinc-800">
              <th className="px-3 py-1.5 font-normal">{t('table.colPid')}</th>
              <th className="px-2 py-1.5 font-normal">{t('table.colName')}</th>
              <th className="px-2 py-1.5 font-normal">{t('table.colState')}</th>
              <th className="px-2 py-1.5 font-normal">{t('table.colModel')}</th>
              <th className="px-2 py-1.5 font-normal text-right">{t('table.colTokens')}</th>
              <th className="px-2 py-1.5 font-normal text-right">{t('table.colTime')}</th>
            </tr>
          </thead>
          <tbody>
            {snaps.map((s) => {
              const selected = s.pid === selectedPid;
              const isPipeSrc = s.pid === pipeSource;
              return (
                <tr
                  key={s.pid}
                  onClick={() => onSelect(s.pid)}
                  className={`cursor-pointer border-b border-zinc-900 transition-colors ${
                    selected ? 'bg-emerald-500/10' : isPipeSrc ? 'bg-cyan-500/10' : 'hover:bg-zinc-900/60'
                  }`}
                >
                  <td className="px-3 py-1.5 text-zinc-400">
                    {' '.repeat(s.depth * 2)}{s.pid === 1 ? '★' : '├'} {s.pid}
                  </td>
                  <td className="px-2 py-1.5 text-zinc-200 truncate max-w-[110px]" title={s.name}>
                    {s.name ?? '-'}
                  </td>
                  <td className="px-2 py-1.5">
                    <span className={`px-1.5 py-0.5 rounded border text-[10px] ${STATE_STYLE[s.state] ?? ''}`}>
                      {s.state}{s.blockedReason ? `:${s.blockedReason.replace('ON_', '')}` : ''}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-zinc-500 truncate max-w-[120px]" title={s.model}>{s.model}</td>
                  <td className="px-2 py-1.5 text-right text-zinc-400">{s.usage.totalTokens}</td>
                  <td className="px-2 py-1.5 text-right text-zinc-500">{(s.uptimeMs / 1000).toFixed(1)}s</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="border-t border-zinc-800 p-2 flex flex-wrap gap-1.5">
        {ACTIONS.map((a) => {
          const isSignal = a.key.startsWith('SIG');
          const disabled = isSignal && selectedExited;
          return (
            <button
              key={a.key}
              title={disabled ? t('table.actionDisabledTitle', { title: a.title }) : a.title}
              disabled={disabled}
              onClick={() => onAction(selectedPid, a.key)}
              className={`px-2 py-1 text-[11px] font-mono rounded border transition-colors ${
                disabled
                  ? 'border-zinc-800 text-zinc-700 cursor-not-allowed'
                  : a.key === 'SIGKILL'
                    ? 'border-red-500/40 text-red-400 hover:bg-red-500/10'
                    : a.key === 'SIGTERM'
                      ? 'border-orange-500/40 text-orange-400 hover:bg-orange-500/10'
                      : 'border-zinc-700 text-zinc-300 hover:bg-zinc-800'
              }`}
            >
              {a.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
