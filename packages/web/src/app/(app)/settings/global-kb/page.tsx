'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type SyntheticEvent } from 'react';
import { diffLines } from 'diff';
import {
  api,
  GLOBAL_KB_DESCRIPTION_MAX,
  GLOBAL_KB_FACET_DIMENSIONS,
  facetScopeError,
  releaseGlobalKbEmbedModel,
  type ApiError,
  type CliProvider,
  type GlobalKbEnforceSpec,
  type GlobalKbEnforcementState,
  type GlobalKbEntry,
  type GlobalKbFacets,
  type Repository,
} from '@/lib/api-client';
import { usePageTitle } from '@/lib/use-page-title';
import {
  carriesLiveApproval,
  describeEnforceSpec,
  draftEnforceSpec,
  enforcementOffers,
  globsFromLines,
  houseRuleBadge,
} from '@/lib/house-rules';
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
import { HighlightedSource } from '@/components/task-source';
import { InlineMarkdown } from '@/components/markdown/inline-markdown';
import { MarkdownView } from '@/components/markdown/markdown-view';
import { MarkdownEditor } from '@/components/markdown/markdown-editor';
import { looksLikeMarkdown } from '@/components/markdown/looks-like-markdown';
import { IN_STACK_OLLAMA_URL, DEFAULT_EXTERNAL_OLLAMA_URL } from '@haive/shared/constants';
import { collapseToLine } from '@haive/shared/collapse-line';
import { houseRuleShortIds, renderHouseRuleEntry } from '@haive/shared/house-rule-render';

function parseList(s: string): string[] {
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Comma-separated text per dimension — the `parseList` shape already used for egress domains,
 *  rather than a tag component web does not have. An EMPTY dimension is dropped, not stored as
 *  `[]`: naming a dimension restricts the entry to it, so "no opinion" has to be absence. */
function facetsFromFields(fields: Record<string, string>): GlobalKbFacets {
  const out: GlobalKbFacets = {};
  for (const { key } of GLOBAL_KB_FACET_DIMENSIONS) {
    const values = parseList(fields[key] ?? '');
    if (values.length > 0) out[key] = values;
  }
  return out;
}

function fieldsFromFacets(f: GlobalKbFacets): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key } of GLOBAL_KB_FACET_DIMENSIONS) out[key] = (f[key] ?? []).join(', ');
  return out;
}

/** The one scope editor, used by the enrich form and by the entry detail modal. Two surfaces
 *  that disagreed about the dimensions would let a scope be set that the other cannot show. */
function FacetFields({
  idPrefix,
  fields,
  onChange,
  disabled,
}: {
  idPrefix: string;
  fields: Record<string, string>;
  onChange: (key: string, value: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {GLOBAL_KB_FACET_DIMENSIONS.map((dim) => (
        <div key={dim.key} className="flex flex-col gap-1">
          <Label htmlFor={`${idPrefix}-${dim.key}`} className="text-[11px] text-neutral-500">
            {dim.label}
          </Label>
          <Input
            id={`${idPrefix}-${dim.key}`}
            value={fields[dim.key] ?? ''}
            placeholder={dim.placeholder}
            disabled={disabled}
            onChange={(e) => onChange(dim.key, e.target.value)}
          />
        </div>
      ))}
    </div>
  );
}

/** Measure the same collapsed line as the API. Keep the full input so excess text can be
 * corrected rather than silently discarded by the browser's raw-string maxLength. */
function DescriptionField({
  id,
  value,
  onChange,
  disabled,
  placeholder,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const length = collapseToLine(value).length;
  return (
    <div className="flex flex-col gap-1">
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        aria-describedby={`${id}-limit`}
        aria-invalid={length > GLOBAL_KB_DESCRIPTION_MAX}
        onChange={(e) => onChange(e.target.value)}
      />
      <span
        id={`${id}-limit`}
        className={`self-end text-[11px] ${length > GLOBAL_KB_DESCRIPTION_MAX ? 'text-red-400' : 'text-neutral-500'}`}
      >
        {length} / {GLOBAL_KB_DESCRIPTION_MAX}
      </span>
      <FormError
        message={
          length > GLOBAL_KB_DESCRIPTION_MAX
            ? `Description must be at most ${GLOBAL_KB_DESCRIPTION_MAX} characters after whitespace is collapsed.`
            : null
        }
      />
    </div>
  );
}

/** A click or Enter on a link in a description follows the link, and is not taken for a click on
 *  the card around it. */
function stopAtLinks(ev: SyntheticEvent) {
  if (ev.target instanceof Element && ev.target.closest('a')) ev.stopPropagation();
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
  failed: 'error',
};

function HouseRuleBadge({ state }: { state: GlobalKbEnforcementState | undefined }) {
  const badge = houseRuleBadge(state);
  return badge ? <Badge variant={badge.variant}>{badge.label}</Badge> : null;
}

interface GlobalKbConfig {
  enabled: boolean;
  digestEnabled: boolean;
  mode: 'internal' | 'external';
  namespace: string;
  ollamaUrl: string;
  embedModel: string;
  embedDimensions: number;
  archiveRetentionDays: number;
  connectionStringSet: boolean;
  canEnforce: boolean;
  houseRulesEnabled: boolean;
}

/** GET /global-kb/entries/:id: the entry plus what the always-on meter needs. */
interface EntryDetail {
  entry: GlobalKbEntry;
  activeSuccessor: { id: string; title: string } | null;
  usedBytes: number;
  capBytes: number;
  entryBytes: number;
}

/** The enforce panel: a snapshot of the entry as read, so the approval names exactly that text. */
interface EnforcePanel {
  entry: GlobalKbEntry;
  usedBytes: number;
  capBytes: number;
  entryBytes: number;
  mode: 'always' | 'files';
  globs: string;
  busy: boolean;
  error: string | null;
  stale: boolean;
}

const DEFAULT_EMBED_MODEL = 'qwen3-embedding:4b';

/** A saved ollamaUrl maps back to a mode: the bundled URL (or empty) is internal,
 *  anything else is an external server the user pointed at. */
function deriveOllamaMode(url: string): 'internal' | 'external' {
  return url && url !== IN_STACK_OLLAMA_URL ? 'external' : 'internal';
}

const CATEGORIES: GlobalKbEntry['category'][] = [
  'general',
  'tech_pattern',
  'anti_pattern',
  'best_practice',
  'quick_reference',
];
const PER_PAGE = 12;

/** Per-line diff of an update-draft against the article it supersedes, so the
 *  reviewer sees what changed before approving. baseline = existing article body,
 *  current = draft body. */
function GlobalKbDiff({ baseline, current }: { baseline: string; current: string }) {
  const { lines, added, removed } = useMemo(() => {
    const parts = diffLines(baseline, current);
    let a = 0;
    let r = 0;
    const out: { kind: 'add' | 'remove' | 'context'; text: string }[] = [];
    for (const part of parts) {
      const partLines = part.value.split('\n');
      // diffLines emits a trailing '' when a segment ends with \n; drop it.
      if (partLines.length > 0 && partLines[partLines.length - 1] === '') partLines.pop();
      const kind: 'add' | 'remove' | 'context' = part.added
        ? 'add'
        : part.removed
          ? 'remove'
          : 'context';
      for (const text of partLines) {
        out.push({ kind, text });
        if (kind === 'add') a += 1;
        else if (kind === 'remove') r += 1;
      }
    }
    return { lines: out, added: a, removed: r };
  }, [baseline, current]);

  return (
    // w-max sizes this block to the widest line so each line's background spans
    // the whole horizontal scroll extent (min-w-full keeps it at least the
    // visible width); otherwise the add/remove tint clips at the right edge when
    // a line overflows. Mirrors CommitDiffViewer.InlineDiff.
    <div className="w-max min-w-full font-mono text-[11px] leading-tight">
      <div className="sticky top-0 z-10 min-w-full border-b border-neutral-800 bg-neutral-950 px-2 py-1 text-neutral-500">
        <span className="text-green-400">+{added}</span>{' '}
        <span className="text-red-400">-{removed}</span> vs the existing article
      </div>
      {lines.length === 0 ? (
        <div className="min-w-full px-2 py-1 text-neutral-500">No content changes.</div>
      ) : (
        // pb-3 keeps the last line clear of the overlay horizontal scrollbar.
        <div className="pb-3">
          {lines.map((line, i) => {
            const cls =
              line.kind === 'add'
                ? 'bg-green-950/60 text-green-200'
                : line.kind === 'remove'
                  ? 'bg-red-950/60 text-red-200'
                  : 'text-neutral-500';
            const prefix = line.kind === 'add' ? '+ ' : line.kind === 'remove' ? '- ' : '  ';
            return (
              <div key={i} className={`min-w-full whitespace-pre px-2 ${cls}`}>
                {prefix}
                {line.text}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function GlobalKbPage() {
  usePageTitle('Global KB');
  const [entries, setEntries] = useState<GlobalKbEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  // Set from the completed-task "review drafts" CTA (?sourceTaskId=) to scope the
  // list to one task's promoted drafts; null = unscoped.
  const [sourceTaskId, setSourceTaskId] = useState<string | null>(null);
  const [frameworkFilter, setFrameworkFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [debouncedQ, setDebouncedQ] = useState('');
  const [total, setTotal] = useState(0);
  const [frameworks, setFrameworks] = useState<string[]>([]);
  const [selected, setSelected] = useState<GlobalKbEntry | null>(null);
  // For an update-draft (supersedesEntryId set): the existing article it replaces,
  // fetched on open so the modal can diff the draft against it.
  const [supersededEntry, setSupersededEntry] = useState<{
    title: string;
    body: string;
    description: string | null;
    enforce: GlobalKbEnforceSpec | null;
    enforcementState: GlobalKbEnforcementState | undefined;
    carriesApproval: boolean;
  } | null>(null);
  const [draftView, setDraftView] = useState<'diff' | 'full'>('diff');
  const [repos, setRepos] = useState<Repository[]>([]);
  const [providers, setProviders] = useState<CliProvider[]>([]);
  const [enrich, setEnrich] = useState({
    title: '',
    description: '',
    notes: '',
    repoId: '',
    cliProviderId: '',
    egressMode: 'none' as 'none' | 'allowlist' | 'full',
    egressDomains: '',
  });
  // Scope the author is sure of. Blank means "let the model decide", which is what an omitted
  // dimension already means to retrieval.
  const [enrichFacets, setEnrichFacets] = useState<Record<string, string>>({});
  // Scope editor for an entry that already exists. Null = not editing; the entry's own facets
  // are loaded into it on open so a correction starts from what is stored.
  const [scopeEdit, setScopeEdit] = useState<Record<string, string> | null>(null);
  const [scopeBusy, setScopeBusy] = useState(false);
  const [scopeError, setScopeError] = useState<string | null>(null);
  // The same for the description: null = not editing, and the entry's own text is loaded on open.
  const [descEdit, setDescEdit] = useState<string | null>(null);
  const [descBusy, setDescBusy] = useState(false);
  const [descError, setDescError] = useState<string | null>(null);
  const [bodyEdit, setBodyEdit] = useState<string | null>(null);
  const [bodyBusy, setBodyBusy] = useState(false);
  const [bodyError, setBodyError] = useState<string | null>(null);
  const [enforcePanel, setEnforcePanel] = useState<EnforcePanel | null>(null);
  // Failures of Activate, Archive, Delete and the enforcement buttons, shown in the dialog: the
  // page-level banner sits behind the overlay.
  const [dialogError, setDialogError] = useState<string | null>(null);
  const selectedIdRef = useRef<string | undefined>(undefined);
  selectedIdRef.current = selected?.id;
  // Drop a half-finished edit whenever the modal moves to another entry or
  // closes. Keyed on the entry id and not wired into each close path on purpose: the dialog closes
  // on Escape, on the backdrop and on the X as well as on Cancel, and a leftover editor would show
  // the PREVIOUS entry's values and write them over this one on Save.
  useEffect(() => {
    setScopeEdit(null);
    setScopeError(null);
    setDescEdit(null);
    setDescError(null);
    setBodyEdit(null);
    setBodyError(null);
    setEnforcePanel(null);
    setDialogError(null);
  }, [selected?.id]);
  // The LIVE entry that replaced this one, asked of the SERVER rather than read out of
  // `entries`. That list is filtered and paginated, so a reviewer who filtered to `archived`
  // never has the active successor in hand — and a warning derived from a view is one that
  // silently disappears exactly when the view narrows, which is the case it exists for.
  const [activeSuccessor, setActiveSuccessor] = useState<{ id: string; title: string } | null>(
    null,
  );
  // `activeSuccessor === null` alone cannot gate the button, because THREE different states
  // produce it: the lookup is still in flight, the lookup failed, and there genuinely is no
  // successor. Reactivation was live throughout the first of those, so a quick reviewer could
  // reactivate before the warning had any chance to render and leave both entries retrievable
  // for the same scope. Only the in-flight state blocks; a FAILED lookup re-enables the button
  // with no warning, which keeps the fail-quiet rule below intact rather than turning an
  // advisory check into a hard block on a request that may never succeed.
  const [successorLoading, setSuccessorLoading] = useState(false);
  useEffect(() => {
    setActiveSuccessor(null);
    setSuccessorLoading(false);
    if (!selected || selected.status !== 'archived') return;
    let cancelled = false;
    setSuccessorLoading(true);
    void api
      .get<{ activeSuccessor: { id: string; title: string } | null }>(
        `/global-kb/entries/${selected.id}`,
      )
      .then((res) => {
        if (!cancelled) setActiveSuccessor(res.activeSuccessor ?? null);
      })
      // Fail QUIET, not loud: the warning is advisory, and a failed lookup must not block the
      // reviewer from opening an entry. It errs toward not warning, which is why the detail
      // view is also the only place reactivation can happen at all.
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setSuccessorLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected?.id, selected?.status]);
  const [enrichBusy, setEnrichBusy] = useState(false);
  const [enrichError, setEnrichError] = useState<string | null>(null);
  // Arriving from the onboarding step-04 link (?repo=&cli=) pre-fills the repo +
  // CLI so the user does not re-pick what the task already knows. Once, on mount.
  const prefilledEnrich = useRef(false);
  // Flipped once that pass has consumed the URL params. The mirror effect below
  // waits for it: on the first commit the filter state is still at its defaults,
  // so an ungated mirror would strip the very params this pass has not read yet.
  const [paramsRead, setParamsRead] = useState(false);
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
    // Arriving via the onboarding "review drafts" link (?status=draft) → pre-filter
    // the list to the bucket the caller wants.
    const status = params.get('status');
    if (status && ['active', 'draft', 'enriching', 'archived', 'failed'].includes(status)) {
      setStatusFilter(status);
    }
    // Arriving from a completed task's "review drafts" CTA (?sourceTaskId=) → scope
    // the list to the drafts that task promoted.
    const taskId = params.get('sourceTaskId');
    if (taskId) setSourceTaskId(taskId);
    // Arriving via the onboarding "Add Global House KB" button (#add) → scroll to
    // the authoring card once the page has laid out.
    if (window.location.hash === '#add') {
      setTimeout(() => {
        document.getElementById('add-house-rule')?.scrollIntoView({ behavior: 'smooth' });
      }, 150);
    }
    setParamsRead(true);
  }, []);

  // Mirror the filters the mount read consumes back into the URL, so the address
  // bar and the controls cannot disagree: changing the status dropdown or hitting
  // "Clear task filter" left `?status=draft&sourceTaskId=` behind, and a reload
  // then re-applied the filter the user had just cleared. Only those two keys are
  // mirrored — exactly the set a reload restores — and the rest of the URL
  // (?repo=/?cli= for the enrich form, #add) is carried through untouched.
  // replaceState, not a push: filtering a list is not a history trail, and a push
  // per keystroke would make Back mean "undo one filter" instead of "leave".
  useEffect(() => {
    if (!paramsRead) return;
    const url = new URL(window.location.href);
    if (statusFilter !== 'all') url.searchParams.set('status', statusFilter);
    else url.searchParams.delete('status');
    if (sourceTaskId) url.searchParams.set('sourceTaskId', sourceTaskId);
    else url.searchParams.delete('sourceTaskId');
    if (url.href !== window.location.href) window.history.replaceState(null, '', url);
  }, [paramsRead, statusFilter, sourceTaskId]);

  // Leaving the Global KB page is a strong "done managing the KB" signal: ask the
  // API to release the embedding model from the GPU. The endpoint self-gates (only
  // evicts when the model is resident and no live task / in-flight sync needs it),
  // so this fires unconditionally — on SPA navigation away (cleanup) and on tab or
  // window close (pagehide). Best-effort; the worker-boot reconciler is the backstop.
  useEffect(() => {
    let fired = false;
    const release = () => {
      if (fired) return;
      fired = true;
      releaseGlobalKbEmbedModel();
    };
    window.addEventListener('pagehide', release);
    return () => {
      window.removeEventListener('pagehide', release);
      release();
    };
  }, []);
  const [cfg, setCfg] = useState({
    enabled: true,
    digestEnabled: true,
    mode: 'internal' as 'internal' | 'external',
    namespace: 'default',
    ollamaMode: 'internal' as 'internal' | 'external',
    ollamaUrl: '',
    embedModel: DEFAULT_EMBED_MODEL,
    embedDimensions: 2560,
    archiveRetentionDays: 30,
    connectionString: '',
  });
  const [cfgSet, setCfgSet] = useState(false);
  const [canEnforce, setCanEnforce] = useState(false);
  const [instanceNamespace, setInstanceNamespace] = useState<string | null>(null);
  const [houseRulesOn, setHouseRulesOn] = useState(true);
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
  const [cfgLoaded, setCfgLoaded] = useState(false);
  const [connExpanded, setConnExpanded] = useState(false);
  const connChecked = useRef(false);

  async function loadConfig() {
    try {
      const cc = await api.get<GlobalKbConfig>('/global-kb/config');
      setCfg((p) => ({
        ...p,
        enabled: cc.enabled,
        digestEnabled: cc.digestEnabled,
        mode: cc.mode,
        namespace: cc.namespace,
        ollamaMode: deriveOllamaMode(cc.ollamaUrl),
        ollamaUrl: cc.ollamaUrl,
        embedModel: cc.embedModel,
        embedDimensions: cc.embedDimensions,
        archiveRetentionDays: cc.archiveRetentionDays,
        connectionString: '',
      }));
      setCfgSet(cc.connectionStringSet);
      setCanEnforce(cc.canEnforce === true);
      setInstanceNamespace(cc.namespace);
      setHouseRulesOn(cc.houseRulesEnabled !== false);
      setCfgLoaded(true);
    } catch {
      /* unavailable: the card shows its defaults */
    }
  }

  // Internal mode has no URL field; collapse the mode back to a concrete URL
  // (mirrors onboarding 04's apply) for both save and the Ollama test.
  const effectiveOllamaUrl =
    cfg.ollamaMode === 'internal'
      ? IN_STACK_OLLAMA_URL
      : cfg.ollamaUrl.trim() || DEFAULT_EXTERNAL_OLLAMA_URL;
  // The database test is admin-only, so for anyone else the database is simply not checked.
  const connOk = cfg.enabled && (!canEnforce || dbTest.ok === true) && ollamaTest.ok === true;
  // Null until the first-load check resolves; keeps the collapsed header from
  // flashing a misleading "needs attention" while the test round-trips run.
  const connChecking = (canEnforce && dbTest.ok === null) || ollamaTest.ok === null;

  // The card starts collapsed — the connection rarely changes once set up, so it
  // stays out of the way. On first load we validate and auto-expand — with the
  // failures shown inline — only when it needs attention.
  useEffect(() => {
    if (!cfgLoaded || connChecked.current) return;
    connChecked.current = true;
    void (async () => {
      const fail = (e: unknown) => ({
        ok: false,
        message: (e as ApiError).message ?? 'Test failed',
      });
      const [dbR, olR] = await Promise.all([
        canEnforce
          ? api
              .post<{ ok: boolean; message: string }>('/global-kb/test-db', {
                mode: cfg.mode,
                connectionString: cfg.connectionString.trim() || undefined,
              })
              .catch(fail)
          : Promise.resolve(null),
        api
          .post<{ ok: boolean; message: string }>('/global-kb/test-ollama', {
            ollamaUrl: effectiveOllamaUrl,
            model: cfg.embedModel,
            dimensions: cfg.embedDimensions,
          })
          .catch(fail),
      ]);
      if (dbR) setDbTest({ busy: false, ok: dbR.ok, msg: dbR.message });
      setOllamaTest({ busy: false, ok: olR.ok, msg: olR.message });
      setConnExpanded(!(cfg.enabled && (dbR === null || dbR.ok) && olR.ok));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfgLoaded]);

  async function saveConfig() {
    if (!cfg.namespace.trim() || cfg.namespace.length > 120) {
      setCfgMsg('Namespace must contain 1–120 characters.');
      return;
    }
    if (
      !Number.isInteger(cfg.embedDimensions) ||
      cfg.embedDimensions < 1 ||
      cfg.embedDimensions > 8192
    ) {
      setCfgMsg('Dimensions must be a whole number from 1 to 8192.');
      return;
    }
    if (
      !Number.isInteger(cfg.archiveRetentionDays) ||
      cfg.archiveRetentionDays < 0 ||
      cfg.archiveRetentionDays > 3650
    ) {
      setCfgMsg('Archive retention must be a whole number from 0 to 3650 days.');
      return;
    }
    setCfgBusy(true);
    setCfgMsg(null);
    try {
      const payload: Record<string, unknown> = {
        enabled: cfg.enabled,
        digestEnabled: cfg.digestEnabled,
        mode: cfg.mode,
        namespace: cfg.namespace,
        ollamaUrl: effectiveOllamaUrl,
        embedModel: cfg.embedModel,
        embedDimensions: cfg.embedDimensions,
        archiveRetentionDays: cfg.archiveRetentionDays,
      };
      if (cfg.connectionString.trim()) payload.connectionString = cfg.connectionString.trim();
      await api.put('/global-kb/config', payload);
      await loadConfig();
      await load();
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
  // A monotonic sequence guards against out-of-order responses: on mount the
  // initial unfiltered fetch and the URL-driven (?status=draft) fetch race, and
  // without this the slower unfiltered response can land last and overwrite the
  // filtered one — leaving the list showing everything while the dropdown shows
  // the filter. Only the most recent request is allowed to apply its result.
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('pageSize', String(PER_PAGE));
      if (debouncedQ) params.set('q', debouncedQ);
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (categoryFilter !== 'all') params.set('category', categoryFilter);
      if (frameworkFilter !== 'all') params.set('framework', frameworkFilter);
      if (sourceTaskId) params.set('sourceTaskId', sourceTaskId);
      const res = await api.get<{ entries: GlobalKbEntry[]; total: number; frameworks: string[] }>(
        `/global-kb/entries?${params.toString()}`,
      );
      if (seq !== loadSeq.current) return;
      setEntries(res.entries);
      setTotal(res.total);
      setFrameworks(res.frameworks);
      setLoadError(null);
      // Deleting the last row on the last page can leave us past the end — clamp.
      if (res.entries.length === 0 && page > 1 && res.total > 0) {
        setPage(Math.max(1, Math.ceil(res.total / PER_PAGE)));
      }
    } catch (err) {
      if (seq !== loadSeq.current) return;
      setLoadError((err as ApiError).message ?? 'Failed to load global KB');
    }
  }, [page, debouncedQ, statusFilter, categoryFilter, frameworkFilter, sourceTaskId]);

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
  }, [debouncedQ, statusFilter, categoryFilter, frameworkFilter, sourceTaskId]);

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

  // When an entry that supersedes another is opened, fetch the predecessor so the
  // modal can diff against it. A draft defaults to the diff (the reviewer is deciding
  // whether to approve the change); a non-draft promoted article (active/archived)
  // defaults to its full body, with the diff available as opt-in history. A
  // missing/purged predecessor (404) just falls back to the plain body view.
  useEffect(() => {
    setSupersededEntry(null);
    setDraftView(selected?.status === 'draft' ? 'diff' : 'full');
    const supersedesId = selected?.supersedesEntryId;
    if (!supersedesId) return;
    let cancelled = false;
    void api
      .get<{ entry: GlobalKbEntry }>(`/global-kb/entries/${supersedesId}`)
      .then((r) => {
        if (!cancelled) {
          setSupersededEntry({
            title: r.entry.title,
            body: r.entry.body,
            description: r.entry.description ?? null,
            enforce: r.entry.enforce ?? null,
            enforcementState: r.entry.enforcementState,
            carriesApproval: carriesLiveApproval(r.entry),
          });
        }
      })
      .catch(() => {
        if (!cancelled) setSupersededEntry(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  /** From the dialog the failure shows in the dialog, since the banner under the page is behind
   *  its overlay. */
  function reportError(message: string) {
    if (selected) setDialogError(message);
    else setLoadError(message);
  }

  /** What to ask before activating a draft that replaces an enforced rule, or null when nothing
   *  is lost. A failed lookup asks too: activating archives the predecessor and ends its rule. */
  async function replacedRuleWarning(e: GlobalKbEntry): Promise<string | null> {
    if (!e.supersedesEntryId) return null;
    try {
      const res = await api.get<{ entry: GlobalKbEntry }>(
        `/global-kb/entries/${e.supersedesEntryId}`,
      );
      if (!carriesLiveApproval(res.entry)) return null;
      return `"${e.title}" replaces "${res.entry.title}", which carries an admin's approval as a house rule. Activating archives it and ends that approval; an admin has to enforce the replacement. Activate anyway?`;
    } catch (err) {
      if ((err as ApiError).status === 404) return null;
      return `Could not check whether the entry that "${e.title}" replaces carries an admin's approval as a house rule (${(err as ApiError).message ?? 'lookup failed'}). If it does, activating archives it and ends that approval. Activate anyway?`;
    }
  }

  async function activate(e: GlobalKbEntry) {
    setDialogError(null);
    setBusy(true);
    try {
      const warning = await replacedRuleWarning(e);
      if (warning !== null && !window.confirm(warning)) return;
      await api.patch(`/global-kb/entries/${e.id}`, { status: 'active' });
      setSelected((s) => (s?.id === e.id ? null : s));
      await load();
    } catch (err) {
      reportError((err as ApiError).message ?? 'Activate failed');
    } finally {
      setBusy(false);
    }
  }

  /** Retire an ACTIVE entry without deleting it. Reversible — an archived entry offers Reactivate —
   *  and not a supersession: nothing replaced it, so `supersededAt` stays null. The successor
   *  warning tells a reviewer to do exactly this, and the page had no control to do it with. */
  async function archive(e: GlobalKbEntry) {
    if (
      carriesLiveApproval(e) &&
      !window.confirm(
        `"${e.title}" carries an admin's approval as a house rule. Archiving ends that approval, and reactivating the entry does not bring it back. Archive anyway?`,
      )
    ) {
      return;
    }
    setDialogError(null);
    setBusy(true);
    try {
      await api.patch(`/global-kb/entries/${e.id}`, { status: 'archived' });
      setSelected((s) => (s?.id === e.id ? null : s));
      await load();
    } catch (err) {
      reportError((err as ApiError).message ?? 'Archive failed');
    } finally {
      setBusy(false);
    }
  }

  /** Open an entry by id. Fetched rather than found in `entries`, which is filtered and paginated
   *  — the reason the successor is asked of the server in the first place. */
  async function openEntry(id: string) {
    try {
      const res = await api.get<{ entry: GlobalKbEntry }>(`/global-kb/entries/${id}`);
      setSelected(res.entry);
    } catch (err) {
      reportError((err as ApiError).message ?? 'Could not open that entry');
    }
  }

  /** Bind a stored entry the server just returned to the dialog and the list. */
  function adoptEntry(entry: GlobalKbEntry) {
    setSelected((cur) => (cur && cur.id === entry.id ? entry : cur));
    setEntries((rows) => rows?.map((r) => (r.id === entry.id ? entry : r)) ?? rows);
  }

  function panelFrom(detail: EntryDetail, prefill: GlobalKbEnforceSpec | null): EnforcePanel {
    return {
      entry: detail.entry,
      usedBytes: detail.usedBytes,
      capBytes: detail.capBytes,
      entryBytes: detail.entryBytes,
      mode: prefill?.mode ?? 'files',
      globs: prefill?.mode === 'files' ? prefill.globs.join('\n') : '',
      busy: false,
      error: null,
      stale: false,
    };
  }

  /** Open the panel on the entry as the server holds it NOW, so what the admin reads and the
   *  token they approve it with come from one response. */
  async function openEnforcePanel(prefill: GlobalKbEnforceSpec | null) {
    if (!selected) return;
    const id = selected.id;
    setDialogError(null);
    setBusy(true);
    try {
      const detail = await api.get<EntryDetail>(`/global-kb/entries/${id}`);
      if (selectedIdRef.current !== id) return;
      adoptEntry(detail.entry);
      setEnforcePanel(panelFrom(detail, prefill));
    } catch (err) {
      if (selectedIdRef.current === id) {
        setDialogError((err as ApiError).message ?? 'Could not read the entry');
      }
    } finally {
      setBusy(false);
    }
  }

  async function reloadEnforcePanel() {
    if (!enforcePanel) return;
    const id = enforcePanel.entry.id;
    const keep = enforcePanel;
    setEnforcePanel({ ...keep, busy: true });
    try {
      const detail = await api.get<EntryDetail>(`/global-kb/entries/${id}`);
      if (selectedIdRef.current !== id) return;
      adoptEntry(detail.entry);
      setEnforcePanel({
        ...panelFrom(detail, null),
        mode: keep.mode,
        globs: keep.globs,
      });
    } catch (err) {
      if (selectedIdRef.current === id) {
        setEnforcePanel({
          ...keep,
          busy: false,
          error: (err as ApiError).message ?? 'Could not read the entry',
        });
      }
    }
  }

  async function submitEnforce() {
    if (!enforcePanel) return;
    const panel = enforcePanel;
    const id = panel.entry.id;
    const expectedHash = panel.entry.contentToken ?? '';
    setEnforcePanel({ ...panel, busy: true, error: null, stale: false });
    try {
      const res = await api.put<{ entry: GlobalKbEntry }>(`/global-kb/entries/${id}/enforcement`, {
        ...(panel.mode === 'always'
          ? { mode: 'always' }
          : { mode: 'files', globs: globsFromLines(panel.globs) }),
        expectedHash,
      });
      adoptEntry(res.entry);
      if (selectedIdRef.current === id) setEnforcePanel(null);
    } catch (err) {
      if (selectedIdRef.current !== id) return;
      const failure = err as ApiError;
      const sizes = failure.code === 'always_cap' ? (failure.body as Partial<EnforcePanel>) : {};
      setEnforcePanel({
        ...panel,
        busy: false,
        stale: failure.code === 'token_mismatch',
        usedBytes: sizes.usedBytes ?? panel.usedBytes,
        capBytes: sizes.capBytes ?? panel.capBytes,
        entryBytes: sizes.entryBytes ?? panel.entryBytes,
        error:
          failure.code === 'token_mismatch'
            ? `${failure.message}. Reload the entry to read its current text, then approve it again.`
            : (failure.message ?? 'Enforcing failed'),
      });
    }
  }

  async function unenforce(e: GlobalKbEntry) {
    setDialogError(null);
    setBusy(true);
    try {
      const res = await api.delete<{ entry: GlobalKbEntry }>(
        `/global-kb/entries/${e.id}/enforcement`,
      );
      adoptEntry(res.entry);
    } catch (err) {
      reportError((err as ApiError).message ?? 'Could not remove the enforcement');
    } finally {
      setBusy(false);
    }
  }

  /** Re-scope an entry that is already stored.
   *
   *  The only way to correct a facet short of deleting the article and writing it again — which
   *  is how the first of these ended up stuck at `frameworkMajor: ["7"]`. PATCH replaces the
   *  facets wholesale (it does not merge), which is exactly what an editor showing every
   *  dimension needs. */
  async function saveScope(e: GlobalKbEntry) {
    if (!scopeEdit) return;
    // Said in the form rather than as a failed request: a bare major names no technology, so
    // the api refuses it and the reviewer would otherwise see only a 400.
    const scopeIssue = facetScopeError(facetsFromFields(scopeEdit));
    if (scopeIssue) {
      setScopeError(scopeIssue);
      return;
    }
    setScopeBusy(true);
    setScopeError(null);
    try {
      // Bind to what the server STORED, never to what was typed: facet values are normalised
      // on write (trimmed, lowercased, deduped), so echoing the raw fields would show a scope
      // the entry does not have until the next reload.
      const res = await api.patch<{ entry: GlobalKbEntry }>(`/global-kb/entries/${e.id}`, {
        facets: facetsFromFields(scopeEdit),
      });
      // The WHOLE returned entry, not just its facets: a scope edit can also clear
      // `supersedesEntryId` server-side, and copying one field leaves the modal showing an
      // "Updates existing" diff against a predecessor that activation will no longer archive.
      const saved = res.entry;
      setSelected((cur) => (cur && cur.id === e.id ? saved : cur));
      setEntries((rows) => rows?.map((r) => (r.id === e.id ? saved : r)) ?? rows);
      setScopeEdit(null);
    } catch (err) {
      setScopeError((err as ApiError).message ?? 'Failed to save the scope');
    } finally {
      setScopeBusy(false);
    }
  }

  /** Bound to what the server STORED, not what was typed: it collapses the text to one line and
   *  clears a blank one. */
  async function saveDescription(e: GlobalKbEntry) {
    if (descEdit === null) return;
    if (collapseToLine(descEdit).length > GLOBAL_KB_DESCRIPTION_MAX) {
      setDescError(`Description must be at most ${GLOBAL_KB_DESCRIPTION_MAX} characters.`);
      return;
    }
    setDescBusy(true);
    setDescError(null);
    try {
      const res = await api.patch<{ entry: GlobalKbEntry }>(`/global-kb/entries/${e.id}`, {
        description: descEdit,
      });
      const saved = res.entry;
      setSelected((cur) => (cur && cur.id === e.id ? saved : cur));
      setEntries((rows) => rows?.map((r) => (r.id === e.id ? saved : r)) ?? rows);
      setDescEdit(null);
    } catch (err) {
      setDescError((err as ApiError).message ?? 'Failed to save the description');
    } finally {
      setDescBusy(false);
    }
  }

  async function saveBody(e: GlobalKbEntry) {
    if (bodyEdit === null) return;
    if (!bodyEdit.trim()) {
      setBodyError('The article body cannot be empty.');
      return;
    }
    setBodyBusy(true);
    setBodyError(null);
    try {
      const res = await api.patch<{ entry: GlobalKbEntry }>(`/global-kb/entries/${e.id}`, {
        body: bodyEdit,
      });
      const saved = res.entry;
      setSelected((cur) => (cur?.id === e.id ? saved : cur));
      setEntries((rows) => rows?.map((r) => (r.id === e.id ? saved : r)) ?? rows);
      setBodyEdit(null);
    } catch (err) {
      setBodyError((err as ApiError).message ?? 'Failed to save the body');
    } finally {
      setBodyBusy(false);
    }
  }

  async function remove(e: GlobalKbEntry) {
    // Only a kb_author ENRICH entry (source='user' with its own task) should cascade
    // a cancel — that task exists solely to produce this row, so deleting the row
    // orphans it. A PROMOTED draft (source='promoted') is one incidental artifact of a
    // full onboarding/workflow task; deleting it must NEVER cancel that task. Manual
    // entries carry no sourceTaskId, so the second clause also excludes them.
    const cancelsTask = e.source === 'user' && !!e.sourceTaskId;
    const msg = cancelsTask
      ? `Delete "${e.title}" permanently and cancel its enrichment task? This cannot be undone.`
      : `Delete "${e.title}" permanently? This cannot be undone.`;
    const approvalNote = carriesLiveApproval(e)
      ? `"${e.title}" carries an admin's approval as a house rule, and deleting it ends that approval. `
      : '';
    if (!window.confirm(`${approvalNote}${msg}`)) return;
    setDialogError(null);
    setBusy(true);
    try {
      await api.delete(`/global-kb/entries/${e.id}`);
      // Cancel the now-orphaned enrich task too — best-effort, since the article is
      // already gone: a cancel hiccup must not block the list refresh. The action
      // route no-ops for completed/cancelled tasks and flips a failed/running one to
      // cancelled (with full teardown).
      if (cancelsTask) {
        try {
          await api.post(`/tasks/${e.sourceTaskId}/action`, { action: 'cancel' });
        } catch {
          /* leave the now article-less task as-is; cancellable from Tasks */
        }
      }
      setSelected((s) => (s?.id === e.id ? null : s));
      await load();
    } catch (err) {
      reportError((err as ApiError).message ?? 'Delete failed');
    } finally {
      setBusy(false);
    }
  }

  // Cancel an in-progress enrichment from the KB view: cancel the underlying
  // kb_author task; the worker then deletes this still-enriching row, and the list
  // poll drops it on the next refresh.
  async function cancelEnrich(e: GlobalKbEntry) {
    if (!e.sourceTaskId) return;
    if (!window.confirm(`Cancel enriching "${e.title}"? The draft entry is discarded.`)) return;
    setBusy(true);
    try {
      await api.post(`/tasks/${e.sourceTaskId}/action`, { action: 'cancel' });
      await load();
    } catch (err) {
      setLoadError((err as ApiError).message ?? 'Cancel failed');
    } finally {
      setBusy(false);
    }
  }

  // Retry a failed enrichment: re-run the kb_author enrich step. Its detect phase
  // flips the entry back to 'enriching' and the list poll picks it up.
  async function retryEnrich(e: GlobalKbEntry) {
    if (!e.sourceTaskId) return;
    setBusy(true);
    try {
      await api.post(`/tasks/${e.sourceTaskId}/steps/01-kb-enrich/action`, { action: 'retry' });
      await load();
    } catch (err) {
      setLoadError((err as ApiError).message ?? 'Retry failed');
    } finally {
      setBusy(false);
    }
  }

  async function runEnrich() {
    if (!enrich.title.trim()) {
      setEnrichError('Give the article a title.');
      return;
    }
    if (enrich.title.length > 300) {
      setEnrichError('Title must be at most 300 characters.');
      return;
    }
    if (collapseToLine(enrich.description).length > GLOBAL_KB_DESCRIPTION_MAX) {
      setEnrichError(`Description must be at most ${GLOBAL_KB_DESCRIPTION_MAX} characters.`);
      return;
    }
    if (!enrich.notes.trim()) {
      setEnrichError('Write something for the AI to work from.');
      return;
    }
    // No repository required: a rule that applies to every project should be writable without
    // opening one, and anchoring to a codebase is what scoped the first of these to that
    // codebase's own version.
    if (!enrich.cliProviderId) {
      setEnrichError('Pick a CLI to write it with.');
      return;
    }
    const enrichScopeIssue = facetScopeError(facetsFromFields(enrichFacets));
    if (enrichScopeIssue) {
      setEnrichError(enrichScopeIssue);
      return;
    }
    setEnrichBusy(true);
    setEnrichError(null);
    try {
      await api.post('/global-kb/enrich', {
        title: enrich.title,
        ...(enrich.description.trim() ? { description: enrich.description } : {}),
        seedText: enrich.notes,
        ...(enrich.repoId ? { repositoryId: enrich.repoId } : {}),
        cliProviderId: enrich.cliProviderId,
        facets: facetsFromFields(enrichFacets),
        egress: {
          mode: enrich.egressMode,
          ...(enrich.egressMode === 'allowlist'
            ? { domains: parseList(enrich.egressDomains) }
            : {}),
        },
      });
      setEnrich({ ...enrich, title: '', description: '', notes: '' });
      setEnrichFacets({});
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
  const enforceOpen = enforcePanel !== null;
  const editOpen = scopeEdit !== null || descEdit !== null || bodyEdit !== null || enforceOpen;
  const editOpenHint = editOpen ? 'Save or cancel the open edit first' : undefined;

  /** Escape and the backdrop close an open edit before they close the dialog, so one stray press
   *  does not throw away what was typed. A save in flight is left to finish. */
  function dismiss() {
    if (!editOpen) {
      setSelected(null);
      return;
    }
    if (scopeBusy || descBusy || bodyBusy || enforcePanel?.busy) return;
    setScopeEdit(null);
    setDescEdit(null);
    setBodyEdit(null);
    setEnforcePanel(null);
  }

  /** Everyone sees what is enforced and why a rule lapsed or is paused; only an admin gets buttons.
   *  A paused rule gets no Enforce, as it resumes by itself; Un-enforce goes with any approval. */
  function renderEnforcement(e: GlobalKbEntry) {
    const state = e.enforcementState?.state ?? 'none';
    const predecessor = supersededEntry;
    const carried =
      state === 'none' &&
      e.status === 'active' &&
      predecessor?.enforce &&
      predecessor.enforcementState?.state === 'superseded'
        ? predecessor
        : null;
    let note: string | null = null;
    let action: { label: string; prefill: GlobalKbEnforceSpec | null } | null = null;
    switch (state) {
      case 'enforced':
        note = `Enforced house rule (${describeEnforceSpec(e.enforce)})${e.enforcedAt ? ` since ${e.enforcedAt.slice(0, 10)}` : ''}. Its full text is put into the prompt of every agent it applies to.`;
        if (e.status === 'active') {
          action = {
            label: 'Edit enforcement',
            prefill:
              e.enforcementState?.mode === 'files'
                ? { mode: 'files', globs: e.enforcementState.globs ?? [] }
                : { mode: 'always' },
          };
        }
        break;
      case 'edited':
        note = `Lapsed: the text changed after an admin approved it (${describeEnforceSpec(e.enforce)}), so the rule is not applied. An admin has to read the new text and enforce it again.`;
        action = { label: 'Re-enforce', prefill: e.enforce ?? null };
        break;
      case 'not_active':
        note = 'Lapsed: this entry is not active, so its rule is not applied.';
        break;
      case 'superseded':
        note = activeSuccessor
          ? `Superseded: "${activeSuccessor.title}" replaced this entry. An admin can enforce that entry instead.`
          : 'Superseded: another entry replaced this one, so its rule ended. An admin can enforce the replacement.';
        break;
      case 'cleared':
        note = `Not enforced. Enforcement was removed${e.enforce ? `; the last settings were ${describeEnforceSpec(e.enforce)}` : ''}.`;
        if (e.status === 'active') action = { label: 'Re-enforce', prefill: e.enforce ?? null };
        break;
      case 'switched_off':
        note = `Paused: house rules are switched off by an administrator (${describeEnforceSpec(e.enforce)}). The rule resumes when they are switched on.`;
        break;
      case 'other_namespace':
        note = `Paused: this entry belongs to the namespace "${e.namespace}", not to the one this instance uses. The rule resumes when that namespace is in use.`;
        break;
      default:
        if (carried) {
          note = `Replaces "${carried.title}", which had house-rule settings (${describeEnforceSpec(carried.enforce)}); any approval it still held ended when it was archived. An admin has to enforce this entry for the rule to carry over.`;
          action = { label: 'Re-enforce', prefill: carried.enforce };
        } else if (e.status === 'active' && canEnforce) {
          action = { label: 'Enforce…', prefill: null };
        }
    }
    const offers = enforcementOffers(e, instanceNamespace);
    if (!offers.enforce) action = null;
    if (
      !offers.enforce &&
      note &&
      instanceNamespace !== null &&
      e.namespace !== instanceNamespace
    ) {
      note += ` It belongs to the namespace "${e.namespace}", so only an install using that namespace can enforce it.`;
    }
    const unenforceable = canEnforce && offers.unenforce;
    if (!note && !action && !unenforceable) return null;
    return (
      <div className="mt-2 flex flex-col gap-2 text-xs text-neutral-400" data-testid="enforcement">
        {note && <p>{note}</p>}
        {canEnforce && (action || unenforceable) && (
          <div className="flex flex-wrap items-center gap-2">
            {action && (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy || editOpen}
                title={editOpenHint}
                onClick={() => void openEnforcePanel(action.prefill)}
              >
                {action.label}
              </Button>
            )}
            {unenforceable && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || editOpen}
                title={editOpenHint}
                onClick={() => void unenforce(e)}
              >
                Un-enforce
              </Button>
            )}
          </div>
        )}
      </div>
    );
  }

  function renderEnforcePanel(panel: EnforcePanel) {
    const entry = panel.entry;
    const rule = renderHouseRuleEntry(entry, {
      enforce: draftEnforceSpec(panel.mode, panel.globs),
      shortId: houseRuleShortIds([entry.id]).get(entry.id)!,
    });
    const total = panel.usedBytes + panel.entryBytes;
    const over = total - panel.capBytes;
    const pct = (bytes: number) =>
      `${Math.min(100, Math.max(0, (bytes / Math.max(1, panel.capBytes)) * 100))}%`;
    const disabled = panel.busy;
    return (
      <div
        className="mt-3 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto rounded-md border border-neutral-800 p-3"
        data-testid="enforce-panel"
      >
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-neutral-100">Enforce this house rule</span>
          <p className="text-xs text-neutral-400">
            Enforcing puts the text below into the prompt of every agent the rule applies to, as an
            instruction. You are approving this exact text, shown as agents see it and not rendered.
          </p>
          {!houseRulesOn && (
            <p className="text-xs text-amber-400">
              House rules are switched off in the admin console, so this rule stays paused until
              they are switched on.
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[11px] text-neutral-500">The rule, as agents see it</span>
          <HighlightedSource name="rule.txt" content={rule} className="max-h-96" />
          {collapseToLine(entry.description) === '' && (
            <p className="text-xs text-amber-400">None. An enforced rule needs a description.</p>
          )}
        </div>
        <div className="flex flex-wrap gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="enforce-mode">Applies</Label>
            <select
              id="enforce-mode"
              value={panel.mode}
              disabled={disabled}
              onChange={(ev) =>
                setEnforcePanel({ ...panel, mode: ev.target.value as 'always' | 'files' })
              }
              className="h-10 rounded-md border border-neutral-800 bg-neutral-950 px-3 text-sm text-neutral-100"
            >
              <option value="files">when files match</option>
              <option value="always">always</option>
            </select>
          </div>
        </div>
        {panel.mode === 'files' ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="enforce-globs">Globs, one per line</Label>
            <textarea
              id="enforce-globs"
              value={panel.globs}
              disabled={disabled}
              onChange={(ev) => setEnforcePanel({ ...panel, globs: ev.target.value })}
              rows={4}
              placeholder={'src/**/*.php\ntemplates/**/*.{twig,css}'}
              className="w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-sm text-neutral-100 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
            />
            <span className="text-[11px] text-neutral-500">
              Relative to the repository root. Brace globs may hold commas, so each glob is its own
              line. The rule applies when a task touches a matching file.
            </span>
          </div>
        ) : (
          <div className="flex flex-col gap-1" data-testid="enforce-meter">
            <span className="text-xs text-neutral-300">
              Always-on rules: {panel.usedBytes} bytes in use + this entry {panel.entryBytes} ={' '}
              {total} of {panel.capBytes} bytes
            </span>
            <div
              role="meter"
              aria-label="Always-on prompt size"
              aria-valuemin={0}
              aria-valuemax={panel.capBytes}
              aria-valuenow={total}
              className="flex h-2 w-full overflow-hidden rounded-full bg-neutral-800"
            >
              <div className="h-full bg-indigo-500" style={{ width: pct(panel.usedBytes) }} />
              <div
                className={`h-full ${over > 0 ? 'bg-red-500' : 'bg-sky-500'}`}
                style={{ width: pct(Math.min(panel.entryBytes, panel.capBytes - panel.usedBytes)) }}
              />
            </div>
            {over > 0 && (
              <span className="text-xs text-red-400">Over the cap by {over} bytes.</span>
            )}
          </div>
        )}
        <FormError message={panel.error} />
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={disabled} onClick={() => void submitEnforce()}>
            {panel.busy ? 'Working…' : 'Enforce'}
          </Button>
          {panel.stale && (
            <Button
              size="sm"
              variant="secondary"
              disabled={disabled}
              onClick={() => void reloadEnforcePanel()}
            >
              Reload entry
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => setEnforcePanel(null)}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

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
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <CardTitle>Connection</CardTitle>
              <CardDescription>
                Where the global KB lives and how it embeds — this is the second, instance-wide DB
                (separate from each repo&apos;s RAG DB set during onboarding). Internal = a
                dedicated DB on this Haive host; external = a central/remote Postgres shared across
                machines. Set an embedding model or retrieval falls back to weak hash embeddings.
              </CardDescription>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {!connExpanded && (
                <span
                  className={`text-xs ${
                    connChecking
                      ? 'text-neutral-400'
                      : connOk
                        ? 'text-emerald-400'
                        : 'text-amber-400'
                  }`}
                >
                  {connChecking
                    ? '… checking'
                    : connOk
                      ? canEnforce
                        ? '✓ connected'
                        : '✓ embedding model OK'
                      : '⚠ needs attention'}
                </span>
              )}
              <Button size="sm" variant="ghost" onClick={() => setConnExpanded((v) => !v)}>
                {connExpanded ? 'Collapse' : 'Edit'}
              </Button>
            </div>
          </div>
        </CardHeader>
        {connExpanded ? (
          <div className="flex flex-col gap-3">
            <label className="flex items-center gap-2 text-sm text-neutral-100">
              <input
                type="checkbox"
                checked={cfg.enabled}
                disabled={!canEnforce}
                onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })}
                className="h-4 w-4 rounded border-neutral-700 bg-neutral-950"
              />
              Enabled (tasks retrieve global entries)
              {!canEnforce && <span className="text-[11px] text-neutral-500">Admins only</span>}
            </label>
            <label className="flex items-center gap-2 text-sm text-neutral-100">
              <input
                type="checkbox"
                checked={cfg.digestEnabled}
                onChange={(e) => setCfg({ ...cfg, digestEnabled: e.target.checked })}
                className="h-4 w-4 rounded border-neutral-700 bg-neutral-950"
              />
              List matching entry titles in agent prompts (costs prompt tokens per run)
            </label>
            <p className="text-xs text-neutral-400" data-testid="house-rules-switch">
              House rules in agent prompts:{' '}
              <span className="font-medium text-neutral-200">{houseRulesOn ? 'on' : 'off'}</span>.{' '}
              {canEnforce ? (
                <a
                  href="/admin?tab=execution"
                  className="text-indigo-400 underline underline-offset-2 hover:text-indigo-300"
                >
                  Change it in the admin console, CLI execution tab.
                </a>
              ) : (
                'Admins only: it is switched in the admin console.'
              )}
            </p>
            <div className="flex flex-wrap gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cfg-mode">
                  Provider
                  {!canEnforce && (
                    <span className="ml-2 text-[11px] font-normal text-neutral-500">
                      Admins only
                    </span>
                  )}
                </Label>
                <select
                  id="cfg-mode"
                  value={cfg.mode}
                  disabled={!canEnforce}
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
                <Label htmlFor="cfg-namespace">
                  Namespace
                  {!canEnforce && (
                    <span className="ml-2 text-[11px] font-normal text-neutral-500">
                      Admins only
                    </span>
                  )}
                </Label>
                <Input
                  id="cfg-namespace"
                  maxLength={120}
                  disabled={!canEnforce}
                  aria-describedby="cfg-namespace-limit"
                  value={cfg.namespace}
                  onChange={(e) => setCfg({ ...cfg, namespace: e.target.value })}
                  className="w-40"
                />
                <span id="cfg-namespace-limit" className="text-[11px] text-neutral-500">
                  {cfg.namespace.length} / 120
                </span>
              </div>
            </div>
            {cfg.mode === 'external' && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cfg-conn">
                  External connection string{cfgSet ? ' (set — leave blank to keep)' : ''}
                  {!canEnforce && (
                    <span className="ml-2 text-[11px] font-normal text-neutral-500">
                      Admins only
                    </span>
                  )}
                </Label>
                <Input
                  id="cfg-conn"
                  type="password"
                  disabled={!canEnforce}
                  value={cfg.connectionString}
                  onChange={(e) => setCfg({ ...cfg, connectionString: e.target.value })}
                  placeholder="postgres://user:pass@host:5432/db"
                />
              </div>
            )}
            {canEnforce && (
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
            )}
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
                    placeholder={DEFAULT_EXTERNAL_OLLAMA_URL}
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
                  min={1}
                  max={8192}
                  step={1}
                  value={Number.isNaN(cfg.embedDimensions) ? '' : cfg.embedDimensions}
                  onChange={(e) => setCfg({ ...cfg, embedDimensions: e.target.valueAsNumber })}
                  className="w-32"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cfg-retention">Archive retention (days)</Label>
                <Input
                  id="cfg-retention"
                  type="number"
                  min={0}
                  max={3650}
                  step={1}
                  value={Number.isNaN(cfg.archiveRetentionDays) ? '' : cfg.archiveRetentionDays}
                  onChange={(e) =>
                    setCfg({
                      ...cfg,
                      archiveRetentionDays: e.target.valueAsNumber,
                    })
                  }
                  className="w-32"
                />
              </div>
            </div>
            {cfg.ollamaMode === 'internal' && (
              <p className="text-xs text-neutral-500">
                Internal mode uses {IN_STACK_OLLAMA_URL} automatically.
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
        ) : (
          <p className="text-xs text-neutral-400">
            {cfg.mode === 'internal' ? 'Internal DB' : 'External DB'} ·{' '}
            {cfg.embedModel || 'no model'} · {cfg.embedDimensions} dims ·{' '}
            {cfg.enabled ? 'enabled' : 'disabled'} · house rules {houseRulesOn ? 'on' : 'off'}
          </p>
        )}
      </Card>

      <Card id="add-house-rule">
        <CardHeader>
          <CardTitle>Add a house rule</CardTitle>
          <CardDescription>
            Set a title you'll recognize, then write the rule — generic or detailed; name modules,
            paste URLs. A repository is optional: it is somewhere the AI can SEE the rule obeyed or
            broken, never the subject of the article. It keeps your title, derives the category, and
            fills whatever scope you leave blank — filing the result as a draft for you to review,
            either as a new rule or an update of one already in the KB.
          </CardDescription>
        </CardHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="enrich-title">Title</Label>
            <Input
              id="enrich-title"
              value={enrich.title}
              onChange={(e) => setEnrich({ ...enrich, title: e.target.value })}
              maxLength={300}
              aria-describedby="enrich-title-limit"
              placeholder="A title you'll recognize, e.g. Drupal 11 paragraphs nesting limit"
            />
            <span id="enrich-title-limit" className="self-end text-[11px] text-neutral-500">
              {enrich.title.length} / 300
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="enrich-description">Description (optional)</Label>
            <DescriptionField
              id="enrich-description"
              value={enrich.description}
              onChange={(description) => setEnrich({ ...enrich, description })}
              placeholder="One line: what the rule says and when it applies"
            />
            <span className="text-[11px] text-neutral-500">
              Leave it empty and the AI writes one. Once the rule is active, this line is listed
              beside its title in the prompt of every agent the rule applies to.
            </span>
          </div>
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
                <option value="none">
                  {enrich.repoId ? 'repo only (no web)' : 'no web access'}
                </option>
                <option value="allowlist">specific domains</option>
                <option value="full">full internet</option>
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="enrich-repo">Repository (optional)</Label>
              <select
                id="enrich-repo"
                value={enrich.repoId}
                onChange={(e) => setEnrich({ ...enrich, repoId: e.target.value })}
                className="h-10 rounded-md border border-neutral-800 bg-neutral-950 px-3 text-sm text-neutral-100"
              >
                {/* Default. A house standard applies to every project, so writing one should not
                    require opening any — and anchoring is what scoped the first of these to the
                    one codebase it was written against. */}
                <option value="">none — write a generic rule</option>
                {repos.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
              <span className="text-[11px] text-neutral-500">
                Somewhere the AI can SEE the rule obeyed or broken. It never cites the code it reads
                — the article has to work for projects that share none of its files.
              </span>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Applies to (optional)</Label>
            <span className="text-[11px] text-neutral-500">
              Leave a box empty and the rule applies to ALL values of it — that is what makes an
              article reachable from the projects that need it. Name a technology and its version
              stays open: scoping Framework to drupal keeps the rule across every Drupal major, so
              fill Framework major only when the rule is genuinely specific to one. The AI fills the
              dimensions you leave untouched and never narrows one you scoped. Comma-separated.
            </span>
            <FacetFields
              idPrefix="enrich-facet"
              fields={enrichFacets}
              disabled={enrichBusy}
              onChange={(key, value) => setEnrichFacets((f) => ({ ...f, [key]: value }))}
            />
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
            <Button
              disabled={
                enrichBusy || collapseToLine(enrich.description).length > GLOBAL_KB_DESCRIPTION_MAX
              }
              onClick={() => void runEnrich()}
            >
              {enrichBusy ? 'Starting…' : 'Add with AI'}
            </Button>
          </div>
          <p className="text-xs text-neutral-500">
            A background task writes the article and files it as a draft. It appears below; refresh
            to see updates.
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
            <option value="archived">archived</option>
            <option value="failed">failed</option>
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
          AI-written rules land as drafts. <span className="text-neutral-300">Activate</span>{' '}
          publishes one into retrieval; <span className="text-neutral-300">Delete</span> permanently
          removes a rule.
        </p>
        {sourceTaskId && (
          <div className="flex items-center gap-2 rounded-md border border-indigo-500/40 bg-indigo-500/10 px-3 py-2 text-xs text-indigo-200">
            <span>Showing only the global-KB drafts promoted by one task.</span>
            <button
              type="button"
              onClick={() => setSourceTaskId(null)}
              className="font-medium text-indigo-100 underline underline-offset-2 hover:text-white"
            >
              Clear task filter
            </button>
          </div>
        )}
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
            const inProgress = e.status === 'enriching' || e.status === 'skeleton';
            const failed = e.status === 'failed';
            // The step Retry refuses a task that is not failed, and finds no deleted one.
            const retryable = failed && !!e.sourceTaskId && e.sourceTaskStatus === 'failed';
            const clickable = !inProgress && !failed;
            return (
              <Card
                key={e.id}
                className={
                  clickable
                    ? 'cursor-pointer p-4 transition-colors hover:border-neutral-700'
                    : 'p-4'
                }
                onClick={clickable ? () => setSelected(e) : undefined}
                role={clickable ? 'button' : undefined}
                tabIndex={clickable ? 0 : undefined}
                onKeyDown={
                  clickable
                    ? (ev) => {
                        if (ev.key === 'Enter' || ev.key === ' ') {
                          ev.preventDefault();
                          setSelected(e);
                        }
                      }
                    : undefined
                }
              >
                <div className="flex flex-col gap-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-neutral-50">{e.title}</span>
                    {inProgress ? (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-sky-500/15 px-2 py-0.5 text-xs font-medium text-sky-300">
                        <span className="h-3 w-3 animate-spin rounded-full border-2 border-sky-400/40 border-t-sky-300" />
                        {e.status === 'skeleton' ? 'queued' : 'enriching'}
                      </span>
                    ) : (
                      <Badge variant={STATUS_VARIANT[e.status] ?? 'default'}>{e.status}</Badge>
                    )}
                    <Badge variant="default">{e.category.replace(/_/g, ' ')}</Badge>
                    {e.source === 'promoted' && <Badge variant="info">promoted</Badge>}
                    <HouseRuleBadge state={e.enforcementState} />
                    {e.status === 'active' && e.embedStatus !== 'embedded' && (
                      <Badge variant={e.embedStatus === 'failed' ? 'error' : 'default'}>
                        {e.embedStatus}
                      </Badge>
                    )}
                    <div className="ml-auto flex items-center gap-2">
                      {inProgress && e.sourceTaskId && (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busy}
                          onClick={(ev) => {
                            ev.stopPropagation();
                            void cancelEnrich(e);
                          }}
                          title="Cancel the enrichment task and discard this entry"
                        >
                          Cancel
                        </Button>
                      )}
                      {retryable && (
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={(ev) => {
                            ev.stopPropagation();
                            void retryEnrich(e);
                          }}
                          title="Re-run the enrichment task"
                        >
                          Retry
                        </Button>
                      )}
                      {failed && e.sourceTaskId && (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busy}
                          onClick={(ev) => {
                            ev.stopPropagation();
                            window.open(
                              `/tasks/${e.sourceTaskId}`,
                              '_blank',
                              'noopener,noreferrer',
                            );
                          }}
                        >
                          Go to task
                        </Button>
                      )}
                      {/* Drafts only. Reactivating an ARCHIVED entry is a considered recovery,
                          not a list operation: it cannot retire whatever replaced it (the API
                          archives the predecessor named by the row being activated, and a
                          successor points the other way), so done from here it silently leaves
                          two entries live for one rule. Worse from a filtered list — filtering to
                          `archived` HIDES the successor, so the conflict is not even visible. The
                          detail view is where the warning and the diff are, and where the scope
                          editor's own copy already sends the reviewer. Activating a draft carries
                          no such hazard: superseding its predecessor is the designed outcome. */}
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
                      {!inProgress && (
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
                      )}
                    </div>
                  </div>
                  {e.description && (
                    <div onClick={stopAtLinks} onKeyDown={stopAtLinks}>
                      <InlineMarkdown
                        body={e.description}
                        className="break-words text-sm text-neutral-300"
                      />
                    </div>
                  )}
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
                        {inProgress ? 'Watch task ↗' : 'View task ↗'}
                      </a>
                    )}
                    {inProgress && (
                      <span className="text-xs text-neutral-500">
                        Writing the article in the background — lands as a draft to review.
                      </span>
                    )}
                    {failed && (
                      <span className="text-xs text-red-400">
                        {retryable
                          ? 'Enrichment failed — retry, or open the task for details.'
                          : 'Enrichment failed — open the task for details.'}
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
        onOpenChange={(o) => !o && dismiss()}
        className="w-[95vw] max-w-6xl"
      >
        <DialogContent className="flex max-h-[90vh] flex-col">
          {selected && (
            <>
              <DialogHeader className="mb-3 flex-row items-start justify-between gap-4">
                <DialogTitle>{selected.title}</DialogTitle>
                <button
                  type="button"
                  onClick={dismiss}
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
                <HouseRuleBadge state={selected.enforcementState} />
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
              {renderEnforcement(selected)}
              {descEdit !== null ? (
                <div className="mt-2 flex flex-col gap-2 rounded border border-neutral-800 p-2">
                  <Label
                    htmlFor="description-edit"
                    className="text-[11px] font-normal text-neutral-500"
                  >
                    One line: what the rule says and when it applies. Once the entry is active it is
                    listed beside the title in the prompt of every agent the rule applies to.
                  </Label>
                  {carriesLiveApproval(selected) && (
                    <span className="text-[11px] text-amber-400">
                      This entry carries an admin&apos;s approval as a house rule. Saving a change
                      ends that approval until an admin enforces the entry again.
                    </span>
                  )}
                  <DescriptionField
                    id="description-edit"
                    value={descEdit}
                    disabled={descBusy || bodyBusy}
                    onChange={setDescEdit}
                  />
                  {descError && <FormError message={descError} />}
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      disabled={
                        descBusy ||
                        bodyBusy ||
                        collapseToLine(descEdit).length > GLOBAL_KB_DESCRIPTION_MAX
                      }
                      onClick={() => void saveDescription(selected)}
                    >
                      {descBusy ? 'Saving…' : 'Save description'}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={descBusy}
                      onClick={() => setDescEdit(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="mt-2 flex items-start gap-2">
                  {selected.description ? (
                    <InlineMarkdown
                      body={selected.description}
                      className="min-w-0 break-words text-sm text-neutral-300"
                    />
                  ) : (
                    <p className="min-w-0 text-xs text-neutral-500">No description.</p>
                  )}
                  <button
                    type="button"
                    disabled={bodyBusy || enforceOpen}
                    onClick={() => {
                      setDescError(null);
                      setDescEdit(selected.description ?? '');
                    }}
                    className="shrink-0 text-xs text-indigo-400 underline underline-offset-2 hover:text-indigo-300"
                  >
                    Edit description
                  </button>
                </div>
              )}
              {scopeEdit ? (
                <div className="mt-2 flex flex-col gap-2 rounded border border-neutral-800 p-2">
                  <span className="text-[11px] text-neutral-500">
                    Empty = applies to all values of that dimension. Comma-separated.
                  </span>
                  {carriesLiveApproval(selected) && (
                    <span className="text-[11px] text-amber-400">
                      This entry carries an admin&apos;s approval as a house rule. Saving a change
                      ends that approval until an admin enforces the entry again.
                    </span>
                  )}
                  {/* Said rather than decided: re-scoping a replacement does not bring its
                      predecessor back, and resurrecting an article somebody retired is not a
                      choice this form should make for them. */}
                  {selected.supersedesEntryId && (
                    <span className="text-[11px] text-amber-400">
                      {selected.status === 'draft'
                        ? 'This draft replaces an earlier entry. Changing the scope here detaches it, so activating will no longer archive that entry.'
                        : 'This entry replaced an earlier one, which was archived when it was activated. Re-scoping moves this rule but does not bring the archived entry back — open that entry and press Reactivate if the old scope still needs a rule.'}
                    </span>
                  )}
                  <FacetFields
                    idPrefix="scope-edit"
                    fields={scopeEdit}
                    disabled={scopeBusy || bodyBusy}
                    onChange={(key, value) => setScopeEdit((f) => ({ ...(f ?? {}), [key]: value }))}
                  />
                  {scopeError && <FormError message={scopeError} />}
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      disabled={scopeBusy || bodyBusy}
                      onClick={() => void saveScope(selected)}
                    >
                      {scopeBusy ? 'Saving…' : 'Save scope'}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={scopeBusy}
                      onClick={() => setScopeEdit(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="mt-2 flex items-center gap-2 text-xs text-neutral-400">
                  {facetsSummary(selected.facets)}
                  <button
                    type="button"
                    disabled={bodyBusy || enforceOpen}
                    onClick={() => {
                      setScopeError(null);
                      setScopeEdit(fieldsFromFacets(selected.facets));
                    }}
                    className="text-indigo-400 underline underline-offset-2 hover:text-indigo-300"
                  >
                    Edit scope
                  </button>
                </p>
              )}
              <div className="mt-3 flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-neutral-300">Article body</span>
                {bodyEdit === null && (
                  <button
                    type="button"
                    className="shrink-0 text-xs text-indigo-400 underline underline-offset-2 hover:text-indigo-300 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={busy || scopeBusy || descBusy || enforceOpen}
                    onClick={() => {
                      setBodyError(null);
                      setBodyEdit(selected.body);
                    }}
                  >
                    Edit body
                  </button>
                )}
              </div>
              {enforcePanel ? (
                renderEnforcePanel(enforcePanel)
              ) : bodyEdit !== null ? (
                <div className="mt-2 min-h-0 flex-1 overflow-y-auto rounded-md border border-neutral-800 p-3">
                  {carriesLiveApproval(selected) && (
                    <p className="mb-2 text-[11px] text-amber-400">
                      This entry carries an admin&apos;s approval as a house rule. Saving a change
                      ends that approval until an admin enforces the entry again.
                    </p>
                  )}
                  <MarkdownEditor
                    key={selected.id}
                    value={bodyEdit}
                    onChange={setBodyEdit}
                    disabled={bodyBusy || scopeBusy || descBusy || busy}
                    breaks={!looksLikeMarkdown(selected.body)}
                    placeholder="Write the article…"
                  />
                  <FormError message={bodyError} />
                  <div className="mt-3 flex items-center gap-2">
                    <Button
                      size="sm"
                      disabled={bodyBusy || scopeBusy || descBusy || busy}
                      onClick={() => void saveBody(selected)}
                    >
                      {bodyBusy ? 'Saving…' : 'Save body'}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={bodyBusy}
                      onClick={() => setBodyEdit(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : supersededEntry ? (
                <>
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                    <span className="rounded bg-amber-500/15 px-2 py-0.5 font-medium text-amber-300">
                      Updates existing: {supersededEntry.title}
                      {supersededEntry.carriesApproval
                        ? " (carries an admin's approval as a house rule)"
                        : ''}
                    </span>
                    <div className="ml-auto flex overflow-hidden rounded border border-neutral-800">
                      <button
                        type="button"
                        onClick={() => setDraftView('diff')}
                        className={`px-2 py-1 ${draftView === 'diff' ? 'bg-indigo-950 text-indigo-200' : 'text-neutral-400 hover:bg-neutral-900'}`}
                      >
                        Diff
                      </button>
                      <button
                        type="button"
                        onClick={() => setDraftView('full')}
                        className={`border-l border-neutral-800 px-2 py-1 ${draftView === 'full' ? 'bg-indigo-950 text-indigo-200' : 'text-neutral-400 hover:bg-neutral-900'}`}
                      >
                        Full
                      </button>
                    </div>
                  </div>
                  <div className="mt-2 flex items-start gap-1.5 text-xs text-neutral-400">
                    <span className="shrink-0 font-medium text-neutral-300">
                      Existing description:
                    </span>
                    {supersededEntry.description ? (
                      <InlineMarkdown
                        body={supersededEntry.description}
                        className="min-w-0 flex-1 break-words"
                      />
                    ) : (
                      <span>none</span>
                    )}
                  </div>
                  <div className="mt-2 min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable] rounded-md border border-neutral-800">
                    {draftView === 'diff' ? (
                      <GlobalKbDiff baseline={supersededEntry.body} current={selected.body} />
                    ) : (
                      <MarkdownView body={selected.body} className="max-h-none overflow-visible" />
                    )}
                  </div>
                </>
              ) : (
                <div className="mt-3 min-h-0 flex-1 overflow-y-auto rounded-md border border-neutral-800">
                  <MarkdownView body={selected.body} className="max-h-none overflow-visible" />
                </div>
              )}
              {/* Reactivating does NOT retire whatever replaced this entry: the API archives the
                  predecessor named by the row being activated, and a successor points the other
                  way. Done before that successor has been re-scoped, both end up active and
                  retrievable for the same rule.
                  Said rather than blocked, and rather than archiving the successor behind the
                  reviewer's back — both are choices this form should not make for them, which is
                  the same rule the scope-edit warning above follows. Two active entries is noise
                  a reviewer can see and undo; silently retiring the live one is not. */}
              {selected.status === 'archived' && activeSuccessor && (
                <div className="mt-3 text-center text-[11px] text-amber-400">
                  <p>
                    An active entry, <span className="font-medium">{activeSuccessor.title}</span>,
                    still replaces this one. Reactivating leaves both live for the same scope —
                    re-scope or archive that entry if only one should apply.
                  </p>
                  {/* Opening another entry resets an open edit, so it waits for that edit to be
                      saved or cancelled rather than discarding it silently. */}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="mt-1"
                    disabled={busy || scopeBusy || descBusy || bodyBusy || editOpen}
                    title={editOpenHint}
                    onClick={() => void openEntry(activeSuccessor.id)}
                  >
                    Open that entry
                  </Button>
                </div>
              )}
              {dialogError && (
                <div className="mt-3">
                  <FormError message={dialogError} />
                </div>
              )}
              <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
                {/* Activation is blocked while a scope edit is OPEN as well as while one is in
                    flight. They are separate PATCHes, and activating first archives the
                    predecessor the scope edit is about to clear — retiring an entry the reviewer
                    just decided was unrelated. Guarding only the in-flight half missed the case
                    that matters most: with the editor open there is no request yet, so nothing
                    server-side can serialise it, and the reviewer's unsaved re-scope is exactly
                    the judgement the activation would be ignoring. Saving afterwards re-scopes
                    the now-active entry and does NOT bring the predecessor back. An open
                    description or body edit blocks it too: activating publishes the stored
                    article, so the reviewer must save or cancel their corrections first. */}
                {(selected.status === 'draft' || selected.status === 'archived') && (
                  <Button
                    size="sm"
                    disabled={
                      busy || scopeBusy || descBusy || bodyBusy || editOpen || successorLoading
                    }
                    title={
                      editOpenHint ??
                      (successorLoading
                        ? 'Checking whether an active entry already replaces this one…'
                        : undefined)
                    }
                    onClick={() => void activate(selected)}
                  >
                    {selected.status === 'archived' ? 'Reactivate' : 'Activate'}
                  </Button>
                )}
                {/* Same guard as Activate: archiving mid-edit changes which branch the pending scope
                    save takes, since the PATCH treats an archived entry's supersede link as clearable. */}
                {selected.status === 'active' && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy || scopeBusy || descBusy || bodyBusy || editOpen}
                    title={editOpenHint}
                    onClick={() => void archive(selected)}
                  >
                    Archive
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy || scopeBusy || descBusy || bodyBusy || editOpen}
                  title={editOpenHint}
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
