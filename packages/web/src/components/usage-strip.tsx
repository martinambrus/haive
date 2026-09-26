'use client';

import { useEffect, useState } from 'react';
import { type CliProviderName, type Task } from '@/lib/api-client';
import { CLI_USAGE_LABEL } from '@/lib/usage-format';
import { UsageBars, usageTooltip, usageWindowsOf } from '@/components/usage-meter';
import { selectStripMeters } from '@/components/usage-strip-select';
import { UsagePendingChip, UsageReconnectAction } from '@/components/usage-reconnect-action';
import { refreshUsageWindow, useUsageWindow } from '@/lib/use-usage-window';

/** Subscription meters above the task list: how much allowance is left on each CLI the
 *  VISIBLE rows use, so the answer to "can these tasks still run?" is on the page you are
 *  already looking at. One meter per subscription, not per task — the same Claude login
 *  backs 25 provider rows, and repeating its number down the list would say nothing extra.
 *
 *  Reads the page's one usage poll (~60s), not the list's 3s cadence: the worker's usage poller
 *  only writes every ~5 minutes, so anything faster is wasted requests against a number
 *  that has not moved. Renders nothing until it has both the rows and a readable snapshot. */
export function UsageStrip({ tasks }: { tasks: readonly Task[] | null }) {
  const usage = useUsageWindow();
  const snapshots = usage?.snapshots ?? null;
  const allowanceKeys = usage?.alert?.allowanceKeys;
  const [now, setNow] = useState(() => Date.now());

  // Only drives the relative reset labels ("resets 19:30"), so a slow tick is plenty.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const meters = selectStripMeters(tasks, snapshots, allowanceKeys);
  if (meters.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
      {meters.map(({ allowanceKey, snapshot, status }) => {
        const providerName = snapshot.providerName as CliProviderName;
        const name = CLI_USAGE_LABEL[providerName] ?? snapshot.providerName;
        // Dead token: the numbers are gone and only a user action brings them back, so say so
        // here rather than leaving the strip blank on the page the user is already looking at.
        if (status === 'pending') {
          return (
            <UsagePendingChip
              key={allowanceKey}
              displayName={name}
              className="flex shrink-0 items-center gap-1 font-mono text-xs font-semibold text-neutral-400"
            />
          );
        }
        if (status === 'needs_reconnect') {
          return (
            <UsageReconnectAction
              key={allowanceKey}
              providerId={snapshot.providerId}
              providerName={providerName}
              providerLabel={null}
              displayName={name}
              className="flex shrink-0 items-center gap-1 font-mono text-xs font-semibold text-amber-400 hover:text-amber-300"
              onRepaired={refreshUsageWindow}
            />
          );
        }
        const windows = usageWindowsOf(snapshot);
        if (windows.length === 0) return null;
        return (
          <span
            key={allowanceKey}
            className={`flex shrink-0 items-center gap-1.5 font-mono text-xs font-semibold ${
              snapshot.stale ? 'opacity-50' : ''
            }`}
            title={`${name} subscription usage — ${usageTooltip(windows, now)}${
              snapshot.stale ? '   (stale)' : ''
            }`}
          >
            <UsageBars name={name} windows={windows} now={now} />
          </span>
        );
      })}
    </div>
  );
}
