'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  maintenanceApi,
  type BlockingResponse,
  type BlockingTask,
  type MaintenanceState,
  type UpgradeRun,
  type UpgradeStatusResponse,
} from '@/lib/api-client';
import { Badge, Button, Card, FormError, Input, Label } from '@/components/ui';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/dialog';
import { usePageTitle } from '@/lib/use-page-title';

/** The three states, in the order an operator walks them, each with what it actually does. Copy
 *  lives here rather than in the API because the API's job is to enforce them, not describe them. */
const STATES: { value: MaintenanceState; label: string; help: string }[] = [
  {
    value: 'normal',
    label: 'Normal',
    help: 'Everything runs. New tasks are accepted.',
  },
  {
    value: 'draining',
    label: 'Draining',
    help: 'No new tasks are accepted; work already running is left to finish. This is where you wait.',
  },
  {
    value: 'maintenance',
    label: 'Maintenance',
    help: 'Everyone except administrators is locked out. Use it once the list below is empty — or once you have decided not to wait for it.',
  },
];

const RUN_STATUS_VARIANT: Record<string, 'success' | 'warning' | 'error' | 'info'> = {
  done: 'success',
  running: 'info',
  rolled_back: 'warning',
  failed: 'error',
};

function shortTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

export default function MaintenancePage() {
  usePageTitle('Maintenance');

  const [state, setState] = useState<MaintenanceState | null>(null);
  const [blocking, setBlocking] = useState<BlockingResponse | null>(null);
  const [upgrade, setUpgrade] = useState<UpgradeStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [targetVersion, setTargetVersion] = useState('');
  const [force, setForce] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [launched, setLaunched] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, b, u] = await Promise.all([
        maintenanceApi.get(),
        maintenanceApi.blocking(),
        maintenanceApi.upgradeStatus(),
      ]);
      setState(s.state);
      setBlocking(b);
      setUpgrade(u);
      setError(null);
    } catch (err) {
      // Expected, and not a bug, once an upgrade reaches its verify phase: this api is one of the
      // containers being replaced. Say that rather than showing a bare fetch failure.
      setError(err instanceof Error ? err.message : 'could not read the maintenance state');
    }
  }, []);

  useEffect(() => {
    void load();
    // A drain is a waiting game and an upgrade moves through phases on its own, so both halves of
    // this page go stale on their own. 5s is cheap against three small reads.
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  async function changeState(next: MaintenanceState) {
    setBusy(true);
    try {
      await maintenanceApi.set(next);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not change the maintenance state');
    } finally {
      setBusy(false);
    }
  }

  async function act(task: BlockingTask, action: 'pause' | 'resume' | 'stop') {
    setBusy(true);
    try {
      await maintenanceApi.taskAction(task.id, action);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : `could not ${action} that task`);
    } finally {
      setBusy(false);
    }
  }

  async function startUpgrade() {
    setConfirming(false);
    setBusy(true);
    try {
      const res = await maintenanceApi.startUpgrade({ version: targetVersion.trim(), force });
      setLaunched(res.container);
      setError(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not start the upgrade');
    } finally {
      setBusy(false);
    }
  }

  const liveRun = upgrade?.runs.find((r) => r.status === 'running') ?? null;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-neutral-50">Maintenance &amp; upgrade</h2>
        <p className="max-w-3xl text-sm text-neutral-400">
          Hold the system, see whose work is holding it open, and install a new release. An upgrade
          drains, snapshots the database, migrates, and only keeps the new version once the new
          containers report it — anything that fails before that point rolls back.
        </p>
      </div>

      <FormError message={error} />

      <Card className="space-y-4 p-5">
        <div className="flex items-center gap-3">
          <h3 className="text-base font-semibold text-neutral-100">System state</h3>
          {state ? (
            <Badge variant={state === 'normal' ? 'success' : 'warning'}>{state}</Badge>
          ) : null}
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          {STATES.map((s) => (
            <button
              key={s.value}
              type="button"
              disabled={busy || state === s.value}
              onClick={() => void changeState(s.value)}
              className={`rounded-lg border p-3 text-left transition ${
                state === s.value
                  ? 'border-indigo-500 bg-indigo-950/30'
                  : 'border-neutral-800 hover:border-neutral-700'
              } disabled:cursor-default`}
            >
              <div className="text-sm font-medium text-neutral-100">{s.label}</div>
              <div className="mt-1 text-xs text-neutral-400">{s.help}</div>
            </button>
          ))}
        </div>
      </Card>

      <Card className="space-y-4 p-5">
        <div className="flex items-center gap-3">
          <h3 className="text-base font-semibold text-neutral-100">Work still running</h3>
          <Badge variant={blocking && blocking.total > 0 ? 'warning' : 'success'}>
            {blocking ? blocking.total : '—'}
          </Badge>
        </div>
        {blocking?.capped ? (
          <p className="text-xs text-amber-400">
            Showing the first {blocking.tasks.length}. There is more behind this list — it is not
            the whole picture.
          </p>
        ) : null}
        {blocking && blocking.tasks.length === 0 ? (
          <p className="text-sm text-neutral-400">Nothing is running. It is safe to upgrade.</p>
        ) : null}
        <div className="space-y-2">
          {blocking?.tasks.map((t) => (
            <div
              key={t.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-800 p-3"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    href={`/tasks/${t.id}`}
                    className="truncate text-sm font-medium text-neutral-100 hover:underline"
                  >
                    {t.title || t.id}
                  </Link>
                  <Badge>{t.status}</Badge>
                  {/* The distinction that decides whether to wait or to act. */}
                  {t.hasLiveCli ? <Badge variant="info">CLI running</Badge> : null}
                  {t.pausedAt ? <Badge variant="warning">paused</Badge> : null}
                </div>
                <div className="mt-1 text-xs text-neutral-500">
                  {t.ownerName ?? t.ownerEmail ?? 'unknown owner'}
                  {t.currentStepId ? ` · ${t.currentStepId}` : ''} · {shortTime(t.updatedAt)}
                </div>
              </div>
              <div className="flex gap-2">
                {t.pausedAt ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void act(t, 'resume')}
                  >
                    Resume
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void act(t, 'pause')}
                  >
                    Pause
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy || !t.hasLiveCli}
                  onClick={() => void act(t, 'stop')}
                >
                  Stop CLI
                </Button>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card className="space-y-4 p-5">
        <div className="flex items-center gap-3">
          <h3 className="text-base font-semibold text-neutral-100">Upgrade</h3>
          {upgrade ? <Badge>current {upgrade.version}</Badge> : null}
        </div>

        {upgrade && !upgrade.canUpgrade ? (
          <div className="rounded-md border border-neutral-800 bg-neutral-950 p-3 text-sm text-neutral-400">
            {upgrade.devBuild ? (
              <>
                This is a development build. It builds its images from the source tree, so there is
                no published release to swap to — upgrade by pulling the branch and rebuilding.
              </>
            ) : (
              <>
                This install cannot upgrade itself from here:{' '}
                <code className="text-neutral-300">HAIVE_INSTALL_DIR_HOST</code> is not set, so the
                updater cannot be told where the install lives on the host. Add it to the{' '}
                <code className="text-neutral-300">.env</code> beside{' '}
                <code className="text-neutral-300">docker-compose.yml</code> and recreate the api,
                or run <code className="text-neutral-300">haive upgrade</code> on the host.
              </>
            )}
          </div>
        ) : null}

        {upgrade?.canUpgrade ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <Label htmlFor="target-version">Version to install</Label>
                <Input
                  id="target-version"
                  className="w-40"
                  placeholder="0.2.0"
                  value={targetVersion}
                  onChange={(e) => setTargetVersion(e.target.value)}
                  disabled={busy || liveRun !== null}
                />
              </div>
              <label className="flex items-center gap-2 pb-2 text-sm text-neutral-300">
                <input
                  type="checkbox"
                  checked={force}
                  onChange={(e) => setForce(e.target.checked)}
                  disabled={busy || liveRun !== null}
                />
                Stop running work if it has not finished draining
              </label>
              <Button
                className="mb-1"
                disabled={busy || liveRun !== null || targetVersion.trim().length === 0}
                onClick={() => setConfirming(true)}
              >
                Start upgrade
              </Button>
            </div>
            <p className="text-xs text-neutral-500">
              Releases are listed on GitHub. The version is the release tag, with or without its
              leading <code>v</code>.
            </p>
          </div>
        ) : null}

        {launched ? (
          <div className="rounded-md border border-sky-900 bg-sky-950/40 px-3 py-2 text-sm text-sky-300">
            The updater is running as container{' '}
            <code className="text-sky-200">{launched.slice(0, 12)}</code>. This page will stop
            responding while the api is replaced — that is the upgrade working. Reload once it comes
            back; <code className="text-sky-200">docker logs</code> on that container is the full
            narrative either way.
          </div>
        ) : null}

        <div className="space-y-2">
          <h3 className="text-sm font-medium text-neutral-300">History</h3>
          {upgrade && upgrade.runs.length === 0 ? (
            <p className="text-sm text-neutral-500">This install has never been upgraded.</p>
          ) : null}
          {upgrade?.runs.map((r: UpgradeRun) => (
            <div
              key={r.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-neutral-800 p-3 text-sm"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={RUN_STATUS_VARIANT[r.status] ?? 'default'}>{r.status}</Badge>
                <span className="text-neutral-200">
                  {r.from_version} → {r.to_version}
                </span>
                <span className="text-neutral-500">phase {r.phase}</span>
              </div>
              <div className="text-xs text-neutral-500">
                {shortTime(r.started_at)}
                {r.ended_at ? ` → ${shortTime(r.ended_at)}` : ''}
              </div>
              {r.error ? <div className="w-full text-xs text-red-400">{r.error}</div> : null}
            </div>
          ))}
        </div>
      </Card>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Upgrade to {targetVersion.trim()}?</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm text-neutral-300">
            <p>
              The system will be put into maintenance, the database snapshotted, and the new release
              installed. Everyone is locked out until it finishes.
            </p>
            <p className="text-neutral-400">
              {force
                ? 'Work still running when the drain deadline passes will be stopped.'
                : 'If work is still running when the drain deadline passes, the upgrade fails and undoes itself rather than stopping anyone.'}
            </p>
            <p className="text-neutral-400">
              Anything that fails before the new containers report {targetVersion.trim()} rolls back
              to {upgrade?.version}.
            </p>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button onClick={() => void startUpgrade()}>Upgrade</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
