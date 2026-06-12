'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  type ApiError,
  type CliProvider,
  type GlobalKbEntry,
  type GlobalKbFacets,
  type Repository,
} from '@/lib/api-client';
import { usePageTitle } from '@/lib/use-page-title';
import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  FormError,
  Input,
  Label,
} from '@/components/ui';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/dialog';
import { MarkdownView } from '@/components/markdown/markdown-view';

function parseList(s: string): string[] {
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function facetsSummary(f: GlobalKbFacets): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(f)) {
    if (Array.isArray(v) && v.length) parts.push(`${k}: ${v.join('/')}`);
  }
  return parts.length ? parts.join(' · ') : 'applies to all stacks';
}

const STATUS_VARIANT: Record<string, 'success' | 'error' | 'warning' | 'default'> = {
  active: 'success',
  draft: 'warning',
  archived: 'default',
};

interface GlobalKbConfig {
  enabled: boolean;
  mode: 'internal' | 'external';
  namespace: string;
  ollamaUrl: string;
  embedModel: string;
  embedDimensions: number;
  connectionStringSet: boolean;
}

/** Ollama endpoints, mirroring onboarding step 04: internal = the bundled haive
 *  compose service; external default = an Ollama running on the host. */
const INTERNAL_OLLAMA_URL = 'http://ollama:11434';
const DEFAULT_EXTERNAL_OLLAMA_URL = 'http://host.docker.internal:11434';
const DEFAULT_EMBED_MODEL = 'qwen3-embedding:4b';

/** A saved ollamaUrl maps back to a mode: the bundled URL (or empty) is internal,
 *  anything else is an external server the user pointed at. */
function deriveOllamaMode(url: string): 'internal' | 'external' {
  return url && url !== INTERNAL_OLLAMA_URL ? 'external' : 'internal';
}

const CATEGORIES: GlobalKbEntry['category'][] = [
  'general',
  'tech_pattern',
  'anti_pattern',
  'best_practice',
  'quick_reference',
];
const PER_PAGE = 12;

export default function GlobalKbPage() {
  usePageTitle('Global KB');
  const [entries, setEntries] = useState<GlobalKbEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [frameworkFilter, setFrameworkFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [debouncedQ, setDebouncedQ] = useState('');
  const [total, setTotal] = useState(0);
  const [frameworks, setFrameworks] = useState<string[]>([]);
  const [selected, setSelected] = useState<GlobalKbEntry | null>(null);
  const [repos, setRepos] = useState<Repository[]>([]);
  const [providers, setProviders] = useState<CliProvider[]>([]);
  const [enrich, setEnrich] = useState({
    notes: '',
    repoId: '',
    cliProviderId: '',
    egressMode: 'none' as 'none' | 'allowlist' | 'full',
    egressDomains: '',
  });
  const [enrichBusy, setEnrichBusy] = useState(false);
  const [enrichError, setEnrichError] = useState<string | null>(null);
  // Arriving from the onboarding step-04 link (?repo=&cli=) pre-fills the repo +
  // CLI so the user does not re-pick what the task already knows. Once, on mount.
  const prefilledEnrich = useRef(false);
  useEffect(() => {
    if (prefilledEnrich.current) return;
    prefilledEnrich.current = true;
    const params = new URLSearchParams(window.location.search);
    const repo = params.get('repo');
    const cli = params.get('cli');
    if (repo || cli) {
      setEnrich((p) => ({
        ...p,
        repoId: repo ?? p.repoId,
        cliProviderId: cli ?? p.cliProviderId,
      }));
    }
  }, []);
  const [cfg, setCfg] = useState({
    enabled: true,
    mode: 'internal' as 'internal' | 'external',
    namespace: 'default',
    ollamaMode: 'internal' as 'internal' | 'external',
    ollamaUrl: '',
    embedModel: DEFAULT_EMBED_MODEL,
    embedDimensions: 2560,
    connectionString: '',
  });
  const [cfgSet, setCfgSet] = useState(false);
  const [cfgBusy, setCfgBusy] = useState(false);
  const [cfgMsg, setCfgMsg] = useState<string | null>(null);
  const [dbTest, setDbTest] = useState<{ busy: boolean; ok: boolean | null; msg: string | null }>({
    busy: false,
    ok: null,
    msg: null,
  });
  const [ollamaTest, setOllamaTest] = useState<{
    busy: boolean;
    ok: boolean | null;
    msg: string | null;
  }>({ busy: false, ok: null, msg: null });

  async function loadConfig() {
    try {
      const cc = await api.get<GlobalKbConfig>('/global-kb/config');
      setCfg((p) => ({
        ...p,
        enabled: cc.enabled,
        mode: cc.mode,
        namespace: cc.namespace,
        ollamaMode: deriveOllamaMode(cc.ollamaUrl),
        ollamaUrl: cc.ollamaUrl,
        embedModel: cc.embedModel,
        embedDimensions: cc.embedDimensions,
        connectionString: '',
      }));
      setCfgSet(cc.connectionStringSet);
    } catch {
      /* admin-only or unavailable */
    }
  }

  // Internal mode has no URL field; collapse the mode back to a concrete URL
  // (mirrors onboarding 04's apply) for both save and the Ollama test.
  const effectiveOllamaUrl =
    cfg.ollamaMode === 'internal'
      ? INTERNAL_OLLAMA_URL
      : cfg.ollamaUrl.trim() || DEFAULT_EXTERNAL_OLLAMA_URL;

  async function saveConfig() {
    setCfgBusy(true);
    setCfgMsg(null);
    try {
      const payload: Record<string, unknown> = {
        enabled: cfg.enabled,
        mode: cfg.mode,
        namespace: cfg.namespace,
        ollamaUrl: effectiveOllamaUrl,
        embedModel: cfg.embedModel,
        embedDimensions: cfg.embedDimensions,
      };
      if (cfg.connectionString.trim()) payload.connectionString = cfg.connectionString.trim();
      await api.put('/global-kb/config', payload);
      await loadConfig();
      setCfgMsg('Saved.');
    } catch (err) {
      setCfgMsg((err as ApiError).message ?? 'Save failed');
    } finally {
      setCfgBusy(false);
    }
  }

  async function testDb() {
    setDbTest({ busy: true, ok: null, msg: null });
    try {
      const r = await api.post<{ ok: boolean; message: string }>('/global-kb/test-db', {
        mode: cfg.mode,
        connectionString: cfg.connectionString.trim() || undefined,
      });
      setDbTest({ busy: false, ok: r.ok, msg: r.message });
    } catch (err) {
      setDbTest({ busy: false, ok: false, msg: (err as ApiError).message ?? 'Test failed' });
    }
  }

  async function testOllama() {
    setOllamaTest({ busy: true, ok: null, msg: null });
    try {
      const r = await api.post<{ ok: boolean; message: string }>('/global-kb/test-ollama', {
        ollamaUrl: effectiveOllamaUrl,
        model: cfg.embedModel,
        dimensions: cfg.embedDimensions,
      });
      setOllamaTest({ busy: false, ok: r.ok, msg: r.message });
    } catch (err) {
      setOllamaTest({ busy: false, ok: false, msg: (err as ApiError).message ?? 'Test failed' });
    }
  }

  // Fetch one page from the server. Search + filters run in SQL, so the browser
  // only ever holds the current page (never the whole body-laden corpus).
  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('pageSize', String(PER_PAGE));
      if (debouncedQ) params.set('q', debouncedQ);
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (categoryFilter !== 'all') params.set('category', categoryFilter);
      if (frameworkFilter !== 'all') params.set('framework', frameworkFilter);
      const res = await api.get<{ entries: GlobalKbEntry[]; total: number; frameworks: string[] }>(
        `/global-kb/entries?${params.toString()}`,
      );
      setEntries(res.entries);
      setTotal(res.total);
      setFrameworks(res.frameworks);
      setLoadError(null);
      // Deleting the last row on the last page can leave us past the end — clamp.
      if (res.entries.length === 0 && page > 1 && res.total > 0) {
        setPage(Math.max(1, Math.ceil(res.total / PER_PAGE)));
      }
    } catch (err) {
      setLoadError((err as ApiError).message ?? 'Failed to load global KB');
    }
  }, [page, debouncedQ, statusFilter, categoryFilter, frameworkFilter]);

  useEffect(() => {
    void loadConfig();
    void api
      .get<{ repositories: Repository[] }>('/repos')
      .then((r) => setRepos(r.repositories))
      .catch(() => {});
    void api
      .get<{ providers: CliProvider[] }>('/cli-providers')
      .then((r) => setProviders(r.providers))
      .catch(() => {});
  }, []);

  // Debounce the search box so each keystroke doesn't hit the API.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  // Reset to the first page whenever the query/filters change.
  useEffect(() => {
    setPage(1);
  }, [debouncedQ, statusFilter, categoryFilter, frameworkFilter]);

  // Fetch whenever the query/filters/page change.
  useEffect(() => {
    void load();
  }, [load]);

  // Keep polling the current page while anything is still enriching so it flips
  // to active on its own, then stops once everything has settled.
  const hasTransient = (entries ?? []).some(
    (e) => e.status === 'enriching' || e.status === 'skeleton',
  );
  useEffect(() => {
    if (!hasTransient) return;
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [hasTransient, load]);

  async function activate(e: GlobalKbEntry) {
    setBusy(true);
    try {
      await api.patch(`/global-kb/entries/${e.id}`, { status: 'active' });
      setSelected((s) => (s?.id === e.id ? null : s));
      await load();
    } catch (err) {
      setLoadError((err as ApiError).message ?? 'Activate failed');
    } finally {
      setBusy(false);
    }
  }

  async function remove(e: GlobalKbEntry) {
    if (!window.confirm(`Delete "${e.title}" permanently? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await api.delete(`/global-kb/entries/${e.id}`);
      setSelected((s) => (s?.id === e.id ? null : s));
      await load();
    } catch (err) {
      setLoadError((err as ApiError).message ?? 'Delete failed');
    } finally {
      setBusy(false);
    }
  }

  async function runEnrich() {
    if (!enrich.notes.trim()) {
      setEnrichError('Write something for the AI to work from.');
      return;
    }
    if (!enrich.repoId || !enrich.cliProviderId) {
      setEnrichError('Pick a repository and a CLI.');
      return;
    }
    setEnrichBusy(true);
    setEnrichError(null);
    try {
      await api.post('/global-kb/enrich', {
        seedText: enrich.notes,
        repositoryId: enrich.repoId,
        cliProviderId: enrich.cliProviderId,
        egress: {
          mode: enrich.egressMode,
          ...(enrich.egressMode === 'allowlist'
            ? { domains: parseList(enrich.egressDomains) }
            : {}),
        },
      });
      setEnrich({ ...enrich, notes: '' });
      await load();
    } catch (err) {
      setEnrichError((err as ApiError).message ?? 'Enrichment failed to start');
    } finally {
      setEnrichBusy(false);
    }
  }

  const rows = entries ?? [];
  const pageCount = Math.max(1, Math.ceil(total / PER_PAGE));
  const filtersActive =
    debouncedQ !== '' ||
    statusFilter !== 'all' ||
    categoryFilter !== 'all' ||
    frameworkFilter !== 'all';

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold text-neutral-50">Global KB</h2>
        <p className="text-sm text-neutral-400">
          House standards and reusable, stack-scoped know-how shared across every repository. Tasks
          retrieve active entries via rag_search, version-scoped by the facets below.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Connection</CardTitle>
          <CardDescription>
            Where the global KB lives and how it embeds — this is the second, instance-wide DB
            (separate from each repo&apos;s RAG DB set during onboarding). Internal = a dedicated DB
            on this Haive host; external = a central/remote Postgres shared across machines. Set an
            embedding model or retrieval falls back to weak hash embeddings.
          </CardDescription>
        </CardHeader>
        <div className="flex flex-col gap-3">
          <label className="flex items-center gap-2 text-sm text-neutral-100">
            <input
              type="checkbox"
              checked={cfg.enabled}
              onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })}
              className="h-4 w-4 rounded border-neutral-700 bg-neutral-950"
            />
            Enabled (tasks retrieve global entries)
          </label>
          <div className="flex flex-wrap gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cfg-mode">Provider</Label>
              <select
                id="cfg-mode"
                value={cfg.mode}
                onChange={(e) =>
                  setCfg({ ...cfg, mode: e.target.value as 'internal' | 'external' })
                }
                className="h-10 rounded-md border border-neutral-800 bg-neutral-950 px-3 text-sm text-neutral-100"
              >
                <option value="internal">internal (Haive-hosted)</option>
                <option value="external">external (central/remote)</option>
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cfg-namespace">Namespace</Label>
              <Input
                id="cfg-namespace"
                value={cfg.namespace}
                onChange={(e) => setCfg({ ...cfg, namespace: e.target.value })}
                className="w-40"
              />
            </div>
          </div>
          {cfg.mode === 'external' && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cfg-conn">
                External connection string{cfgSet ? ' (set — leave blank to keep)' : ''}
              </Label>
              <Input
                id="cfg-conn"
                type="password"
                value={cfg.connectionString}
                onChange={(e) => setCfg({ ...cfg, connectionString: e.target.value })}
                placeholder="postgres://user:pass@host:5432/db"
              />
            </div>
          )}
          <div className="flex items-center gap-3">
            <Button
              variant="secondary"
              size="sm"
              disabled={dbTest.busy}
              onClick={() => void testDb()}
            >
              {dbTest.busy ? 'Testing…' : 'Test DB connection'}
            </Button>
            {dbTest.msg && (
              <span className={`text-xs ${dbTest.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                {dbTest.msg}
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cfg-ollama-mode">Ollama server</Label>
              <select
                id="cfg-ollama-mode"
                value={cfg.ollamaMode}
                onChange={(e) => {
                  const ollamaMode = e.target.value as 'internal' | 'external';
                  setCfg((p) => ({
                    ...p,
                    ollamaMode,
                    // Prefill the host default when leaving internal, but keep an
                    // already-configured external URL untouched.
                    ollamaUrl:
                      ollamaMode === 'external' && deriveOllamaMode(p.ollamaUrl) === 'internal'
                        ? DEFAULT_EXTERNAL_OLLAMA_URL
                        : p.ollamaUrl,
                  }));
                }}
                className="h-10 rounded-md border border-neutral-800 bg-neutral-950 px-3 text-sm text-neutral-100"
              >
                <option value="internal">Use Haive internal Ollama service</option>
                <option value="external">Use an external Ollama server</option>
              </select>
            </div>
            {cfg.ollamaMode === 'external' && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cfg-ollama">External Ollama URL</Label>
                <Input
                  id="cfg-ollama"
                  value={cfg.ollamaUrl}
                  onChange={(e) => setCfg({ ...cfg, ollamaUrl: e.target.value })}
                  placeholder="http://host.docker.internal:11434"
                />
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cfg-model">Embedding model</Label>
              <Input
                id="cfg-model"
                value={cfg.embedModel}
                onChange={(e) => setCfg({ ...cfg, embedModel: e.target.value })}
                placeholder="qwen3-embedding:4b"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cfg-dims">Dimensions</Label>
              <Input
                id="cfg-dims"
                type="number"
                value={cfg.embedDimensions}
                onChange={(e) =>
                  setCfg({ ...cfg, embedDimensions: Number(e.target.value) || 2560 })
                }
                className="w-32"
              />
            </div>
          </div>
          {cfg.ollamaMode === 'internal' && (
            <p className="text-xs text-neutral-500">
              Internal mode uses {INTERNAL_OLLAMA_URL} automatically.
            </p>
          )}
          <div className="flex items-center gap-3">
            <Button
              variant="secondary"
              size="sm"
              disabled={ollamaTest.busy}
              onClick={() => void testOllama()}
            >
              {ollamaTest.busy ? 'Testing…' : 'Test Ollama'}
            </Button>
            {ollamaTest.msg && (
              <span className={`text-xs ${ollamaTest.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                {ollamaTest.msg}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <Button disabled={cfgBusy} onClick={() => void saveConfig()}>
              {cfgBusy ? 'Saving…' : 'Save connection'}
            </Button>
            {cfgMsg && <span className="text-xs text-neutral-400">{cfgMsg}</span>}
          </div>
          <p className="text-xs text-neutral-500">
            Changing the embedding model/dimensions changes the vector space — re-activate entries
            to re-embed them.
          </p>
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Add a house rule</CardTitle>
          <CardDescription>
            Write a rule — generic or detailed; name modules, paste URLs. Pick a repository so the
            AI can read its stack and extract the right framework + major versions. It derives the
            title, category and facets itself and files the entry automatically — as a new one, or
            an update of a matching rule already in the KB.
          </CardDescription>
        </CardHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="enrich-notes">House rules / notes</Label>
            <textarea
              id="enrich-notes"
              value={enrich.notes}
              onChange={(e) => setEnrich({ ...enrich, notes: e.target.value })}
              rows={6}
              placeholder="Write anything — rules, module names, optional URLs. The AI extracts the rest."
              className="w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-sm text-neutral-100 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
            />
          </div>
          <div className="flex flex-wrap gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="enrich-cli">CLI</Label>
              <select
                id="enrich-cli"
                value={enrich.cliProviderId}
                onChange={(e) => setEnrich({ ...enrich, cliProviderId: e.target.value })}
                className="h-10 rounded-md border border-neutral-800 bg-neutral-950 px-3 text-sm text-neutral-100"
              >
                <option value="">Select…</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label || p.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="enrich-egress">Web access</Label>
              <select
                id="enrich-egress"
                value={enrich.egressMode}
                onChange={(e) =>
                  setEnrich({
                    ...enrich,
                    egressMode: e.target.value as 'none' | 'allowlist' | 'full',
                  })
                }
                className="h-10 rounded-md border border-neutral-800 bg-neutral-950 px-3 text-sm text-neutral-100"
              >
                <option value="none">repo only (no web)</option>
                <option value="allowlist">specific domains</option>
                <option value="full">full internet</option>
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="enrich-repo">Repository</Label>
              <select
                id="enrich-repo"
                value={enrich.repoId}
                onChange={(e) => setEnrich({ ...enrich, repoId: e.target.value })}
                className="h-10 rounded-md border border-neutral-800 bg-neutral-950 px-3 text-sm text-neutral-100"
              >
                <option value="">Select…</option>
                {repos.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {enrich.egressMode === 'allowlist' && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="enrich-egress-domains">Allowed domains</Label>
              <Input
                id="enrich-egress-domains"
                value={enrich.egressDomains}
                onChange={(e) => setEnrich({ ...enrich, egressDomains: e.target.value })}
                placeholder="comma-separated, e.g. drupal.org, api.drupal.org"
              />
            </div>
          )}
          <FormError message={enrichError} />
          <div>
            <Button disabled={enrichBusy} onClick={() => void runEnrich()}>
              {enrichBusy ? 'Starting…' : 'Add with AI'}
            </Button>
          </div>
          <p className="text-xs text-neutral-500">
            A background task reads the repo and files the entry (active when done). It appears
            below; refresh to see updates.
          </p>
        </div>
      </Card>

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="mr-auto text-sm font-semibold text-neutral-200">
            Entries{entries ? ` (${total})` : ''}
          </h3>
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search title + body…"
            className="w-56"
          />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="h-10 rounded-md border border-neutral-800 bg-neutral-950 px-3 text-sm text-neutral-100"
          >
            <option value="all">any status</option>
            <option value="active">active</option>
            <option value="draft">draft</option>
            <option value="enriching">enriching</option>
          </select>
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="h-10 rounded-md border border-neutral-800 bg-neutral-950 px-3 text-sm text-neutral-100"
          >
            <option value="all">any category</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
          {frameworks.length > 0 && (
            <select
              value={frameworkFilter}
              onChange={(e) => setFrameworkFilter(e.target.value)}
              className="h-10 rounded-md border border-neutral-800 bg-neutral-950 px-3 text-sm text-neutral-100"
            >
              <option value="all">any stack</option>
              {frameworks.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          )}
        </div>
        <p className="text-xs text-neutral-500">
          AI-added rules activate automatically. <span className="text-neutral-300">Activate</span>{' '}
          publishes a pending auto-promoted draft into retrieval;{' '}
          <span className="text-neutral-300">Delete</span> permanently removes a rule.
        </p>
      </div>

      <FormError message={loadError} />

      {entries === null ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-neutral-500">
          {filtersActive ? 'No entries match the filters.' : 'No entries yet.'}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((e) => {
            const enriching = e.status === 'enriching' || e.status === 'skeleton';
            return (
              <Card
                key={e.id}
                className={
                  enriching
                    ? 'p-4'
                    : 'cursor-pointer p-4 transition-colors hover:border-neutral-700'
                }
                onClick={enriching ? undefined : () => setSelected(e)}
                role={enriching ? undefined : 'button'}
                tabIndex={enriching ? undefined : 0}
                onKeyDown={
                  enriching
                    ? undefined
                    : (ev) => {
                        if (ev.key === 'Enter' || ev.key === ' ') {
                          ev.preventDefault();
                          setSelected(e);
                        }
                      }
                }
              >
                <div className="flex flex-col gap-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-neutral-50">{e.title}</span>
                    {enriching ? (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-sky-500/15 px-2 py-0.5 text-xs font-medium text-sky-300">
                        <span className="h-3 w-3 animate-spin rounded-full border-2 border-sky-400/40 border-t-sky-300" />
                        {e.status === 'skeleton' ? 'queued' : 'enriching'}
                      </span>
                    ) : (
                      <Badge variant={STATUS_VARIANT[e.status] ?? 'default'}>{e.status}</Badge>
                    )}
                    <Badge variant="default">{e.category.replace(/_/g, ' ')}</Badge>
                    {e.source === 'promoted' && <Badge variant="info">promoted</Badge>}
                    {e.status === 'active' && e.embedStatus !== 'embedded' && (
                      <Badge variant={e.embedStatus === 'failed' ? 'error' : 'default'}>
                        {e.embedStatus}
                      </Badge>
                    )}
                    {!enriching && (
                      <div className="ml-auto flex items-center gap-2">
                        {e.status === 'draft' && (
                          <Button
                            size="sm"
                            disabled={busy}
                            onClick={(ev) => {
                              ev.stopPropagation();
                              void activate(e);
                            }}
                          >
                            Activate
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={busy}
                          onClick={(ev) => {
                            ev.stopPropagation();
                            void remove(e);
                          }}
                        >
                          Delete
                        </Button>
                      </div>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <p className="text-xs text-neutral-400">{facetsSummary(e.facets)}</p>
                    {e.sourceTaskId && (
                      <a
                        href={`/tasks/${e.sourceTaskId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(ev) => ev.stopPropagation()}
                        className="text-xs font-medium text-indigo-400 hover:text-indigo-300"
                      >
                        {enriching ? 'Watch task ↗' : 'View task ↗'}
                      </a>
                    )}
                    {enriching && (
                      <span className="text-xs text-neutral-500">
                        Reading the repo in the background — activates automatically when done.
                      </span>
                    )}
                  </div>
                </div>
              </Card>
            );
          })}
          {pageCount > 1 && (
            <div className="flex items-center justify-center gap-3 pt-1">
              <Button
                size="sm"
                variant="ghost"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Prev
              </Button>
              <span className="text-xs text-neutral-500">
                page {page} of {pageCount}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={page >= pageCount}
                onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
              >
                Next
              </Button>
            </div>
          )}
        </div>
      )}

      <Dialog
        open={!!selected}
        onOpenChange={(o) => !o && setSelected(null)}
        className="w-[95vw] max-w-6xl"
      >
        <DialogContent className="flex max-h-[90vh] flex-col">
          {selected && (
            <>
              <DialogHeader className="mb-3 flex-row items-start justify-between gap-4">
                <DialogTitle>{selected.title}</DialogTitle>
                <button
                  type="button"
                  onClick={() => setSelected(null)}
                  aria-label="Close"
                  className="-mr-1 -mt-1 shrink-0 rounded-md px-2 text-2xl leading-none text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
                >
                  ×
                </button>
              </DialogHeader>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={STATUS_VARIANT[selected.status] ?? 'default'}>
                  {selected.status}
                </Badge>
                <Badge variant="default">{selected.category.replace(/_/g, ' ')}</Badge>
                {selected.source === 'promoted' && <Badge variant="info">promoted</Badge>}
                {selected.sourceTaskId && (
                  <a
                    href={`/tasks/${selected.sourceTaskId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs font-medium text-indigo-400 hover:text-indigo-300"
                  >
                    View task ↗
                  </a>
                )}
              </div>
              <p className="mt-2 text-xs text-neutral-400">{facetsSummary(selected.facets)}</p>
              <div className="mt-3 min-h-0 flex-1 overflow-hidden rounded-md border border-neutral-800">
                <MarkdownView body={selected.body} className="max-h-full" />
              </div>
              <div className="mt-4 flex items-center justify-center gap-3">
                {selected.status === 'draft' && (
                  <Button size="sm" disabled={busy} onClick={() => void activate(selected)}>
                    Activate
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => void remove(selected)}
                >
                  Delete
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
