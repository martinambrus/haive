'use client';

import { useEffect, useState } from 'react';
import { api, type ApiError, type GlobalKbEntry, type GlobalKbFacets } from '@/lib/api-client';
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

const CATEGORIES: GlobalKbEntry['category'][] = [
  'general',
  'tech_pattern',
  'anti_pattern',
  'best_practice',
  'quick_reference',
];

const FACET_FIELDS = [
  {
    key: 'framework',
    label: 'Frameworks',
    hint: 'e.g. drupal (current) or drupal7 (D7-only). Empty = all.',
  },
  {
    key: 'frameworkMajor',
    label: 'Framework major',
    hint: 'e.g. 11 — only Drupal 11, not 12. Empty = all majors.',
  },
  { key: 'language', label: 'Languages', hint: 'e.g. php, javascript' },
  { key: 'phpMajor', label: 'PHP major', hint: 'e.g. 8 — only matches PHP 8 projects' },
  { key: 'nodeMajor', label: 'Node major', hint: 'e.g. 20' },
  { key: 'tags', label: 'Tags', hint: 'free-form scope tags' },
] as const;

type FacetKey = (typeof FACET_FIELDS)[number]['key'];

interface FormState {
  id: string | null;
  title: string;
  category: GlobalKbEntry['category'];
  status: 'draft' | 'active';
  namespace: string;
  body: string;
  facets: Record<FacetKey, string>;
}

const EMPTY_FACETS: Record<FacetKey, string> = {
  framework: '',
  frameworkMajor: '',
  language: '',
  phpMajor: '',
  nodeMajor: '',
  tags: '',
};

const EMPTY_FORM: FormState = {
  id: null,
  title: '',
  category: 'general',
  status: 'draft',
  namespace: '',
  body: '',
  facets: { ...EMPTY_FACETS },
};

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

export default function GlobalKbPage() {
  usePageTitle('Global KB');
  const [entries, setEntries] = useState<GlobalKbEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adminOnly, setAdminOnly] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draftsOnly, setDraftsOnly] = useState(false);

  async function refresh() {
    try {
      const res = await api.get<{ entries: GlobalKbEntry[] }>('/global-kb/entries');
      setEntries(res.entries);
      setLoadError(null);
    } catch (err) {
      const e = err as ApiError;
      if (e.status === 403) setAdminOnly(true);
      else setLoadError(e.message ?? 'Failed to load global KB');
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  function editEntry(e: GlobalKbEntry) {
    setForm({
      id: e.id,
      title: e.title,
      category: e.category,
      status: e.status === 'active' ? 'active' : 'draft',
      namespace: e.namespace,
      body: e.body,
      facets: {
        framework: (e.facets.framework ?? []).join(', '),
        frameworkMajor: (e.facets.frameworkMajor ?? []).join(', '),
        language: (e.facets.language ?? []).join(', '),
        phpMajor: (e.facets.phpMajor ?? []).join(', '),
        nodeMajor: (e.facets.nodeMajor ?? []).join(', '),
        tags: (e.facets.tags ?? []).join(', '),
      },
    });
    setFormError(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function resetForm() {
    setForm(EMPTY_FORM);
    setFormError(null);
  }

  async function submit() {
    if (!form.title.trim() || !form.body.trim()) {
      setFormError('Title and body are required.');
      return;
    }
    setBusy(true);
    setFormError(null);
    const facets: GlobalKbFacets = {};
    for (const { key } of FACET_FIELDS) {
      const list = parseList(form.facets[key]);
      if (list.length) facets[key] = list;
    }
    try {
      if (form.id) {
        await api.patch(`/global-kb/entries/${form.id}`, {
          title: form.title,
          category: form.category,
          status: form.status,
          body: form.body,
          facets,
        });
      } else {
        await api.post('/global-kb/entries', {
          title: form.title,
          category: form.category,
          status: form.status,
          body: form.body,
          facets,
          ...(form.namespace.trim() ? { namespace: form.namespace.trim() } : {}),
        });
      }
      resetForm();
      await refresh();
    } catch (err) {
      setFormError((err as ApiError).message ?? 'Save failed');
    } finally {
      setBusy(false);
    }
  }

  async function activate(e: GlobalKbEntry) {
    setBusy(true);
    try {
      await api.patch(`/global-kb/entries/${e.id}`, { status: 'active' });
      await refresh();
    } catch (err) {
      setLoadError((err as ApiError).message ?? 'Activate failed');
    } finally {
      setBusy(false);
    }
  }

  async function archive(e: GlobalKbEntry) {
    setBusy(true);
    try {
      await api.delete(`/global-kb/entries/${e.id}`);
      await refresh();
    } catch (err) {
      setLoadError((err as ApiError).message ?? 'Archive failed');
    } finally {
      setBusy(false);
    }
  }

  if (adminOnly) {
    return (
      <div className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold text-neutral-50">Global KB</h2>
        <p className="text-sm text-neutral-400">
          The global knowledge base is admin-only. Ask an administrator for access.
        </p>
      </div>
    );
  }

  const shown = (entries ?? []).filter((e) => (draftsOnly ? e.status === 'draft' : true));

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
          <CardTitle>{form.id ? 'Edit entry' : 'New entry'}</CardTitle>
          <CardDescription>
            Facets scope retrieval: an entry only reaches projects whose stack matches. Leave a
            dimension empty to apply everywhere.
          </CardDescription>
        </CardHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="gkb-title">Title</Label>
            <Input
              id="gkb-title"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="e.g. Drupal 11 lazy-loading via the Lazy module"
            />
          </div>

          <div className="flex flex-wrap gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="gkb-category">Category</Label>
              <select
                id="gkb-category"
                value={form.category}
                onChange={(e) =>
                  setForm({ ...form, category: e.target.value as GlobalKbEntry['category'] })
                }
                className="h-10 rounded-md border border-neutral-800 bg-neutral-950 px-3 text-sm text-neutral-100"
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="gkb-status">Status</Label>
              <select
                id="gkb-status"
                value={form.status}
                onChange={(e) => setForm({ ...form, status: e.target.value as 'draft' | 'active' })}
                className="h-10 rounded-md border border-neutral-800 bg-neutral-950 px-3 text-sm text-neutral-100"
              >
                <option value="draft">draft (not retrievable)</option>
                <option value="active">active (retrievable)</option>
              </select>
            </div>
            {!form.id && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="gkb-namespace">Namespace</Label>
                <Input
                  id="gkb-namespace"
                  value={form.namespace}
                  onChange={(e) => setForm({ ...form, namespace: e.target.value })}
                  placeholder="default"
                  className="w-40"
                />
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="gkb-body">Body (markdown)</Label>
            <textarea
              id="gkb-body"
              value={form.body}
              onChange={(e) => setForm({ ...form, body: e.target.value })}
              rows={8}
              placeholder={'# Heading\n\nConcrete steps, config, and examples...'}
              className="w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-sm text-neutral-100 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {FACET_FIELDS.map((f) => (
              <div key={f.key} className="flex flex-col gap-1.5">
                <Label htmlFor={`gkb-facet-${f.key}`}>{f.label}</Label>
                <Input
                  id={`gkb-facet-${f.key}`}
                  value={form.facets[f.key]}
                  onChange={(e) =>
                    setForm({ ...form, facets: { ...form.facets, [f.key]: e.target.value } })
                  }
                  placeholder="comma-separated"
                />
                <p className="text-xs text-neutral-500">{f.hint}</p>
              </div>
            ))}
          </div>

          <FormError message={formError} />
          <div className="flex gap-2">
            <Button disabled={busy} onClick={() => void submit()}>
              {form.id ? 'Save changes' : 'Create entry'}
            </Button>
            {form.id && (
              <Button variant="secondary" disabled={busy} onClick={resetForm}>
                Cancel
              </Button>
            )}
          </div>
        </div>
      </Card>

      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-neutral-200">
          Entries {entries ? `(${shown.length})` : ''}
        </h3>
        <div className="flex gap-1">
          <Button
            size="sm"
            variant={draftsOnly ? 'ghost' : 'primary'}
            onClick={() => setDraftsOnly(false)}
          >
            All
          </Button>
          <Button
            size="sm"
            variant={draftsOnly ? 'primary' : 'ghost'}
            onClick={() => setDraftsOnly(true)}
          >
            Pending review
          </Button>
        </div>
      </div>

      <FormError message={loadError} />

      {entries === null ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="text-sm text-neutral-500">No entries yet.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {shown.map((e) => (
            <Card key={e.id}>
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-neutral-50">{e.title}</span>
                  <Badge variant={STATUS_VARIANT[e.status] ?? 'default'}>{e.status}</Badge>
                  <Badge variant="default">{e.category.replace(/_/g, ' ')}</Badge>
                  {e.source === 'promoted' && <Badge variant="info">promoted</Badge>}
                  {e.status === 'active' && e.embedStatus !== 'embedded' && (
                    <Badge variant={e.embedStatus === 'failed' ? 'error' : 'default'}>
                      {e.embedStatus}
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-neutral-400">{facetsSummary(e.facets)}</p>
                <p className="line-clamp-2 text-sm text-neutral-300">{e.body}</p>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => editEntry(e)}
                  >
                    Edit
                  </Button>
                  {e.status !== 'active' && (
                    <Button size="sm" disabled={busy} onClick={() => void activate(e)}>
                      Activate
                    </Button>
                  )}
                  {e.status !== 'archived' && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => void archive(e)}
                    >
                      Archive
                    </Button>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
