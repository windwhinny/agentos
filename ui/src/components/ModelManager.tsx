import { useState } from 'react';
import type { AddProviderInput, ModelsState } from '@/lib/driver';
import { useI18n } from '@/i18n';

interface Props {
  models: ModelsState;
  onClose: () => void;
  onAddProvider: (input: AddProviderInput) => Promise<unknown>;
  onRemoveProvider: (name: string) => Promise<unknown>;
  onSetDefault: (model: string) => Promise<unknown>;
}

const TYPE_BADGE: Record<string, string> = {
  openai: 'border-sky-500/40 text-sky-400',
  anthropic: 'border-orange-500/40 text-orange-400',
  deepseek: 'border-violet-500/40 text-violet-400',
  mock: 'border-amber-500/40 text-amber-400',
};

/** 模型管理面板:供应商录入/删除、默认模型设置 */
export function ModelManager({ models, onClose, onAddProvider, onRemoveProvider, onSetDefault }: Props) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [type, setType] = useState<'openai' | 'anthropic'>('openai');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [modelsCsv, setModelsCsv] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [settingDefault, setSettingDefault] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
    }
  };

  const submitAdd = () =>
    run(async () => {
      const list = modelsCsv.split(',').map((m) => m.trim()).filter(Boolean);
      if (!name.trim()) throw new Error(t('modelManager.errNameRequired'));
      if (!apiKey.trim()) throw new Error(t('modelManager.errKeyRequired'));
      if (list.length === 0) throw new Error(t('modelManager.errModelsRequired'));
      setAdding(true);
      try {
        await onAddProvider({
          name: name.trim(),
          type,
          apiKey: apiKey.trim(),
          baseUrl: baseUrl.trim() || undefined,
          models: list,
        });
        setName('');
        setBaseUrl('');
        setApiKey('');
        setModelsCsv('');
      } finally {
        setAdding(false);
      }
    });

  const remove = (n: string) =>
    run(async () => {
      setRemoving(n);
      try {
        await onRemoveProvider(n);
      } finally {
        setRemoving(null);
      }
    });

  const setDefault = (m: string) =>
    run(async () => {
      setSettingDefault(m);
      try {
        await onSetDefault(m);
      } finally {
        setSettingDefault(null);
      }
    });

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        data-testid="model-manager"
        className="w-[560px] max-h-[80vh] flex flex-col bg-zinc-950 border border-zinc-800 rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-zinc-800 text-sm text-zinc-200 font-mono flex items-center justify-between shrink-0">
          <span>
            {t('modelManager.title')} <span className="text-zinc-500">{t('modelManager.subtitle')}</span>
          </span>
          <button
            onClick={onClose}
            data-testid="model-manager-close"
            className="text-zinc-500 hover:text-zinc-200 px-1"
            aria-label={t('modelManager.close')}
          >
            ✕
          </button>
        </div>

        <div className="p-4 space-y-3 text-xs font-mono overflow-y-auto">
          {models.providers.length === 0 && (
            <div className="text-zinc-500 py-2">{t('modelManager.empty')}</div>
          )}
          {models.providers.map((p) => (
            <div
              key={p.name}
              data-testid={`provider-card-${p.name}`}
              className="border border-zinc-800 rounded p-3 space-y-2 bg-zinc-900/40"
            >
              <div className="flex items-center gap-2">
                <span className="text-zinc-200">{p.name}</span>
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded border ${TYPE_BADGE[p.type] ?? 'border-zinc-600 text-zinc-400'}`}
                >
                  {p.type}
                </span>
                {!p.hasKey && <span className="text-[10px] text-red-400">{t('modelManager.missingKey')}</span>}
                <button
                  onClick={() => remove(p.name)}
                  disabled={removing !== null}
                  data-testid={`provider-delete-${p.name}`}
                  className="ml-auto px-2 py-0.5 text-[10px] text-red-400/80 border border-red-500/30 rounded hover:bg-red-500/10 disabled:opacity-40"
                >
                  {removing === p.name ? t('modelManager.deleting') : t('modelManager.delete')}
                </button>
              </div>
              {p.baseUrl && <div className="text-[10px] text-zinc-500 break-all">{p.baseUrl}</div>}
              <div className="flex flex-wrap gap-1.5">
                {p.models.map((m) => {
                  const isDefault = m === models.defaultModel;
                  return (
                    <button
                      key={m}
                      onClick={() => !isDefault && setDefault(m)}
                      disabled={settingDefault !== null}
                      title={isDefault ? t('modelManager.isDefault') : t('modelManager.setDefault')}
                      data-testid={`model-chip-${m}`}
                      className={`px-2 py-0.5 rounded border text-[10px] transition-colors disabled:cursor-wait ${
                        isDefault
                          ? 'border-emerald-500/50 text-emerald-300 bg-emerald-500/10 cursor-default'
                          : 'border-zinc-700 text-zinc-400 hover:border-emerald-500/40 hover:text-emerald-300'
                      }`}
                    >
                      {settingDefault === m ? '…' : m}
                      {isDefault && ' ★'}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          <form
            data-testid="provider-add-form"
            className="border-t border-zinc-800 pt-3 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!adding) void submitAdd();
            }}
          >
            <div className="text-zinc-500">{t('modelManager.addProviderHeading')}</div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-zinc-500 block mb-1">{t('modelManager.nameLabel')}</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  data-testid="provider-name-input"
                  className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-zinc-200 outline-none focus:border-emerald-500/50"
                  placeholder={t('modelManager.namePlaceholder')}
                />
              </div>
              <div>
                <label className="text-zinc-500 block mb-1">{t('modelManager.typeLabel')}</label>
                <select
                  value={type}
                  onChange={(e) => setType(e.target.value as 'openai' | 'anthropic')}
                  data-testid="provider-type-select"
                  className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-zinc-200 outline-none"
                >
                  <option value="openai">openai</option>
                  <option value="anthropic">anthropic</option>
                </select>
              </div>
            </div>
            <div>
              <label className="text-zinc-500 block mb-1">{t('modelManager.baseUrlLabel')}</label>
              <input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                data-testid="provider-baseurl-input"
                className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-zinc-200 outline-none focus:border-emerald-500/50"
                placeholder="https://api.example.com/v1"
              />
            </div>
            <div>
              <label className="text-zinc-500 block mb-1">{t('modelManager.apiKeyLabel')}</label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                data-testid="provider-apikey-input"
                className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-zinc-200 outline-none focus:border-emerald-500/50"
                placeholder="sk-…"
                autoComplete="off"
              />
            </div>
            <div>
              <label className="text-zinc-500 block mb-1">{t('modelManager.modelsLabel')}</label>
              <input
                value={modelsCsv}
                onChange={(e) => setModelsCsv(e.target.value)}
                data-testid="provider-models-input"
                className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-zinc-200 outline-none focus:border-emerald-500/50"
                placeholder="gpt-4o, gpt-4o-mini"
              />
            </div>
            {error && (
              <div data-testid="model-manager-error" className="text-red-400">
                ✗ {error}
              </div>
            )}
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={adding}
                data-testid="provider-add-submit"
                className="px-4 py-1.5 bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 rounded hover:bg-emerald-500/30 disabled:opacity-40"
              >
                {adding ? t('modelManager.submitting') : t('modelManager.submit')}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
