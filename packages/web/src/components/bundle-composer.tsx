'use client';

import { useEffect, useRef, useState } from 'react';
import type {
  BundleComposerCredentialOption,
  BundleComposerInitial,
  CreateGitBundleRequest,
  InitBundleUploadRequest,
} from '@haive/shared';
import { Button, FormError, Input, Label } from '@/components/ui';
import { API_BASE_URL } from '@/lib/api-client';

/** Bundle row threaded through the form's value array. Mirrors what
 *  06_3-custom-bundles.apply expects: an `id` is enough — the worker
 *  re-loads the full record from `custom_bundles` by id. */
export interface BundleComposerEntry {
  id: string;
  name: string;
  sourceType: 'zip' | 'git';
  status: 'active' | 'syncing' | 'failed';
  itemCount: number;
}

interface BundleComposerProps {
  initialBundles: BundleComposerInitial[];
  allowAddZip: boolean;
  allowAddGit: boolean;
  credentialOptions: BundleComposerCredentialOption[];
  /** Repository the new bundles will be bound to. Required because the
   *  /api/bundles endpoints all expect `repositoryId`. */
  repositoryId: string;
  value: BundleComposerEntry[];
  onChange: (next: BundleComposerEntry[]) => void;
  disabled?: boolean;
}

const CHUNK_SIZE = 4 * 1024 * 1024;

function isArchiveExt(name: string): 'zip' | 'tar' | 'tar.gz' | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar.gz';
  if (lower.endsWith('.tar')) return 'tar';
  if (lower.endsWith('.zip')) return 'zip';
  return null;
}

function summaryFromInitial(b: BundleComposerInitial): BundleComposerEntry {
  return {
    id: b.id,
    name: b.name,
    sourceType: b.sourceType,
    status: b.status,
    itemCount: b.itemCount,
  };
}

interface BundleFileEntry {
  path: string;
  size: number;
}

interface BundleFilesState {
  loading: boolean;
  files: BundleFileEntry[];
  truncated: boolean;
  error: string | null;
}

interface FileNode {
  name: string;
  isDir: boolean;
  size?: number;
  children: FileNode[];
}

function buildFileTree(files: BundleFileEntry[]): FileNode {
  const root: FileNode = { name: '', isDir: true, children: [] };
  for (const f of files) {
    const parts = f.path.split('/').filter((p) => p.length > 0);
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
      const isLeaf = i === parts.length - 1;
      let child = cur.children.find((c) => c.name === parts[i]);
      if (!child) {
        child = isLeaf
          ? { name: parts[i]!, isDir: false, size: f.size, children: [] }
          : { name: parts[i]!, isDir: true, children: [] };
        cur.children.push(child);
      }
      if (!isLeaf) cur = child;
    }
  }
  const sortRec = (n: FileNode): void => {
    n.children.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    n.children.forEach(sortRec);
  };
  sortRec(root);
  return root;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function FileTreeView({ node, depth }: { node: FileNode; depth: number }) {
  if (node.children.length === 0) return null;
  return (
    <ul className="m-0 list-none p-0">
      {node.children.map((child) => (
        <li key={`${depth}:${child.name}`} className="flex flex-col">
          <span
            className="flex items-baseline gap-2 font-mono text-xs"
            style={{ paddingLeft: `${depth * 12}px` }}
          >
            <span className={child.isDir ? 'text-indigo-300' : 'text-neutral-300'}>
              {child.isDir ? `${child.name}/` : child.name}
            </span>
            {!child.isDir && child.size !== undefined && (
              <span className="text-neutral-500">{formatBytes(child.size)}</span>
            )}
          </span>
          {child.isDir && <FileTreeView node={child} depth={depth + 1} />}
        </li>
      ))}
    </ul>
  );
}

export function BundleComposer({
  initialBundles,
  allowAddZip,
  allowAddGit,
  credentialOptions,
  repositoryId,
  value,
  onChange,
  disabled = false,
}: BundleComposerProps) {
  const [error, setError] = useState<string | null>(null);
  const [showGitForm, setShowGitForm] = useState(false);
  const [showZipForm, setShowZipForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ name: string; pct: number } | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [filesByBundle, setFilesByBundle] = useState<Record<string, BundleFilesState>>({});

  const loadBundleFiles = async (bundleId: string): Promise<void> => {
    setFilesByBundle((prev) => ({
      ...prev,
      [bundleId]: { loading: true, files: [], truncated: false, error: null },
    }));
    try {
      const res = await fetch(`${API_BASE_URL}/bundles/${bundleId}/files`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`files fetch failed (${res.status})`);
      const data = (await res.json()) as { files: BundleFileEntry[]; truncated: boolean };
      setFilesByBundle((prev) => ({
        ...prev,
        [bundleId]: { loading: false, files: data.files, truncated: data.truncated, error: null },
      }));
    } catch (err) {
      setFilesByBundle((prev) => ({
        ...prev,
        [bundleId]: {
          loading: false,
          files: [],
          truncated: false,
          error: err instanceof Error ? err.message : String(err),
        },
      }));
    }
  };

  const toggleExpanded = (bundleId: string): void => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(bundleId)) {
        next.delete(bundleId);
      } else {
        next.add(bundleId);
        if (!filesByBundle[bundleId]) void loadBundleFiles(bundleId);
      }
      return next;
    });
  };

  // Hydrate the initial value once when the field mounts and the form's
  // initial state is empty. The mount-fetch effect below replaces this with
  // authoritative state once the API responds.
  if (value.length === 0 && initialBundles.length > 0) {
    onChange(initialBundles.map(summaryFromInitial));
  }

  // Authoritative state lives in the API. The form's `initialBundles` is
  // captured at step `detect` time and goes stale when the user adds or
  // removes bundles before submitting (and on every page reload). Fetch on
  // mount, then poll while anything is `syncing`. Refs avoid re-subscribing
  // on every value change.
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    let cancelled = false;
    let handle: ReturnType<typeof setInterval> | null = null;

    const fetchOnce = async (): Promise<void> => {
      try {
        const res = await fetch(
          `${API_BASE_URL}/bundles?repositoryId=${encodeURIComponent(repositoryId)}`,
          { credentials: 'include' },
        );
        if (!res.ok || cancelled) return;
        const { bundles } = (await res.json()) as {
          bundles: Array<{
            id: string;
            name: string;
            sourceType: 'zip' | 'git';
            status: 'active' | 'syncing' | 'failed';
            itemCounts?: { agent?: number; skill?: number };
          }>;
        };
        if (cancelled) return;
        const next: BundleComposerEntry[] = bundles.map((b) => ({
          id: b.id,
          name: b.name,
          sourceType: b.sourceType,
          status: b.status,
          itemCount: (b.itemCounts?.agent ?? 0) + (b.itemCounts?.skill ?? 0),
        }));
        const current = valueRef.current;
        const same =
          next.length === current.length &&
          next.every((n, i) => {
            const v = current[i];
            return (
              v &&
              v.id === n.id &&
              v.status === n.status &&
              v.itemCount === n.itemCount &&
              v.name === n.name
            );
          });
        if (!same) onChangeRef.current(next);
      } catch {
        // Transient network error — keep polling.
      }
    };

    void fetchOnce();
    handle = setInterval(() => void fetchOnce(), 2500);
    return () => {
      cancelled = true;
      if (handle) clearInterval(handle);
    };
  }, [repositoryId]);

  const removeBundle = async (entry: BundleComposerEntry) => {
    if (disabled || busy) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE_URL}/bundles/${entry.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`delete failed (${res.status})`);
      onChange(value.filter((v) => v.id !== entry.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const resyncGitBundle = async (entry: BundleComposerEntry) => {
    if (disabled || busy) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE_URL}/bundles/${entry.id}/sync`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`resync failed (${res.status})`);
      onChange(value.map((v) => (v.id === entry.id ? { ...v, status: 'syncing' } : v)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const replaceZipBundle = async (entry: BundleComposerEntry, file: File) => {
    if (disabled || busy) return;
    setError(null);
    setBusy(true);
    setUploadProgress({ name: file.name, pct: 0 });
    try {
      const fmt = isArchiveExt(file.name);
      if (!fmt) throw new Error('only .zip / .tar / .tar.gz / .tgz supported');
      const initRes = await fetch(`${API_BASE_URL}/bundles/${entry.id}/replace/init`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          filename: file.name,
          totalSize: file.size,
          chunkSize: CHUNK_SIZE,
        }),
      });
      if (!initRes.ok) throw new Error(`replace init failed (${initRes.status})`);
      const { session } = await initRes.json();
      const uploadId = session.id;
      let offset = 0;
      while (offset < file.size) {
        const end = Math.min(offset + CHUNK_SIZE, file.size);
        const chunk = file.slice(offset, end);
        const chunkRes = await fetch(`${API_BASE_URL}/bundles/uploads/${uploadId}/chunk`, {
          method: 'PUT',
          credentials: 'include',
          headers: {
            'content-type': 'application/octet-stream',
            'content-range': `bytes ${offset}-${end - 1}/${file.size}`,
          },
          body: chunk,
        });
        if (!chunkRes.ok) throw new Error(`chunk upload failed (${chunkRes.status})`);
        offset = end;
        setUploadProgress({ name: file.name, pct: Math.round((offset / file.size) * 100) });
      }
      const completeRes = await fetch(
        `${API_BASE_URL}/bundles/${entry.id}/replace/${uploadId}/complete`,
        { method: 'POST', credentials: 'include' },
      );
      if (!completeRes.ok) throw new Error(`replace complete failed (${completeRes.status})`);
      onChange(
        value.map((v) => (v.id === entry.id ? { ...v, status: 'syncing', itemCount: 0 } : v)),
      );
      // Drop cached file listing — it'll re-fetch on next expand.
      setFilesByBundle((prev) => {
        const next = { ...prev };
        delete next[entry.id];
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setUploadProgress(null);
    }
  };

  const submitGitBundle = async (form: {
    name: string;
    gitUrl: string;
    gitBranch: string;
    gitCredentialsId: string;
    enabledKinds: ('agent' | 'skill')[];
  }) => {
    setError(null);
    setBusy(true);
    try {
      const body: CreateGitBundleRequest = {
        repositoryId,
        name: form.name,
        enabledKinds: form.enabledKinds,
        gitUrl: form.gitUrl,
        ...(form.gitBranch ? { gitBranch: form.gitBranch } : {}),
        ...(form.gitCredentialsId ? { gitCredentialsId: form.gitCredentialsId } : {}),
      };
      const res = await fetch(`${API_BASE_URL}/bundles`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`git bundle create failed (${res.status})`);
      const { bundle: created } = await res.json();
      onChange([
        ...value,
        {
          id: created.id,
          name: created.name,
          sourceType: 'git',
          status: created.status ?? 'syncing',
          itemCount: 0,
        },
      ]);
      setShowGitForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const uploadZipBundle = async (file: File, name: string, enabledKinds: ('agent' | 'skill')[]) => {
    setError(null);
    setBusy(true);
    setUploadProgress({ name: file.name, pct: 0 });
    try {
      const fmt = isArchiveExt(file.name);
      if (!fmt) throw new Error('only .zip / .tar / .tar.gz / .tgz supported');
      const initBody: InitBundleUploadRequest = {
        repositoryId,
        name,
        enabledKinds,
        filename: file.name,
        totalSize: file.size,
        chunkSize: CHUNK_SIZE,
      };
      const initRes = await fetch(`${API_BASE_URL}/bundles/uploads/init`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(initBody),
      });
      if (!initRes.ok) throw new Error(`upload init failed (${initRes.status})`);
      const { session } = await initRes.json();
      const uploadId = session.id;
      let offset = 0;
      while (offset < file.size) {
        const end = Math.min(offset + CHUNK_SIZE, file.size);
        const chunk = file.slice(offset, end);
        const chunkRes = await fetch(`${API_BASE_URL}/bundles/uploads/${uploadId}/chunk`, {
          method: 'PUT',
          credentials: 'include',
          headers: {
            'content-type': 'application/octet-stream',
            'content-range': `bytes ${offset}-${end - 1}/${file.size}`,
          },
          body: chunk,
        });
        if (!chunkRes.ok) throw new Error(`chunk upload failed (${chunkRes.status})`);
        offset = end;
        setUploadProgress({ name: file.name, pct: Math.round((offset / file.size) * 100) });
      }
      const completeRes = await fetch(`${API_BASE_URL}/bundles/uploads/${uploadId}/complete`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!completeRes.ok) throw new Error(`upload complete failed (${completeRes.status})`);
      const { bundle: created } = await completeRes.json();
      onChange([
        ...value,
        {
          id: created.id,
          name: created.name,
          sourceType: 'zip',
          status: created.status ?? 'syncing',
          itemCount: 0,
        },
      ]);
      setShowZipForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setUploadProgress(null);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {value.length === 0 ? (
        <p className="text-sm text-neutral-400">No bundles configured for this repository yet.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {value.map((entry) => {
            const isExpanded = expandedIds.has(entry.id);
            const fileState = filesByBundle[entry.id];
            return (
              <li
                key={entry.id}
                className="flex flex-col rounded-md border border-neutral-800 bg-neutral-950"
              >
                <div className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                  <button
                    type="button"
                    onClick={() => toggleExpanded(entry.id)}
                    className="flex flex-1 items-center gap-2 text-left"
                  >
                    <span
                      className="inline-block w-3 select-none text-neutral-500"
                      aria-hidden="true"
                    >
                      {isExpanded ? '▾' : '▸'}
                    </span>
                    <span className="rounded bg-indigo-900/60 px-1.5 py-0.5 text-[10px] uppercase text-indigo-300">
                      {entry.sourceType}
                    </span>
                    <span className="text-neutral-100">{entry.name}</span>
                    <span className="text-neutral-500">— {entry.itemCount} item(s)</span>
                    {entry.status !== 'active' && (
                      <span className="rounded bg-amber-900/60 px-1.5 py-0.5 text-[10px] text-amber-300">
                        {entry.status}
                      </span>
                    )}
                  </button>
                  {entry.sourceType === 'git' && (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => resyncGitBundle(entry)}
                      disabled={disabled || busy || entry.status === 'syncing'}
                    >
                      Resync
                    </Button>
                  )}
                  {entry.sourceType === 'zip' && (
                    <label
                      className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-md bg-transparent px-4 text-sm font-medium text-neutral-100 transition-colors hover:bg-neutral-800"
                      aria-disabled={disabled || busy}
                    >
                      Replace ZIP
                      <input
                        type="file"
                        accept=".zip,.tar,.tar.gz,.tgz"
                        className="hidden"
                        disabled={disabled || busy}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          // Reset so the same file can be picked twice.
                          e.target.value = '';
                          if (f) void replaceZipBundle(entry, f);
                        }}
                      />
                    </label>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => removeBundle(entry)}
                    disabled={disabled || busy}
                  >
                    Remove
                  </Button>
                </div>
                {isExpanded && (
                  <div className="border-t border-neutral-800 px-3 py-2">
                    {fileState?.loading && (
                      <p className="text-xs text-neutral-500">Loading files…</p>
                    )}
                    {fileState?.error && (
                      <p className="text-xs text-red-400">Error: {fileState.error}</p>
                    )}
                    {fileState && !fileState.loading && !fileState.error && (
                      <>
                        {fileState.files.length === 0 ? (
                          <p className="text-xs text-neutral-500">
                            (bundle is empty or not yet extracted)
                          </p>
                        ) : (
                          <FileTreeView node={buildFileTree(fileState.files)} depth={0} />
                        )}
                        {fileState.truncated && (
                          <p className="mt-1 text-xs text-amber-400">
                            Showing first 5000 entries — bundle has more files.
                          </p>
                        )}
                      </>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {uploadProgress && (
        <p className="text-xs text-neutral-400">
          Uploading {uploadProgress.name}… {uploadProgress.pct}%
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {allowAddGit && !showGitForm && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => setShowGitForm(true)}
            disabled={disabled || busy}
          >
            Add git bundle
          </Button>
        )}
        {allowAddZip && !showZipForm && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => setShowZipForm(true)}
            disabled={disabled || busy}
          >
            Add ZIP bundle
          </Button>
        )}
      </div>

      {showGitForm && (
        <GitBundleForm
          credentialOptions={credentialOptions}
          onCancel={() => setShowGitForm(false)}
          onSubmit={submitGitBundle}
          disabled={disabled || busy}
        />
      )}
      {showZipForm && (
        <ZipBundleForm
          onCancel={() => setShowZipForm(false)}
          onSubmit={uploadZipBundle}
          disabled={disabled || busy}
        />
      )}

      <FormError message={error} />
    </div>
  );
}

function GitBundleForm({
  credentialOptions,
  onCancel,
  onSubmit,
  disabled,
}: {
  credentialOptions: BundleComposerCredentialOption[];
  onCancel: () => void;
  onSubmit: (form: {
    name: string;
    gitUrl: string;
    gitBranch: string;
    gitCredentialsId: string;
    enabledKinds: ('agent' | 'skill')[];
  }) => void;
  disabled: boolean;
}) {
  const [name, setName] = useState('');
  const [gitUrl, setGitUrl] = useState('');
  const [gitBranch, setGitBranch] = useState('');
  const [gitCredentialsId, setGitCredentialsId] = useState('');
  const [includeAgents, setIncludeAgents] = useState(true);
  const [includeSkills, setIncludeSkills] = useState(true);

  const enabledKinds: ('agent' | 'skill')[] = [
    ...(includeAgents ? (['agent'] as const) : []),
    ...(includeSkills ? (['skill'] as const) : []),
  ];
  const canSubmit = name.trim().length > 0 && gitUrl.trim().length > 0 && enabledKinds.length > 0;

  return (
    <div className="flex flex-col gap-2 rounded-md border border-neutral-800 bg-neutral-950 p-3">
      <Label htmlFor="bundle-git-name">Name</Label>
      <Input
        id="bundle-git-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={disabled}
      />
      <Label htmlFor="bundle-git-url">Git URL</Label>
      <Input
        id="bundle-git-url"
        value={gitUrl}
        onChange={(e) => setGitUrl(e.target.value)}
        placeholder="https://example.com/owner/repo.git"
        disabled={disabled}
      />
      <Label htmlFor="bundle-git-branch">Branch (optional)</Label>
      <Input
        id="bundle-git-branch"
        value={gitBranch}
        onChange={(e) => setGitBranch(e.target.value)}
        disabled={disabled}
      />
      {credentialOptions.length > 0 && (
        <>
          <Label htmlFor="bundle-git-cred">Credentials (optional)</Label>
          <select
            id="bundle-git-cred"
            value={gitCredentialsId}
            onChange={(e) => setGitCredentialsId(e.target.value)}
            disabled={disabled}
            className="h-10 w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 text-sm text-neutral-100"
          >
            <option value="">(public repo / no auth)</option>
            {credentialOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </>
      )}
      <div className="flex gap-3 text-sm text-neutral-300">
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={includeAgents}
            onChange={(e) => setIncludeAgents(e.target.checked)}
            disabled={disabled}
          />
          agents
        </label>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={includeSkills}
            onChange={(e) => setIncludeSkills(e.target.checked)}
            disabled={disabled}
          />
          skills
        </label>
      </div>
      <div className="mt-1 flex gap-2">
        <Button
          type="button"
          onClick={() =>
            onSubmit({
              name: name.trim(),
              gitUrl: gitUrl.trim(),
              gitBranch: gitBranch.trim(),
              gitCredentialsId,
              enabledKinds,
            })
          }
          disabled={disabled || !canSubmit}
        >
          Create
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={disabled}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function ZipBundleForm({
  onCancel,
  onSubmit,
  disabled,
}: {
  onCancel: () => void;
  onSubmit: (file: File, name: string, enabledKinds: ('agent' | 'skill')[]) => void;
  disabled: boolean;
}) {
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [includeAgents, setIncludeAgents] = useState(true);
  const [includeSkills, setIncludeSkills] = useState(true);

  const enabledKinds: ('agent' | 'skill')[] = [
    ...(includeAgents ? (['agent'] as const) : []),
    ...(includeSkills ? (['skill'] as const) : []),
  ];
  const canSubmit = name.trim().length > 0 && file !== null && enabledKinds.length > 0;

  return (
    <div className="flex flex-col gap-2 rounded-md border border-neutral-800 bg-neutral-950 p-3">
      <Label htmlFor="bundle-zip-name">Name</Label>
      <Input
        id="bundle-zip-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={disabled}
      />
      <Label htmlFor="bundle-zip-file">Archive (.zip / .tar / .tar.gz / .tgz)</Label>
      <input
        id="bundle-zip-file"
        type="file"
        accept=".zip,.tar,.tar.gz,.tgz"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        disabled={disabled}
        className="block w-full text-sm text-neutral-300 file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-indigo-500 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-indigo-400 disabled:file:cursor-not-allowed disabled:file:bg-indigo-700 disabled:file:opacity-70"
      />
      <div className="flex gap-3 text-sm text-neutral-300">
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={includeAgents}
            onChange={(e) => setIncludeAgents(e.target.checked)}
            disabled={disabled}
          />
          agents
        </label>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={includeSkills}
            onChange={(e) => setIncludeSkills(e.target.checked)}
            disabled={disabled}
          />
          skills
        </label>
      </div>
      <div className="mt-1 flex gap-2">
        <Button
          type="button"
          onClick={() => file && onSubmit(file, name.trim(), enabledKinds)}
          disabled={disabled || !canSubmit}
        >
          Upload
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={disabled}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
