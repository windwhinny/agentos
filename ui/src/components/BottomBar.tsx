import type { LogEntry } from '@/hooks/use-runtime';
import { useI18n } from '@/i18n';

interface Props {
  logs: LogEntry[];
  pipes: Array<{ fromPid: number; toPid: number; mode: string; closed: boolean }>;
}

export function BottomBar({ logs, pipes }: Props) {
  const { t, lang } = useI18n();
  return (
    <div className="h-36 border-t border-zinc-800 flex text-xs font-mono">
      <div className="w-1/2 border-r border-zinc-800 flex flex-col">
        <div className="px-3 py-1.5 text-[11px] uppercase tracking-wider text-zinc-500 border-b border-zinc-800">
          {t('bottom.eventLog')}
        </div>
        {/* column-reverse:滚动位置天然钉在底部,新事件始终可见,无需 JS 滚动 */}
        <div className="flex-1 overflow-auto px-3 py-1.5 space-y-0.5 flex flex-col-reverse">
          {logs.slice(-50).reverse().map((l, i) => (
            <div key={l.ts + '-' + (logs.length - i)} className="text-zinc-500 shrink-0">
              <span className="text-zinc-700 mr-2">{new Date(l.ts).toLocaleTimeString(lang, { hour12: false })}</span>
              {l.text}
            </div>
          ))}
        </div>
      </div>
      <div className="w-1/2 flex flex-col">
        <div className="px-3 py-1.5 text-[11px] uppercase tracking-wider text-zinc-500 border-b border-zinc-800">
          {t('bottom.pipeline')}
        </div>
        <div className="flex-1 overflow-auto px-3 py-1.5 space-y-1">
          {pipes.length === 0 && <div className="text-zinc-700 italic">{t('bottom.noPipes')}</div>}
          {pipes.map((p, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="text-cyan-400">PID {p.fromPid}</span>
              <span className="text-zinc-600">────{p.mode}────▶</span>
              <span className="text-cyan-400">PID {p.toPid}</span>
              <span className={p.closed ? 'text-red-500' : 'text-emerald-500'}>
                {p.closed ? t('bottom.pipeClosed') : t('bottom.pipeOpen')}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
