'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { api, requestCheckoutSync } from '@/lib/api-client';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/dialog';
import { Button, Card, FormError, Label } from '@/components/ui';
import { InlineMarkdown } from '@/components/markdown/inline-markdown';
import { RepositoryIntegrations } from '@/components/integrations/repository-integrations';
import { ProjectStateConflictsBanner } from '@/components/project-state-conflicts-banner';
import { usePageTitle } from '@/lib/use-page-title';
import type { VerifyCommands } from '@haive/shared/schemas';
import {
  saveVerifyCommands,
  slotsFromConfig,
  VERIFY_COMMAND_MAX,
  VERIFY_SLOTS,
  type VerifyMode,
  type VerifySlots,
} from '@/lib/verify-commands';

interface LspOption {
  value: string;
  label: string;
  pinnable: boolean;
  versions: string[];
}

interface ReviewDimensionOption {
  value: string;
  label: string;
  hint: string;
}

interface ToolingConfig {
  repositoryId: string;
  cliTargets?: string[];
  cliTargetsEditable?: boolean;
  rtkEnabled: boolean;
  rtkVersion: string | null;
  rtkVersions: string[];
  chromeDevtoolsMcpVersion: string | null;
  chromeVersions: string[];
  browserTesting: boolean;
  lspServers: string[];
  lspServerVersions: Record<string, string | null>;
  secretMaskEnabled: boolean;
  secretMaskAllow: string[];
  secretMaskDenyExtend: string[];
  appAuth: {
    enabled: boolean;
    loginUrl: string;
    usernameSelector: string;
    passwordSelector: string;
    submitSelector: string;
    successCondition: { type: string; value: string };
  } | null;
  appAuthUsernameSet: boolean;
  appAuthPasswordSet: boolean;
  prWorkflowEnabled: boolean;
  stepGuidanceEnabled: boolean;
  stepGuidance: GuidanceItem[];
  lspOptions: LspOption[];
  reviewDimensions: string[];
  reviewDimensionOptions: ReviewDimensionOption[];
  verifyCommands?: VerifyCommands;
  /** ISO timestamp of the first embed failure, or null when healthy. The
   *  STRUCTURAL flag — gate on this, never on the reason string beside it. */
  ragEmbedDegradedAt: string | null;
  ragEmbedDegradedReason: string | null;
  ragEmbedLexicalOnly: boolean;
  pendingRepoMcpServers: string[] | null;
}

/** One learned guidance item currently appended to a step's prompt for this repo. */
interface GuidanceItem {
  id: string;
  stepId: string;
  scope: 'repo' | 'global';
  cause: string;
  guidance: string;
  /** CLI family the defect was observed under. Recorded but NOT filtered on: an item
   *  learned under one family is applied to all of them, so this is shown precisely so
   *  a wrong-family item can be spotted and turned off by hand. */
  providerFamily: string | null;
  occurrences: number;
  updatedAt: string;
}

function VersionSelect({
  value,
  onChange,
  versions,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  versions: string[];
  disabled?: boolean;
}) {
  const latestLabel = versions[0] ? `Latest (${versions[0]})` : 'Latest';
  return (
    <select
      className="h-9 rounded-md border border-neutral-800 bg-neutral-950 px-2 text-sm text-neutral-100 disabled:opacity-50"
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{latestLabel}</option>
      {versions.map((v) => (
        <option key={v} value={v}>
          {v}
        </option>
      ))}
    </select>
  );
}

export default function RepoToolingPage() {
  usePageTitle('Repository tooling');
  const params = useParams();
  const repositoryId = String(params.id);

  const [cliRemovalBusy, setCliRemovalBusy] = useState<string | null>(null);
  const [config, setConfig] = useState<ToolingConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const [rtkEnabled, setRtkEnabled] = useState(false);
  const [rtkVersion, setRtkVersion] = useState('');
  const [chromeVersion, setChromeVersion] = useState('');
  const [lspChecked, setLspChecked] = useState<Set<string>>(new Set());
  const [lspVersions, setLspVersions] = useState<Record<string, string>>({});
  const [secretMaskEnabled, setSecretMaskEnabled] = useState(true);
  const [secretMaskAllow, setSecretMaskAllow] = useState('');
  const [secretMaskDenyExtend, setSecretMaskDenyExtend] = useState('');
  const [appAuthEnabled, setAppAuthEnabled] = useState(false);
  const [appAuthLoginUrl, setAppAuthLoginUrl] = useState('');
  const [appAuthUserSel, setAppAuthUserSel] = useState('');
  const [appAuthPassSel, setAppAuthPassSel] = useState('');
  const [appAuthSubmitSel, setAppAuthSubmitSel] = useState('');
  const [appAuthCondType, setAppAuthCondType] = useState('url_contains');
  const [appAuthCondValue, setAppAuthCondValue] = useState('');
  const [appAuthUsername, setAppAuthUsername] = useState('');
  const [appAuthPassword, setAppAuthPassword] = useState('');
  const [appAuthUsernameSet, setAppAuthUsernameSet] = useState(false);
  const [appAuthPasswordSet, setAppAuthPasswordSet] = useState(false);
  const [clearCredsOpen, setClearCredsOpen] = useState(false);
  const [clearCredsBusy, setClearCredsBusy] = useState(false);
  const [clearCredsError, setClearCredsError] = useState<string | null>(null);
  const [prWorkflowEnabled, setPrWorkflowEnabled] = useState(false);
  const [stepGuidanceEnabled, setStepGuidanceEnabled] = useState(true);
  const [reviewDimensions, setReviewDimensions] = useState<Set<string>>(new Set());
  const [verifySlots, setVerifySlots] = useState<VerifySlots>(slotsFromConfig({}));
  const [verifySaving, setVerifySaving] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [verifySaved, setVerifySaved] = useState(false);
  const [guidance, setGuidance] = useState<GuidanceItem[]>([]);
  const [archiving, setArchiving] = useState<string | null>(null);
  const [ragEmbedBusy, setRagEmbedBusy] = useState<string | null>(null);
  const [ragEmbedNote, setRagEmbedNote] = useState<string | null>(null);
  const [mcpDecisionBusy, setMcpDecisionBusy] = useState<'accept' | 'discard' | null>(null);

  async function removeRepositoryCli(name: string) {
    if (!config?.cliTargets || config.cliTargetsEditable !== true || cliRemovalBusy) return;
    setCliRemovalBusy(name);
    setError(null);
    try {
      const result = await api.post<{ cliTargets: string[] }>(
        `/repositories/${repositoryId}/cli-targets/remove`,
        {
          providers: [name],
          expectedTargets: config.cliTargets,
        },
      );
      setConfig((current) => (current ? { ...current, cliTargets: result.cliTargets } : current));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCliRemovalBusy(null);
    }
  }

  async function decideRepoMcpServers(action: 'accept' | 'discard') {
    setMcpDecisionBusy(action);
    try {
      await api.patch(`/repositories/${repositoryId}/tooling`, { repoMcpServersAction: action });
      setConfig(await api.get<ToolingConfig>(`/repositories/${repositoryId}/tooling-config`));
    } catch (err) {
      setError((err as Error).message ?? 'Failed to record the MCP server decision');
    } finally {
      setMcpDecisionBusy(null);
    }
  }

  /** RAG embed-health actions are verbs with side effects, not form fields, so they
   *  PATCH on their own rather than riding the page's Save button. */
  async function runRagEmbedAction(action: 'retry' | 'accept_lexical_only' | 'rebuild_index') {
    setRagEmbedBusy(action);
    setRagEmbedNote(null);
    try {
      const res = await api.patch<{ reembedQueued?: boolean; degradationKept?: boolean }>(
        `/repositories/${repositoryId}/tooling`,
        { ragEmbedAction: action },
      );
      const cfg = await api.get<ToolingConfig>(`/repositories/${repositoryId}/tooling-config`);
      setConfig(cfg);
      setRagEmbedNote(
        res.reembedQueued
          ? 'Every chunk is marked for re-embedding; the next RAG sync on this repository rebuilds the index. Existing rows stay searchable until they are replaced.'
          : action === 'accept_lexical_only'
            ? 'Search on this repository now ranks by full text alone.'
            : res.degradationKept
              ? 'Embeddings will be attempted again on the next RAG sync. The warning stays until then: some chunks still await re-embed, or the index could not be checked.'
              : 'Embeddings will be attempted again on the next RAG sync.',
      );
    } catch (err) {
      setError((err as Error).message ?? 'Failed to update RAG embedding state');
    } finally {
      setRagEmbedBusy(null);
    }
  }

  useEffect(() => {
    void requestCheckoutSync(repositoryId);
    let cancelled = false;
    (async () => {
      try {
        const cfg = await api.get<ToolingConfig>(`/repositories/${repositoryId}/tooling-config`);
        if (cancelled) return;
        setConfig(cfg);
        setRtkEnabled(cfg.rtkEnabled);
        setRtkVersion(cfg.rtkVersion ?? '');
        setChromeVersion(cfg.chromeDevtoolsMcpVersion ?? '');
        setLspChecked(new Set(cfg.lspServers));
        const lv: Record<string, string> = {};
        for (const [k, v] of Object.entries(cfg.lspServerVersions)) if (v) lv[k] = v;
        setLspVersions(lv);
        setSecretMaskEnabled(cfg.secretMaskEnabled);
        setSecretMaskAllow((cfg.secretMaskAllow ?? []).join('\n'));
        setSecretMaskDenyExtend((cfg.secretMaskDenyExtend ?? []).join('\n'));
        setAppAuthEnabled(cfg.appAuth?.enabled ?? false);
        setAppAuthLoginUrl(cfg.appAuth?.loginUrl ?? '');
        setAppAuthUserSel(cfg.appAuth?.usernameSelector ?? '');
        setAppAuthPassSel(cfg.appAuth?.passwordSelector ?? '');
        setAppAuthSubmitSel(cfg.appAuth?.submitSelector ?? '');
        setAppAuthCondType(cfg.appAuth?.successCondition?.type ?? 'url_contains');
        setAppAuthCondValue(cfg.appAuth?.successCondition?.value ?? '');
        setAppAuthUsernameSet(cfg.appAuthUsernameSet ?? false);
        setAppAuthPasswordSet(cfg.appAuthPasswordSet ?? false);
        setPrWorkflowEnabled(cfg.prWorkflowEnabled);
        setStepGuidanceEnabled(cfg.stepGuidanceEnabled ?? true);
        setReviewDimensions(new Set(cfg.reviewDimensions ?? []));
        setVerifySlots(slotsFromConfig(cfg.verifyCommands));
        setGuidance(cfg.stepGuidance ?? []);
      } catch (err) {
        if (!cancelled) setError((err as Error).message ?? 'Failed to load tooling config');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repositoryId]);

  function markDirty() {
    setSaved(false);
  }

  // Applies immediately -- an item that is steering runs right now should not need a
  // "Save tooling" round-trip to be switched off. Archive, never delete: the row is
  // what a later run's fingerprint matches against, so deleting it would let the same
  // defect be re-offered as brand new.
  async function archiveGuidance(id: string) {
    if (archiving) return;
    setArchiving(id);
    setError(null);
    try {
      await api.post(`/repositories/${repositoryId}/step-guidance/${id}/archive`, {});
      setGuidance((prev) => prev.filter((g) => g.id !== id));
    } catch (err) {
      setError((err as Error).message ?? 'Failed to deactivate guidance');
    } finally {
      setArchiving(null);
    }
  }

  async function handleVerifySave() {
    if (verifySaving) return;
    setVerifySaving(true);
    setVerifyError(null);
    setVerifySaved(false);
    const res = await saveVerifyCommands(api, repositoryId, verifySlots);
    if (res.ok) {
      setVerifySlots(res.slots);
      setVerifySaved(true);
    } else {
      setVerifyError(res.error);
    }
    setVerifySaving(false);
  }

  function setVerifySlot(key: keyof VerifySlots, patch: { mode?: VerifyMode; text?: string }) {
    setVerifySlots((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
    setVerifySaved(false);
  }

  // The api writes the two secrets with no rollback, so a failed request can leave one changed.
  async function refreshCredentialFlags() {
    try {
      const cfg = await api.get<ToolingConfig>(`/repositories/${repositoryId}/tooling-config`);
      setAppAuthUsernameSet(cfg.appAuthUsernameSet);
      setAppAuthPasswordSet(cfg.appAuthPasswordSet);
      // The dialog unmounts with nothing stored; an open flag left behind would reopen it later.
      if (!cfg.appAuthUsernameSet && !cfg.appAuthPasswordSet) setClearCredsOpen(false);
    } catch {
      // Best effort: the flags stay as they were.
    }
  }

  async function handleSave() {
    if (saving || clearCredsBusy) return;
    // Mirrors the API's own guard. Checked here too so unticking the last dimension
    // reads as a form error rather than a failed request.
    if (reviewDimensions.size === 0) {
      setError('Pick at least one review dimension.');
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const lspServerVersions: Record<string, string> = {};
      for (const opt of config?.lspOptions ?? []) {
        if (lspChecked.has(opt.value) && opt.pinnable && lspVersions[opt.value]) {
          lspServerVersions[opt.value] = lspVersions[opt.value]!;
        }
      }
      await api.patch(`/repositories/${repositoryId}/tooling`, {
        rtkEnabled,
        rtkVersion: rtkVersion || null,
        chromeDevtoolsMcpVersion: chromeVersion || null,
        lspServers: [...lspChecked],
        lspServerVersions,
        secretMaskEnabled,
        secretMaskAllow: secretMaskAllow
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
        secretMaskDenyExtend: secretMaskDenyExtend
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
        prWorkflowEnabled,
        stepGuidanceEnabled,
        reviewDimensions: [...reviewDimensions],
        appAuth: {
          enabled: appAuthEnabled,
          loginUrl: appAuthLoginUrl,
          usernameSelector: appAuthUserSel,
          passwordSelector: appAuthPassSel,
          submitSelector: appAuthSubmitSel,
          successCondition: { type: appAuthCondType, value: appAuthCondValue },
        },
        // Sent only when retyped: an untouched field must not wipe a stored credential.
        ...(appAuthUsername ? { appAuthUsername } : {}),
        ...(appAuthPassword ? { appAuthPassword } : {}),
      });
      if (appAuthUsername) setAppAuthUsernameSet(true);
      if (appAuthPassword) setAppAuthPasswordSet(true);
      setAppAuthUsername('');
      setAppAuthPassword('');
      setSaved(true);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to save tooling');
      await refreshCredentialFlags();
    } finally {
      setSaving(false);
    }
  }

  async function handleClearCredentials() {
    // Clear and Save write the same credentials; their PATCHes could settle in either order.
    if (clearCredsBusy || saving) return;
    setClearCredsBusy(true);
    setClearCredsError(null);
    try {
      // '' is the api's deliberate clear, which is why Save never sends one.
      await api.patch(`/repositories/${repositoryId}/tooling`, {
        appAuthUsername: '',
        appAuthPassword: '',
      });
      setAppAuthUsernameSet(false);
      setAppAuthPasswordSet(false);
      setAppAuthUsername('');
      setAppAuthPassword('');
      setClearCredsOpen(false);
    } catch (err) {
      setClearCredsError((err as Error).message ?? 'Failed to clear the stored credentials');
      await refreshCredentialFlags();
    } finally {
      setClearCredsBusy(false);
    }
  }

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div>
        <Link href="/repos" className="text-xs text-indigo-300 hover:underline">
          ← Back to repositories
        </Link>
        <h1 className="mt-1 text-2xl font-bold text-neutral-50">Repository tooling</h1>
        <p className="text-sm text-neutral-400">
          Enable or disable RTK and LSP servers and pin their versions for this repository. Changes
          take effect when the repository&apos;s next task rebuilds its environment image.
        </p>
      </div>

      <ProjectStateConflictsBanner repositoryId={repositoryId} />

      <FormError message={error} />

      {!config ? (
        <p className="text-sm text-neutral-500">Loading...</p>
      ) : (
        <>
          {config.pendingRepoMcpServers && (
            <Card className="border-amber-500/40 bg-amber-950/20">
              <h2 className="text-lg font-semibold text-amber-200">
                MCP servers waiting for your decision
              </h2>
              <p className="mt-1 text-xs text-amber-100/80">
                This repository&apos;s committed Haive data (
                <code>.haive-data/state/settings/onboarding-tooling.json</code>, or the older{' '}
                <code>.haive-data/tooling.json</code>) names {config.pendingRepoMcpServers.length}{' '}
                MCP server definition
                {config.pendingRepoMcpServers.length === 1 ? '' : 's'} that{' '}
                {config.pendingRepoMcpServers.length === 1 ? 'was' : 'were'} not set up on this
                installation. Each definition is a command the CLI will EXECUTE, so none of them
                runs until you accept them here. Accept only if you recognise them, and read the
                file first if you did not add them yourself.
              </p>
              {config.pendingRepoMcpServers.length > 0 && (
                <p className="mt-2 break-words text-xs text-amber-100">
                  {config.pendingRepoMcpServers.slice(0, 20).map((name, i) => (
                    <span key={name}>
                      {i > 0 && ', '}
                      <code>{name}</code>
                    </span>
                  ))}
                  {config.pendingRepoMcpServers.length > 20 &&
                    ` and ${config.pendingRepoMcpServers.length - 20} more`}
                </p>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={mcpDecisionBusy !== null}
                  onClick={() => void decideRepoMcpServers('accept')}
                >
                  {mcpDecisionBusy === 'accept' ? 'Working...' : 'Use these servers'}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={mcpDecisionBusy !== null}
                  onClick={() => void decideRepoMcpServers('discard')}
                >
                  {mcpDecisionBusy === 'discard' ? 'Working...' : 'Discard'}
                </Button>
              </div>
            </Card>
          )}

          {(config.cliTargets?.length ?? 0) > 0 && (
            <Card>
              <h2 className="text-lg font-semibold text-neutral-100">Repository CLIs</h2>
              <InlineMarkdown
                className="mt-2 text-sm text-neutral-400"
                body="These CLIs are maintained for everyone using this repository. Removing one lets the next upgrade offer its files for removal or keeping."
              />
              <div className="mt-3 flex flex-wrap gap-3">
                {config.cliTargets?.map((name) => (
                  <div
                    key={name}
                    className="flex items-center gap-2 rounded border border-neutral-700 p-2"
                  >
                    <span>{name}</span>
                    {config.cliTargetsEditable === true && (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={cliRemovalBusy !== null}
                        onClick={() => void removeRepositoryCli(name)}
                      >
                        Remove {name}
                      </Button>
                    )}
                  </div>
                ))}
              </div>
              {config.cliTargetsEditable !== true && (
                <InlineMarkdown
                  className="mt-2 text-sm text-neutral-400"
                  body="Complete repository setup or an upgrade before changing these CLIs."
                />
              )}
            </Card>
          )}

          <Card>
            <h2 className="text-lg font-semibold text-neutral-100">RTK proxy</h2>
            <div className="mt-3 flex items-center gap-2">
              <input
                id="rtkEnabled"
                type="checkbox"
                className="h-4 w-4 rounded border-neutral-700 bg-neutral-900 text-indigo-500"
                checked={rtkEnabled}
                onChange={(e) => {
                  setRtkEnabled(e.target.checked);
                  markDirty();
                }}
              />
              <Label htmlFor="rtkEnabled">Enable RTK token-saving proxy</Label>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <Label>Version</Label>
              <VersionSelect
                value={rtkVersion}
                versions={config.rtkVersions}
                disabled={!rtkEnabled}
                onChange={(v) => {
                  setRtkVersion(v);
                  markDirty();
                }}
              />
            </div>
            <p className="mt-2 text-xs text-neutral-500">
              Disabling RTK flips the repo flag; its{' '}
              <code className="font-mono">.claude/settings.json</code> hook is removed by the next
              workflow upgrade (the upgrade banner will surface it).
            </p>
          </Card>

          <Card>
            <h2 className="text-lg font-semibold text-neutral-100">LSP servers</h2>
            <p className="mt-1 text-xs text-neutral-500">
              Servers baked into the environment image. rust-analyzer and jdtls cannot be version
              pinned (they track the toolchain / latest snapshot).
            </p>
            <div className="mt-3 flex flex-col gap-2">
              {config.lspOptions.map((opt) => {
                const checked = lspChecked.has(opt.value);
                return (
                  <div key={opt.value} className="flex flex-wrap items-center gap-2">
                    <input
                      id={`lsp-${opt.value}`}
                      type="checkbox"
                      className="h-4 w-4 rounded border-neutral-700 bg-neutral-900 text-indigo-500"
                      checked={checked}
                      onChange={(e) => {
                        setLspChecked((prev) => {
                          const n = new Set(prev);
                          if (e.target.checked) n.add(opt.value);
                          else n.delete(opt.value);
                          return n;
                        });
                        markDirty();
                      }}
                    />
                    <Label htmlFor={`lsp-${opt.value}`}>{opt.label}</Label>
                    {opt.pinnable ? (
                      <VersionSelect
                        value={lspVersions[opt.value] ?? ''}
                        versions={opt.versions}
                        disabled={!checked}
                        onChange={(v) => {
                          setLspVersions((prev) => ({ ...prev, [opt.value]: v }));
                          markDirty();
                        }}
                      />
                    ) : (
                      <span className="text-xs text-neutral-600">(not pinnable)</span>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>

          <Card>
            <h2 className="text-lg font-semibold text-neutral-100">Chrome DevTools MCP</h2>
            <p className="mt-1 text-xs text-neutral-500">
              Browser testing is enabled per task (currently{' '}
              {config.browserTesting ? 'active' : 'inactive'} for this repo&apos;s environment). Pin
              the version the agent launches here.
            </p>
            <div className="mt-3 flex items-center gap-2">
              <Label>Version</Label>
              <VersionSelect
                value={chromeVersion}
                versions={config.chromeVersions}
                onChange={(v) => {
                  setChromeVersion(v);
                  markDirty();
                }}
              />
            </div>
          </Card>

          <Card>
            <h2 className="text-lg font-semibold text-neutral-100">Secret file protection</h2>
            <p className="mt-1 text-xs text-neutral-500">
              Hides files that look like secrets (.env, keys, credentials, database dumps, …) from
              AI CLI agents by mounting empty files over them in the sandbox. The running app still
              sees the real files. Covers untracked files only — committed secrets are not masked.
            </p>
            <div className="mt-3 flex items-center gap-2">
              <input
                id="secretMaskEnabled"
                type="checkbox"
                className="h-4 w-4 rounded border-neutral-700 bg-neutral-900 text-indigo-500"
                checked={secretMaskEnabled}
                onChange={(e) => {
                  setSecretMaskEnabled(e.target.checked);
                  markDirty();
                }}
              />
              <Label htmlFor="secretMaskEnabled">Mask secret files from agents</Label>
            </div>
            <div className="mt-4 flex flex-col gap-1.5">
              <Label htmlFor="secretMaskAllow">Allow (un-mask) — one glob per line</Label>
              <textarea
                id="secretMaskAllow"
                className="min-h-20 rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1.5 font-mono text-xs text-neutral-100 disabled:opacity-50"
                placeholder={'**/.env.shared'}
                value={secretMaskAllow}
                disabled={!secretMaskEnabled}
                onChange={(e) => {
                  setSecretMaskAllow(e.target.value);
                  markDirty();
                }}
              />
              <p className="text-xs text-neutral-600">
                Files matching these globs stay readable even if they match the deny list.
              </p>
            </div>
            <div className="mt-4 flex flex-col gap-1.5">
              <Label htmlFor="secretMaskDenyExtend">Also mask — one glob per line</Label>
              <textarea
                id="secretMaskDenyExtend"
                className="min-h-20 rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1.5 font-mono text-xs text-neutral-100 disabled:opacity-50"
                placeholder={'**/*.sql'}
                value={secretMaskDenyExtend}
                disabled={!secretMaskEnabled}
                onChange={(e) => {
                  setSecretMaskDenyExtend(e.target.value);
                  markDirty();
                }}
              />
              <p className="text-xs text-neutral-600">
                Extra globs to mask on top of the built-in deny list (e.g. SQL files if your repo
                uses them as dumps rather than schema/migrations).
              </p>
            </div>
          </Card>

          {config && (config.ragEmbedDegradedAt || config.ragEmbedLexicalOnly) && (
            <Card>
              <h2 className="text-lg font-semibold text-neutral-100">RAG embeddings</h2>
              {config.ragEmbedLexicalOnly ? (
                <p className="mt-1 text-xs text-neutral-500">
                  This repository is set to <strong>lexical-only</strong> search: chunks are indexed
                  without model embeddings and results rank by full-text relevance alone. Semantic
                  matches are unavailable. Re-enabling embeddings re-indexes every chunk, because
                  the stored vectors cannot be reused.
                </p>
              ) : (
                <p className="mt-1 text-xs text-neutral-500">
                  Embeddings failed on {new Date(config.ragEmbedDegradedAt!).toLocaleString()} —{' '}
                  {config.ragEmbedDegradedReason ?? 'reason unrecorded'}. Affected chunks were left
                  unindexed rather than stored with meaningless vectors, so they are not searchable
                  yet. If the cause was a slow host, raise the ingest timeout or lower the batch
                  size under Admin → RAG embedding budgets before retrying.
                </p>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={ragEmbedBusy !== null}
                  onClick={() => void runRagEmbedAction('retry')}
                >
                  {ragEmbedBusy === 'retry'
                    ? 'Working...'
                    : config.ragEmbedLexicalOnly
                      ? 'Re-enable embeddings'
                      : 'Retry embeddings'}
                </Button>
                {!config.ragEmbedLexicalOnly && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={ragEmbedBusy !== null}
                    onClick={() => void runRagEmbedAction('accept_lexical_only')}
                  >
                    {ragEmbedBusy === 'accept_lexical_only'
                      ? 'Working...'
                      : 'Accept lexical-only search'}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={ragEmbedBusy !== null}
                  onClick={() => void runRagEmbedAction('rebuild_index')}
                >
                  {ragEmbedBusy === 'rebuild_index' ? 'Working...' : 'Rebuild index'}
                </Button>
              </div>
              {ragEmbedNote && (
                <InlineMarkdown body={ragEmbedNote} className="mt-2 text-xs text-emerald-400" />
              )}
            </Card>
          )}

          <Card>
            <h2 className="text-lg font-semibold text-neutral-100">App login (browser testing)</h2>
            <p className="mt-1 text-xs text-neutral-500">
              Logs the task&apos;s browser into your app once, before any agent tests it, so browser
              testing reaches what is behind the login instead of stopping at it. The login runs as
              plain code inside the runner — the username and password are stored encrypted and are
              never put in a prompt, so they never reach a CLI provider. Form logins only: SSO,
              2FA/TOTP and magic-link flows are not supported.
            </p>
            <div className="mt-3 flex items-center gap-2">
              <input
                id="appAuthEnabled"
                type="checkbox"
                className="h-4 w-4 rounded border-neutral-700 bg-neutral-900 text-indigo-500"
                checked={appAuthEnabled}
                onChange={(e) => {
                  setAppAuthEnabled(e.target.checked);
                  markDirty();
                }}
              />
              <Label htmlFor="appAuthEnabled">Log in before browser testing</Label>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {(
                [
                  [
                    'appAuthLoginUrl',
                    'Login page URL',
                    appAuthLoginUrl,
                    setAppAuthLoginUrl,
                    'https://myapp.ddev.site/login',
                  ],
                  [
                    'appAuthUserSel',
                    'Username field selector',
                    appAuthUserSel,
                    setAppAuthUserSel,
                    '#email',
                  ],
                  [
                    'appAuthPassSel',
                    'Password field selector',
                    appAuthPassSel,
                    setAppAuthPassSel,
                    '#password',
                  ],
                  [
                    'appAuthSubmitSel',
                    'Submit button selector',
                    appAuthSubmitSel,
                    setAppAuthSubmitSel,
                    'button[type="submit"]',
                  ],
                ] as const
              ).map(([id, label, value, setter, placeholder]) => (
                <div key={id} className="flex flex-col gap-1.5">
                  <Label htmlFor={id}>{label}</Label>
                  <input
                    id={id}
                    className="rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1.5 font-mono text-xs text-neutral-100 disabled:opacity-50"
                    placeholder={placeholder}
                    value={value}
                    disabled={!appAuthEnabled}
                    onChange={(e) => {
                      setter(e.target.value);
                      markDirty();
                    }}
                  />
                </div>
              ))}
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="appAuthCondType">Confirm the login worked by</Label>
                <select
                  id="appAuthCondType"
                  className="rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-xs text-neutral-100 disabled:opacity-50"
                  value={appAuthCondType}
                  disabled={!appAuthEnabled}
                  onChange={(e) => {
                    setAppAuthCondType(e.target.value);
                    markDirty();
                  }}
                >
                  <option value="url_contains">URL contains</option>
                  <option value="element_present">Element is present</option>
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="appAuthCondValue">
                  {appAuthCondType === 'url_contains' ? 'URL fragment' : 'Selector'}
                </Label>
                <input
                  id="appAuthCondValue"
                  className="rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1.5 font-mono text-xs text-neutral-100 disabled:opacity-50"
                  placeholder={appAuthCondType === 'url_contains' ? '/dashboard' : '.avatar'}
                  value={appAuthCondValue}
                  disabled={!appAuthEnabled}
                  onChange={(e) => {
                    setAppAuthCondValue(e.target.value);
                    markDirty();
                  }}
                />
              </div>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="appAuthUsername">Username</Label>
                <input
                  id="appAuthUsername"
                  autoComplete="off"
                  className="rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-xs text-neutral-100 disabled:opacity-50"
                  placeholder={appAuthUsernameSet ? '•••••• (stored)' : 'test user'}
                  value={appAuthUsername}
                  disabled={!appAuthEnabled}
                  onChange={(e) => {
                    setAppAuthUsername(e.target.value);
                    markDirty();
                  }}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="appAuthPassword">Password</Label>
                <input
                  id="appAuthPassword"
                  type="password"
                  autoComplete="new-password"
                  className="rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-xs text-neutral-100 disabled:opacity-50"
                  placeholder={appAuthPasswordSet ? '•••••• (stored)' : ''}
                  value={appAuthPassword}
                  disabled={!appAuthEnabled}
                  onChange={(e) => {
                    setAppAuthPassword(e.target.value);
                    markDirty();
                  }}
                />
              </div>
            </div>
            <p className="mt-2 text-xs text-neutral-600">
              {appAuthUsernameSet && appAuthPasswordSet
                ? 'Credentials are stored. Leave both blank to keep them; type to replace.'
                : "Credentials are stored encrypted, separately from this repository's settings."}
            </p>
            {(appAuthUsernameSet || appAuthPasswordSet) && (
              <>
                <Button
                  size="sm"
                  variant="secondary"
                  className="mt-3"
                  disabled={saving}
                  onClick={() => {
                    setClearCredsError(null);
                    setClearCredsOpen(true);
                  }}
                >
                  Clear stored credentials
                </Button>
                <Dialog
                  className="mx-4"
                  open={clearCredsOpen}
                  onOpenChange={(open) => !open && !clearCredsBusy && setClearCredsOpen(false)}
                >
                  <DialogContent role="alertdialog" aria-labelledby="clear-creds-title">
                    <DialogHeader>
                      <DialogTitle id="clear-creds-title">Clear stored credentials</DialogTitle>
                      <p className="text-sm text-neutral-300 [overflow-wrap:anywhere]">
                        Remove the stored username and password for this repository&apos;s app
                        login? Runs that need them will fail to log in until you enter new ones.
                      </p>
                    </DialogHeader>
                    <FormError message={clearCredsError} />
                    <div className="mt-4 flex justify-end gap-2">
                      <Button
                        variant="secondary"
                        className="h-11"
                        disabled={clearCredsBusy}
                        onClick={() => setClearCredsOpen(false)}
                      >
                        Cancel
                      </Button>
                      <Button
                        variant="destructive"
                        className="h-11"
                        disabled={clearCredsBusy || saving}
                        onClick={() => void handleClearCredentials()}
                      >
                        {clearCredsBusy ? 'Clearing...' : 'Clear credentials'}
                      </Button>
                    </div>
                  </DialogContent>
                </Dialog>
              </>
            )}
          </Card>

          <Card>
            <h2 className="text-lg font-semibold text-neutral-100">Pull-request close-out</h2>
            <p className="mt-1 text-xs text-neutral-500">
              Adds a &quot;create a pull request&quot; option at task close, alongside the local
              merge. The task opens a PR on this repo&apos;s forge and waits for it to merge instead
              of merging locally. Requires the global PR-workflow switch (admin settings) and a
              repository credential with its forge provider set. Applies to workflow tasks only.
            </p>
            <div className="mt-3 flex items-center gap-2">
              <input
                id="prWorkflowEnabled"
                type="checkbox"
                className="h-4 w-4 rounded border-neutral-700 bg-neutral-900 text-indigo-500"
                checked={prWorkflowEnabled}
                onChange={(e) => {
                  setPrWorkflowEnabled(e.target.checked);
                  markDirty();
                }}
              />
              <Label htmlFor="prWorkflowEnabled">
                Offer &quot;create a pull request&quot; at task close
              </Label>
            </div>
          </Card>

          <Card>
            <h2 className="text-lg font-semibold text-neutral-100">Review dimensions</h2>
            <p className="mt-1 text-xs text-neutral-500">
              What the reviewing steps score a change against &mdash; the spec writer, the spec
              quality review, the implementation validation and the code review. Untick a dimension
              this project does not have (an intranet tool with no accessibility requirement, say)
              and no agent will be asked to mine, specify or review it. A dimension left unticked is
              not reviewed at all: Gate 2 says so on every run, because no findings against a
              dimension is not the same as passing it. A single task can narrow this further on its
              run-configuration step, but never widen it for the steps that already ran.
            </p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {(config.reviewDimensionOptions ?? []).map((opt) => {
                const checked = reviewDimensions.has(opt.value);
                return (
                  <div key={opt.value} className="flex items-start gap-2">
                    <input
                      id={`dimension-${opt.value}`}
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 rounded border-neutral-700 bg-neutral-900 text-indigo-500"
                      checked={checked}
                      onChange={(e) => {
                        setReviewDimensions((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(opt.value);
                          else next.delete(opt.value);
                          return next;
                        });
                        markDirty();
                      }}
                    />
                    <div className="min-w-0">
                      <Label htmlFor={`dimension-${opt.value}`}>{opt.label}</Label>
                      <p className="text-xs text-neutral-600">{opt.hint}</p>
                    </div>
                  </div>
                );
              })}
            </div>
            {reviewDimensions.size === 0 && (
              <p className="mt-3 text-xs text-amber-400">
                Pick at least one dimension &mdash; a review that scores nothing cannot be saved.
              </p>
            )}
          </Card>

          <Card>
            <h2 className="text-lg font-semibold text-neutral-100">Verify commands</h2>
            <InlineMarkdown
              className="mt-1 text-xs text-neutral-500"
              body={
                "**Auto** runs what is detected at the repository root, as today. **Off** never runs that check. **Custom** runs your text as one shell command inside the task's environment (the DDEV web container or the sandbox), for example `vendor/bin/phpunit -c core modules/custom`. A custom **Lint** replaces both lint checks and is not limited to changed lines."
              }
            />
            <div className="mt-3 flex flex-col gap-4">
              {VERIFY_SLOTS.map(({ key, label }) => {
                const slot = verifySlots[key];
                return (
                  <div key={key} className="flex flex-col gap-2">
                    <div
                      role="radiogroup"
                      aria-label={`${label} command`}
                      className="flex flex-wrap items-center gap-x-4 gap-y-1"
                    >
                      <span className="w-24 text-sm font-medium text-neutral-200">{label}</span>
                      {(
                        [
                          ['auto', 'Auto'],
                          ['off', 'Off'],
                          ['custom', 'Custom'],
                        ] as const
                      ).map(([mode, modeLabel]) => (
                        <label
                          key={mode}
                          className="flex items-center gap-1.5 text-sm text-neutral-300"
                        >
                          <input
                            type="radio"
                            name={`verify-${key}`}
                            className="h-4 w-4 border-neutral-700 bg-neutral-900 text-indigo-500"
                            checked={slot.mode === mode}
                            disabled={verifySaving}
                            onChange={() => setVerifySlot(key, { mode })}
                          />
                          {modeLabel}
                        </label>
                      ))}
                    </div>
                    {slot.mode === 'custom' && (
                      <input
                        aria-label={`${label} command`}
                        className="w-full rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1.5 font-mono text-xs text-neutral-100"
                        maxLength={VERIFY_COMMAND_MAX}
                        placeholder="vendor/bin/phpunit -c core modules/custom"
                        value={slot.text}
                        disabled={verifySaving}
                        onChange={(e) => setVerifySlot(key, { text: e.target.value })}
                      />
                    )}
                  </div>
                );
              })}
            </div>
            {verifyError && (
              <div className="mt-3">
                <FormError message={verifyError} />
              </div>
            )}
            <div className="mt-3 flex items-center gap-3">
              <Button size="sm" onClick={() => void handleVerifySave()} disabled={verifySaving}>
                {verifySaving ? 'Saving...' : 'Save verify commands'}
              </Button>
              {verifySaved && <span className="text-sm text-emerald-400">Saved.</span>}
            </div>
          </Card>

          <Card>
            <h2 className="text-lg font-semibold text-neutral-100">Learned step guidance</h2>
            <p className="mt-1 text-xs text-neutral-500">
              Lessons about how Haive ASKED for the work, named by review agents during a run and
              approved by you at the triage step. Approved items are appended to that step&apos;s
              prompt on future runs &mdash; never substituted for it. Requires the global
              step-guidance switch (admin settings). Nothing here is statistically validated: a
              repeat count means the problem recurred, not that the guidance works.
            </p>
            <div className="mt-3 flex items-center gap-2">
              <input
                id="stepGuidanceEnabled"
                type="checkbox"
                className="h-4 w-4 rounded border-neutral-700 bg-neutral-900 text-indigo-500"
                checked={stepGuidanceEnabled}
                onChange={(e) => {
                  setStepGuidanceEnabled(e.target.checked);
                  markDirty();
                }}
              />
              <Label htmlFor="stepGuidanceEnabled">
                Capture and apply learned guidance for this repository
              </Label>
            </div>

            {guidance.length === 0 ? (
              <p className="mt-4 text-xs text-neutral-600">
                No guidance is steering this repository yet.
              </p>
            ) : (
              <ul className="mt-4 space-y-2">
                {guidance.map((g) => (
                  <li
                    key={g.id}
                    className="flex items-start justify-between gap-3 rounded border border-neutral-800 bg-neutral-950 p-3"
                  >
                    <div className="min-w-0">
                      <InlineMarkdown body={g.guidance} className="text-sm text-neutral-200" />
                      <p className="mt-1 text-xs text-neutral-500">
                        {g.stepId} ·{' '}
                        {g.scope === 'global' ? 'every repo on this stack' : 'this repo'} ·{' '}
                        {g.cause}
                        {g.providerFamily ? ` · seen on ${g.providerFamily}` : ''}
                        {g.occurrences > 1 ? ` · observed ${g.occurrences}x` : ''}
                      </p>
                      {g.scope === 'global' && (
                        <p className="mt-1 text-xs text-amber-600">
                          Deactivating this turns it off for every repository on this stack, not
                          just here.
                        </p>
                      )}
                    </div>
                    <Button
                      variant="secondary"
                      onClick={() => void archiveGuidance(g.id)}
                      disabled={archiving === g.id}
                    >
                      {archiving === g.id ? 'Deactivating...' : 'Deactivate'}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <div className="flex items-center gap-3">
            <Button onClick={handleSave} disabled={saving || clearCredsBusy}>
              {saving ? 'Saving...' : 'Save tooling'}
            </Button>
            {saved && (
              <span className="text-sm text-emerald-400">Saved. Rebuilds on next task.</span>
            )}
          </div>

          <RepositoryIntegrations repositoryId={repositoryId} />
        </>
      )}
    </div>
  );
}
