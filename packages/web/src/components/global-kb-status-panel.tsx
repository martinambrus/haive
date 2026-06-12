'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api-client';
import { Button } from '@/components/ui';

interface GlobalKbConfig {
  enabled: boolean;
  mode: string;
  ollamaUrl: string;
  embedModel: string;
  embedDimensions: number;
}

interface TestResult {
  ok: boolean;
  message: string;
}

type RowState = 'pending' | 'ok' | 'fail';

function StatusRow({ label, state, detail }: { label: string; state: RowState; detail: string }) {
  const icon = state === 'pending' ? '…' : state === 'ok' ? '✅' : '❌';
  const color =
    state === 'ok' ? 'text-green-300' : state === 'fail' ? 'text-red-300' : 'text-neutral-400';
  return (
    <div className="flex items-start gap-2 text-sm">
      <span className="w-5 shrink-0 text-center">{icon}</span>
      <span className="w-28 shrink-0 text-neutral-300">{label}</span>
      <span className={color}>{detail}</span>
    </div>
  );
}

/** Live status of the instance-level global KB, rendered inside the onboarding
 *  "Global knowledge base" step. Validates via the same endpoints the settings
 *  page uses, then offers a single action button: open the settings page to ADD
 *  a house rule (when healthy) or to FIX the configuration (when not). */
export function GlobalKbStatusPanel({
  repositoryId,
  cliProviderId,
}: {
  repositoryId: string | null;
  cliProviderId: string | null;
}) {
  const [cfg, setCfg] = useState<GlobalKbConfig | null>(null);
  const [db, setDb] = useState<TestResult | null>(null);
  const [ollama, setOllama] = useState<TestResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const config = await api.get<GlobalKbConfig>('/global-kb/config');
        if (cancelled) return;
        setCfg(config);
        const [dbRes, ollamaRes] = await Promise.all([
          api
            .post<TestResult>('/global-kb/test-db', { mode: config.mode })
            .catch((e) => ({ ok: false, message: (e as Error).message })),
          api
            .post<TestResult>('/global-kb/test-ollama', {
              ollamaUrl: config.ollamaUrl,
              model: config.embedModel,
              dimensions: config.embedDimensions,
            })
            .catch((e) => ({ ok: false, message: (e as Error).message })),
        ]);
        if (cancelled) return;
        setDb(dbRes);
        setOllama(ollamaRes);
      } catch (e) {
        if (!cancelled) {
          const message = (e as Error).message || 'failed to load global KB settings';
          setDb({ ok: false, message });
          setOllama({ ok: false, message });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const allOk = !!cfg?.enabled && !!db?.ok && !!ollama?.ok;
  const params = new URLSearchParams();
  if (repositoryId) params.set('repo', repositoryId);
  if (cliProviderId) params.set('cli', cliProviderId);
  const qs = params.toString();
  const base = `/settings/global-kb${qs ? `?${qs}` : ''}`;
  const href = allOk ? `${base}#add` : base;

  return (
    <div className="flex flex-col gap-3 rounded-md border border-neutral-800 bg-neutral-950/60 p-3">
      <div className="flex flex-col gap-1.5">
        <StatusRow
          label="Enabled"
          state={!cfg ? 'pending' : cfg.enabled ? 'ok' : 'fail'}
          detail={
            !cfg
              ? 'checking…'
              : cfg.enabled
                ? 'global KB retrieval is on'
                : 'disabled — turn it on in settings'
          }
        />
        <StatusRow
          label="Database"
          state={!db ? 'pending' : db.ok ? 'ok' : 'fail'}
          detail={!db ? 'checking…' : db.message}
        />
        <StatusRow
          label="Ollama / model"
          state={!ollama ? 'pending' : ollama.ok ? 'ok' : 'fail'}
          detail={!ollama ? 'checking…' : ollama.message}
        />
      </div>
      <div>
        <Button
          type="button"
          size="sm"
          variant={allOk ? 'primary' : 'secondary'}
          onClick={() => window.open(href, '_blank', 'noopener')}
        >
          {allOk ? 'Add Global House KB (optional)' : 'Fix Settings'}
        </Button>
      </div>
      <p className="text-xs text-neutral-500">
        Optional, but valuable: anything you add — the modules you standardize on, the patterns you
        repeat, the mistakes you learned to avoid — is reused by every future project. Set up once.
      </p>
    </div>
  );
}
