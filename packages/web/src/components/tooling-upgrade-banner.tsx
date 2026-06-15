'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api-client';
import { Badge, Button } from '@/components/ui';

interface ToolingComponentStatus {
  component: string;
  displayName: string;
  installed: string | null;
  latest: string | null;
  upgradeAvailable: boolean;
}

interface ToolingUpgradeStatusResponse {
  repositoryId: string;
  hasUpgradeAvailable: boolean;
  components: ToolingComponentStatus[];
}

interface ToolingUpgradeApplyResponse {
  applied: { component: string; from: string; to: string }[];
}

export interface ToolingUpgradeBannerProps {
  repositoryId: string;
}

export function ToolingUpgradeBanner({ repositoryId }: ToolingUpgradeBannerProps) {
  const [status, setStatus] = useState<ToolingUpgradeStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [appliedMsg, setAppliedMsg] = useState<string | null>(null);

  async function load() {
    try {
      const res = await api.get<ToolingUpgradeStatusResponse>(
        `/repositories/${repositoryId}/tooling-upgrade-status`,
      );
      setStatus(res);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to check tooling upgrades');
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function run() {
      try {
        const res = await api.get<ToolingUpgradeStatusResponse>(
          `/repositories/${repositoryId}/tooling-upgrade-status`,
        );
        if (!cancelled) setStatus(res);
      } catch (err) {
        if (!cancelled) setError((err as Error).message ?? 'Failed to check tooling upgrades');
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [repositoryId]);

  async function handleApply() {
    if (applying) return;
    setApplying(true);
    setError(null);
    setAppliedMsg(null);
    try {
      // Empty body = apply every available component upgrade. This only bumps
      // the repo's version pins; the env image rebuilds on the repo's next task.
      const res = await api.post<ToolingUpgradeApplyResponse>(
        `/repositories/${repositoryId}/tooling-upgrade`,
        {},
      );
      const n = res.applied?.length ?? 0;
      setAppliedMsg(
        n > 0
          ? `Upgraded ${n} component${n === 1 ? '' : 's'} — the environment rebuilds on the next task.`
          : 'Nothing to apply.',
      );
      await load();
    } catch (err) {
      setError((err as Error).message ?? 'Failed to apply tooling upgrades');
    } finally {
      setApplying(false);
    }
  }

  if (error) return <div className="text-xs text-red-400">Tooling upgrade check: {error}</div>;
  if (!status) return null;

  // Up-to-date (incl. right after a successful apply): keep a compact row so the
  // "Manage tooling" link stays reachable and the apply result is visible,
  // mirroring the workflow upgrade banner's up-to-date state.
  if (!status.hasUpgradeAvailable) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-xs text-neutral-400">
        <Badge variant="success">Tooling up to date</Badge>
        {appliedMsg && <span className="text-emerald-400">{appliedMsg}</span>}
        <Link
          href={`/repos/${repositoryId}/tooling`}
          className="ml-auto text-indigo-300 hover:underline"
        >
          Manage tooling
        </Link>
      </div>
    );
  }

  const upgrades = status.components.filter((c) => c.upgradeAvailable);
  return (
    <div className="flex flex-col gap-1 rounded border border-amber-900 bg-amber-950/30 px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="warning">Tooling upgrades available</Badge>
        <span className="text-neutral-300">
          {upgrades.length} component{upgrades.length === 1 ? '' : 's'}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" onClick={handleApply} disabled={applying}>
            {applying ? 'Applying...' : 'Apply upgrades'}
          </Button>
          <Link
            href={`/repos/${repositoryId}/tooling`}
            className="text-xs text-indigo-300 hover:underline"
          >
            Manage tooling
          </Link>
        </div>
      </div>
      <ul className="mt-1 flex flex-col gap-0.5 text-xs text-neutral-400">
        {upgrades.map((c) => (
          <li key={c.component}>
            <span className="text-neutral-200">{c.displayName}</span>: {c.installed} → {c.latest}
          </li>
        ))}
      </ul>
      <p className="text-xs text-neutral-500">
        Bumps this repo&apos;s version pins; the environment image rebuilds on the next task run.
      </p>
    </div>
  );
}
