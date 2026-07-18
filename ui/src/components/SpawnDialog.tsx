import { useState } from 'react';
import type { SpawnParams } from '@/lib/driver';
import { useI18n } from '@/i18n';

interface Props {
  parentPid: number;
  mode: 'demo' | 'live';
  /** 注册表扁平化模型列表；缺省/为空时回退到硬编码选项 */
  models?: string[];
  /** 控制台默认模型（选中项） */
  defaultModel?: string;
  onClose: () => void;
  onSubmit: (params: SpawnParams) => void;
}

export function SpawnDialog({ parentPid, mode, models, defaultModel, onClose, onSubmit }: Props) {
  const { t } = useI18n();
  const [task, setTask] = useState('');
  const [name, setName] = useState('');
  const [model, setModel] = useState(() =>
    models?.length && defaultModel && models.includes(defaultModel) ? defaultModel : '',
  );
  const [budget, setBudget] = useState('');

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        data-testid="spawn-dialog"
        className="w-[480px] bg-zinc-950 border border-zinc-800 rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-zinc-800 text-sm text-zinc-200 font-mono">
          {t('spawn.title')} <span className="text-zinc-500">{t('spawn.parentInfo', { pid: parentPid })}</span>
        </div>
        <div className="p-4 space-y-3 text-xs font-mono">
          <div>
            <label className="text-zinc-500 block mb-1">{t('spawn.taskLabel')}</label>
            <textarea
              value={task}
              onChange={(e) => setTask(e.target.value)}
              rows={3}
              className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-zinc-200 outline-none focus:border-emerald-500/50"
              placeholder={t('spawn.taskPlaceholder')}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-zinc-500 block mb-1">{t('spawn.nameLabel')}</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-zinc-200 outline-none focus:border-emerald-500/50"
                placeholder={t('spawn.namePlaceholder')}
              />
            </div>
            <div>
              <label className="text-zinc-500 block mb-1">{t('spawn.modelLabel')}</label>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                data-testid="spawn-model-select"
                className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-zinc-200 outline-none"
              >
                <option value="">{t('spawn.inheritOption')}</option>
                {models?.length ? (
                  models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                      {m === defaultModel ? t('spawn.defaultSuffix') : ''}
                    </option>
                  ))
                ) : mode === 'demo' ? (
                  <option value="demo-mock-v1">demo-mock-v1</option>
                ) : (
                  <>
                    <option value="deepseek-v4-pro">deepseek-v4-pro</option>
                    <option value="deepseek-v4-flash">deepseek-v4-flash</option>
                  </>
                )}
              </select>
            </div>
          </div>
          <div>
            <label className="text-zinc-500 block mb-1">{t('spawn.budgetLabel')}</label>
            <input
              value={budget}
              onChange={(e) => setBudget(e.target.value.replace(/[^0-9]/g, ''))}
              className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-zinc-200 outline-none focus:border-emerald-500/50"
              placeholder={t('spawn.budgetPlaceholder')}
            />
          </div>
        </div>
        <div className="px-4 py-3 border-t border-zinc-800 flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-xs font-mono text-zinc-400 hover:text-zinc-200">
            {t('spawn.cancel')}
          </button>
          <button
            onClick={() => task.trim() && onSubmit({ task: task.trim(), name: name || undefined, model: model || undefined, budgetTokens: budget ? Number(budget) : undefined })}
            data-testid="spawn-submit"
            className="px-4 py-1.5 text-xs font-mono bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 rounded hover:bg-emerald-500/30"
          >
            {t('spawn.submit')}
          </button>
        </div>
      </div>
    </div>
  );
}
