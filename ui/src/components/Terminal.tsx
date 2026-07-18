import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { OutputChunk, ProcessSnapshot } from '@/agentos/types';
import { useI18n } from '@/i18n';

interface Props {
  pid: number;
  snap?: ProcessSnapshot;
  chunks: OutputChunk[];
  onSend: (text: string, images: string[]) => void;
  onInterrupt: () => void;
}

/** assistant chunk 的 data 兼容两种形态：string（旧）/ {text, thinking?}（流式） */
function assistantData(data: unknown): { text: string; thinking?: string } {
  if (typeof data === 'string') return { text: data };
  const d = data as { text?: string; thinking?: string } | undefined;
  return { text: d?.text ?? '', thinking: d?.thinking };
}

const fmtTime = (ts: number, locale: string) => new Date(ts).toLocaleTimeString(locale, { hour12: false });

/** 可折叠思考块：流式思考时自动展开，结束后自动收起 */
function ThinkingBlock({ text, streaming }: { text: string; streaming: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(streaming);
  useEffect(() => {
    if (!streaming) setOpen(false);
  }, [streaming]);
  return (
    <div className="my-1 mr-4 border border-violet-500/25 rounded bg-violet-500/5">
      <button
        onClick={() => setOpen(!open)}
        className="w-full px-2 py-1 flex items-center gap-2 text-[11px] text-violet-300/80 hover:bg-violet-500/10 rounded-t"
      >
        <span className="w-3">{open ? '▾' : '▸'}</span>
        <span>💭 {streaming ? t('terminal.thinkingStreaming') : t('terminal.thinkingDone')}</span>
        <span className="ml-auto text-zinc-600">{t('terminal.thinkingChars', { count: text.length })}</span>
      </button>
      {open && (
        <div className="px-3 pb-2 text-xs leading-relaxed text-violet-200/60 italic whitespace-pre-wrap max-h-60 overflow-auto">
          {text}
        </div>
      )}
    </div>
  );
}

/** 工具调用卡：标题行常显，点击展开参数与完整结果 */
function ToolCard({ c }: { c: OutputChunk }) {
  const { t, lang } = useI18n();
  const [open, setOpen] = useState(false);
  const d = c.data as { name?: string; args?: string; output?: string };
  const out = String(d.output ?? '');
  const failed = out.startsWith('Error');
  let argsCompact = '';
  let argsPretty = '';
  try {
    const parsed = JSON.parse(d.args ?? '{}');
    argsCompact = JSON.stringify(parsed);
    argsPretty = JSON.stringify(parsed, null, 2);
  } catch {
    argsCompact = d.args ?? '';
    argsPretty = d.args ?? '';
  }
  return (
    <div className="my-1 mr-4 border border-amber-500/20 rounded bg-amber-500/5">
      <button
        onClick={() => setOpen(!open)}
        className="w-full px-2 py-1 flex items-center gap-2 text-[11px] hover:bg-amber-500/10 text-left rounded-t"
      >
        <span className="text-zinc-600 text-[10px]">{fmtTime(c.ts, lang)}</span>
        <span className={failed ? 'text-red-400' : 'text-amber-400'}>ƒ {d.name}</span>
        <span className="text-zinc-600 truncate flex-1">{argsCompact.slice(0, 80)}</span>
        <span className={failed ? 'text-red-500' : 'text-emerald-500'}>{failed ? '✗' : '✓'}</span>
        <span className="text-zinc-600 w-3">{open ? '▾' : '▸'}</span>
      </button>
      {open ? (
        <div className="px-3 pb-2 space-y-1.5">
          {argsPretty && argsPretty !== '{}' && (
            <div>
              <div className="text-[10px] uppercase text-zinc-600">{t('terminal.toolArgs')}</div>
              <pre className="text-[11px] text-zinc-300 whitespace-pre-wrap">{argsPretty}</pre>
            </div>
          )}
          <div>
            <div className="text-[10px] uppercase text-zinc-600">{t('terminal.toolResult')}</div>
            <pre className="text-[11px] leading-relaxed text-zinc-400 whitespace-pre-wrap max-h-60 overflow-auto">{out}</pre>
          </div>
        </div>
      ) : (
        <div className="px-2 pb-1.5 text-[11px] text-zinc-500 truncate">{out.slice(0, 160)}</div>
      )}
    </div>
  );
}

function ChunkView({ c }: { c: OutputChunk }) {
  const { lang } = useI18n();
  if (c.type === 'user') {
    // 用户消息回显(UI 层注入):右对齐气泡,与进程输出明显区分
    const d = c.data as { text?: string; images?: string[] };
    return (
      <div className="user-msg my-1.5 ml-10 flex flex-col items-end gap-1">
        <div className="max-w-[85%] px-3 py-1.5 rounded-lg rounded-br-none border border-emerald-500/30 bg-emerald-500/10 text-emerald-100 text-[13px] whitespace-pre-wrap">
          {d.text}
        </div>
        {!!d.images?.length && (
          <div className="flex gap-1 flex-wrap justify-end">
            {d.images.map((src, i) => (
              <img key={i} src={src} alt="" className="h-12 w-12 object-cover rounded border border-zinc-700" />
            ))}
          </div>
        )}
        <span className="text-zinc-600 text-[10px]">{fmtTime(c.ts, lang)}</span>
      </div>
    );
  }
  if (c.type === 'assistant') {
    const { text, thinking } = assistantData(c.data);
    const streaming = c.done === false;
    // 空帧(无文本无思考的非流式帧)只渲染一个孤立时间戳,跳过
    if (!text && !thinking && !streaming) return null;
    return (
      <div className="py-0.5">
        <span className="text-zinc-600 text-[10px] mr-2">{fmtTime(c.ts, lang)}</span>
        {thinking && <ThinkingBlock text={thinking} streaming={streaming && !text} />}
        <div className="md text-emerald-300 text-[13px]">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
          {streaming && <span className="animate-pulse text-emerald-500">▍</span>}
        </div>
      </div>
    );
  }
  if (c.type === 'tool') return <ToolCard c={c} />;
  if (c.type === 'result')
    return (
      <div className="py-1 mt-1 border-t border-zinc-800">
        <span className="text-zinc-600 text-[10px] mr-2">{fmtTime(c.ts, lang)}</span>
        <div className="md text-cyan-300 text-[13px] font-semibold">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{String(c.data)}</ReactMarkdown>
        </div>
      </div>
    );
  if (c.type === 'stderr')
    return (
      <div className="py-0.5">
        <span className="text-zinc-600 text-[10px] mr-2">{fmtTime(c.ts, lang)}</span>
        <span className="text-red-400 text-xs">{String(c.data)}</span>
      </div>
    );
  return (
    <div className="py-0.5">
      <span className="text-zinc-600 text-[10px] mr-2">{fmtTime(c.ts, lang)}</span>
      <span className="text-zinc-500 text-xs">{JSON.stringify(c.data).slice(0, 200)}</span>
    </div>
  );
}

/** 进程退出时内核会再写一条 result chunk，内容与最后一条 assistant 相同——去重避免终端显示两遍 */
function dedupeResult(chunks: OutputChunk[]): OutputChunk[] {
  return chunks.filter((c, i) => {
    if (c.type !== 'result') return true;
    const text = String(c.data ?? '');
    if (!text) return true;
    for (let j = i - 1; j >= 0; j--) {
      const p = chunks[j];
      if (p.type === 'result') return true; // 中间隔着另一条 result，保留
      if (p.type === 'assistant') return assistantData(p.data).text !== text;
    }
    return true;
  });
}

export function Terminal({ pid, snap, chunks, onSend, onInterrupt }: Props) {
  const { t } = useI18n();
  const [input, setInput] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const visible = useMemo(() => dedupeResult(chunks), [chunks]);
  useEffect(() => {
    // chunks 每次更新都是新数组（含流式同 id 覆盖），保证流式期间也持续滚到底
    bottomRef.current?.scrollIntoView({ behavior: 'instant' });
  }, [visible, pid]);

  const alive = snap ? !['done', 'failed', 'killed'].includes(snap.state) : false;
  const generating = alive && snap?.blockedReason === 'ON_LLM';

  const pickImages = (files: FileList | null) => {
    if (!files) return;
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('image/') || f.size > 2_000_000) continue;
      const r = new FileReader();
      r.onload = () => setImages((prev) => [...prev, String(r.result)]);
      r.readAsDataURL(f);
    }
  };

  const submit = () => {
    const text = input.trim();
    if (!text && images.length === 0) return;
    onSend(text, images);
    setInput('');
    setImages([]);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 text-[11px] uppercase tracking-wider text-zinc-500 border-b border-zinc-800 flex justify-between">
        <span>
          {t('terminal.attachPrefix')} <span className="text-emerald-400">PID {pid}</span>
          {snap?.name ? t('terminal.attachName', { name: snap.name }) : ''}
        </span>
        <span className="text-zinc-600">
          {generating && <span className="text-emerald-500 animate-pulse mr-2">{t('terminal.generating')}</span>}
          {snap
            ? t('terminal.turnInfo', {
                state: snap.state,
                reason: snap.blockedReason ? ':' + snap.blockedReason : '',
                turns: snap.turns,
              })
            : ''}
        </span>
      </div>
      <div className="flex-1 overflow-auto px-3 py-2 font-mono text-xs bg-zinc-950/60">
        {visible.length === 0 && <div className="text-zinc-700 italic">{t('terminal.empty')}</div>}
        {visible.map((c, i) => (
          <ChunkView key={c.id ?? i} c={c} />
        ))}
        <div ref={bottomRef} />
      </div>

      {/* 图片预览条 */}
      {images.length > 0 && (
        <div className="border-t border-zinc-800 px-3 py-2 flex gap-2 flex-wrap bg-zinc-900/40">
          {images.map((src, i) => (
            <div key={i} className="relative group">
              <img src={src} alt="" className="h-14 w-14 object-cover rounded border border-zinc-700" />
              <button
                onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                className="absolute -top-1.5 -right-1.5 h-4 w-4 rounded-full bg-zinc-700 text-zinc-300 text-[10px] leading-none hover:bg-red-500/80"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <form
        className="border-t border-zinc-800 flex items-center"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <span className="px-3 py-2 text-emerald-500 font-mono text-xs select-none">user@pid{pid} ❯</span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onPaste={(e) => pickImages(e.clipboardData?.files ?? null)}
          placeholder={alive ? t('terminal.placeholderAlive') : t('terminal.placeholderExited')}
          className="flex-1 bg-transparent px-2 py-2 text-xs font-mono text-zinc-200 outline-none placeholder:text-zinc-700"
        />
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            pickImages(e.target.files);
            e.target.value = '';
          }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          title={t('terminal.attachImageTitle')}
          className="px-3 py-2 text-zinc-500 hover:text-emerald-400 text-sm"
        >
          📎
        </button>
        <button
          type="button"
          onClick={onInterrupt}
          disabled={!generating}
          title={t('terminal.interruptTitle')}
          data-testid="terminal-interrupt"
          className={`px-3 py-2 text-xs font-mono border-l border-zinc-800 ${
            generating ? 'text-amber-400 hover:bg-amber-500/10' : 'text-zinc-700 cursor-not-allowed'
          }`}
        >
          {t('terminal.interrupt')}
        </button>
        <button
          type="submit"
          data-testid="terminal-send"
          className="px-4 text-xs font-mono text-emerald-400 hover:bg-emerald-500/10 border-l border-zinc-800"
        >
          {t('terminal.send')}
        </button>
      </form>
    </div>
  );
}
