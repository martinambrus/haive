'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api-client';
import { Badge, Button } from '@/components/ui';

interface UpgradeStatusResponse {
  repositoryId: string;
  hasUpgradeAvailable: boolean;
  installedTemplateSetHash: string | null;
  currentTemplateSetHash: string;
  changedTemplateIds: string[];
  isOnboarded: boolean;
  installedHaiveVersion: string | null;
  currentHaiveVersion: string;
  hasInProgressUpgradeSession: boolean;
  hasPriorUpgrade: boolean;
}

export interface UpgradeAvailableBannerProps {
  repositoryId: string;
  repositoryName: string;
}

export function UpgradeAvailableBanner({
  repositoryId,
  repositoryName,
}: UpgradeAvailableBannerProps) {
  const router = useRouter();
  const [status, setStatus] = useState<UpgradeStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await api.get<UpgradeStatusResponse>(
          `/repositories/${repositoryId}/upgrade-status`,
        );
        if (!cancelled) setStatus(res);
      } catch (err) {
        if (!cancelled) setError((err as Error).message ?? 'Failed to check upgrade status');
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [repositoryId]);

  async function handleUpgrade() {
    if (submitting) return;
    setSubmitting(true);
    try {
      const res = await api.post<{ task: { id: string } }>('/tasks', {
        type: 'onboarding_upgrade',
        title: `Upgrade onboarding: ${repositoryName}`,
        description: 'Apply template updates from the current Haive release.',
        repositoryId,
      });
      router.push(`/tasks/${res.task.id}`);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to start upgrade');
      setSubmitting(false);
    }
  }

  async function handleRollback() {
    if (submitting) return;
    if (
      !confirm(
        `Roll back the most recent upgrade for ${repositoryName}? This will overwrite files with the prior versions and create a new task row.`,
      )
    ) {
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.post<{ taskId: string }>(
        `/repositories/${repositoryId}/rollback-upgrade`,
      );
      router.push(`/tasks/${res.taskId}`);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to start rollback');
      setSubmitting(false);
    }
  }

  if (error) {
    return <div className="text-xs text-red-400">Upgrade check: {error}</div>;
  }
  if (!status) return null;
  if (!status.isOnboarded) return null;

  const versionLine =
    status.installedHaiveVersion && status.installedHaiveVersion !== status.currentHaiveVersion
      ? `On v${status.installedHaiveVersion} → v${status.currentHaiveVersion}`
      : status.installedHaiveVersion
        ? `On v${status.installedHaiveVersion}`
        : null;

  if (status.hasUpgradeAvailable) {
    const primaryLabel = status.hasInProgressUpgradeSession ? 'Continue upgrade' : 'Review & apply';
    return (
      <div className="flex flex-wrap items-center gap-2 rounded border border-indigo-900 bg-indigo-950/40 px-3 py-2 text-sm">
        <Badge variant={status.hasInProgressUpgradeSession ? 'default' : 'warning'}>
          {status.hasInProgressUpgradeSession ? 'Upgrade in progress' : 'Upgrade available'}
        </Badge>
        <span className="text-neutral-300">
          {status.changedTemplateIds.length} template(s) changed
        </span>
        {versionLine && <span className="text-xs text-neutral-500">{versionLine}</span>}
        <div className="ml-auto flex gap-2">
          <Button size="sm" onClick={handleUpgrade} disabled={submitting}>
            {submitting ? 'Starting...' : primaryLabel}
          </Button>
          {status.hasPriorUpgrade && (
            <Button size="sm" variant="secondary" onClick={handleRollback} disabled={submitting}>
              Roll back last upgrade
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-xs text-neutral-400">
      <Badge variant="success">Up to date</Badge>
      <span>Template set {status.currentTemplateSetHash.slice(0, 8)}</span>
      {versionLine && <span>{versionLine}</span>}
      {status.hasPriorUpgrade && (
        <div className="ml-auto">
          <Button size="sm" variant="secondary" onClick={handleRollback} disabled={submitting}>
            Roll back last upgrade
          </Button>
        </div>
      )}
    </div>
  );
}
