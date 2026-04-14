'use client';

import { useEffect, useState } from 'react';
import { api, type FilesystemListing } from '@/lib/api-client';
import { Button, Badge } from '@/components/ui';

interface FilesystemBrowserProps {
  initialPath?: string;
  onSelect: (path: string, hasGit: boolean) => void;
  selectedPath?: string | null;
}

export function FilesystemBrowser({ initialPath, onSelect, selectedPath }: FilesystemBrowserProps) {
  const [path, setPath] = useState<string | null>(initialPath ?? null);
  const [listing, setListing] = useState<FilesystemListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const query = path ? `?path=${encodeURIComponent(path)}` : '';
    api
      .get<FilesystemListing>(`/filesystem${query}`)
      .then((data) => {
        if (cancelled) return;
        setListing(data);
        if (!path) setPath(data.path);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message ?? 'Failed to load directory');
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [path]);

  if (error) {
    return (
      <div className="rounded-md border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">
        {error}
      </div>
    );
  }

  if (!listing) {
    return <div className="text-sm text-neutral-500">Loading...</div>;
  }

  const visibleEntries = listing.entries.filter((e) => showHidden || !e.hidden);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="truncate text-xs text-neutral-400">{listing.path}</div>
        <label className="flex items-center gap-1 text-xs text-neutral-400">
          <input
            type="checkbox"
            checked={showHidden}
            onChange={(e) => setShowHidden(e.target.checked)}
          />
          Show hidden
        </label>
      </div>
      <div className="max-h-80 overflow-y-auto rounded-md border border-neutral-800 bg-neutral-950">
        {listing.parent && (
          <button
            type="button"
            onClick={() => setPath(listing.parent)}
            className="flex w-full items-center gap-2 border-b border-neutral-800 px-3 py-2 text-left text-sm text-neutral-300 hover:bg-neutral-900"
          >
            <span className="text-neutral-500">..</span>
            <span>Parent directory</span>
          </button>
        )}
        {visibleEntries.length === 0 && (
          <div className="px-3 py-4 text-center text-xs text-neutral-500">(empty directory)</div>
        )}
        {visibleEntries.map((entry) => {
          const isSelected = selectedPath === entry.path;
          return (
            <div
              key={entry.path}
              className={`flex items-center justify-between gap-2 border-b border-neutral-800 px-3 py-2 text-sm last:border-b-0 ${
                isSelected ? 'bg-indigo-950/50' : 'hover:bg-neutral-900'
              }`}
            >
              <button
                type="button"
                onClick={() => entry.isDirectory && setPath(entry.path)}
                disabled={!entry.isDirectory}
                className="flex flex-1 items-center gap-2 text-left disabled:cursor-default"
              >
                <span className="text-neutral-500">{entry.isDirectory ? 'dir' : 'file'}</span>
                <span className="truncate text-neutral-200">{entry.name}</span>
                {entry.hasGit && <Badge variant="success">.git</Badge>}
              </button>
              {entry.isDirectory && entry.hasGit && (
                <Button
                  type="button"
                  size="sm"
                  variant={isSelected ? 'primary' : 'secondary'}
                  onClick={() => onSelect(entry.path, true)}
                >
                  {isSelected ? 'Selected' : 'Pick'}
                </Button>
              )}
            </div>
          );
        })}
      </div>
      {loading && <div className="text-xs text-neutral-500">Loading...</div>}
    </div>
  );
}
