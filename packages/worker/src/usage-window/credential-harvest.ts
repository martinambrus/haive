import { and, eq, inArray, isNotNull, isNull, notInArray } from 'drizzle-orm';
import { logger, resolveCliAuthUserVolumeName, type CliProviderName } from '@haive/shared';
import { schema, type Database } from '@haive/database';
import { defaultDockerRunner, type DockerRunner } from '../sandbox/docker-runner.js';
import { syncProviderAuthBack, type AuthSyncProvider } from '../sandbox/task-auth-volume.js';
import { CLI_CREDENTIAL_FILES } from './credential-files.js';

const log = logger.child({ module: 'credential-harvest' });

// A task in one of these states has already had its teardown sync run (or will never run
// one); its per-task auth volume is gone or about to be.
const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'] as const;

export interface HarvestCandidate {
  taskId: string;
  provider: AuthSyncProvider;
}

export interface HarvestSelection {
  targets: HarvestCandidate[];
  /** (task, CLI) pairs whose ONE task volume cannot be attributed to ONE user volume. */
  ambiguous: { taskId: string; providerName: CliProviderName }[];
}

function userVolumeOf(provider: AuthSyncProvider, authPathIdx: number): string {
  return resolveCliAuthUserVolumeName(
    {
      userId: provider.userId,
      providerId: provider.id,
      providerName: provider.name,
      authMode: provider.authMode,
      isolateAuth: provider.isolateAuth,
    },
    authPathIdx,
  );
}

/** Which in-flight (task, provider) pairs may have their credential carried back THIS tick.
 *
 *  Two filters, and the first one is the whole reason this runs on a tick rather than at
 *  invocation end:
 *
 *  - A task with a LIVE invocation is skipped. The in-task CLI rewrites its auth file in
 *    place when it refreshes, and copying a file mid-write puts a truncated credential where
 *    the user's login used to be. Between invocations — which is most of a task's life, since
 *    it parks at forms, gates and reviews — the file is quiescent. Skipping costs one tick.
 *  - A (task, CLI) pair whose provider rows resolve to DIFFERENT user volumes is skipped.
 *    cliAuthTaskVolumeName keys on (taskId, cliName, idx) and carries no provider id, so one
 *    task volume backs every row of that CLI in that task; when an isolate_auth row or an
 *    api_key row sits beside a subscription row, nothing in the name says whose credential is
 *    in there, and guessing would write one account's token over another's. The teardown sync
 *    has the same blind spot — this refuses to widen it, it does not fix it.
 *
 *  Pure so both rules are testable without docker or a db. */
export function selectHarvestTargets(
  pairs: readonly HarvestCandidate[],
  busyTaskIds: ReadonlySet<string>,
): HarvestSelection {
  const groups = new Map<string, HarvestCandidate[]>();
  for (const pair of pairs) {
    if (busyTaskIds.has(pair.taskId)) continue;
    if (!CLI_CREDENTIAL_FILES[pair.provider.name]) continue;
    const key = `${pair.taskId}::${pair.provider.name}`;
    groups.set(key, [...(groups.get(key) ?? []), pair]);
  }

  const targets: HarvestCandidate[] = [];
  const ambiguous: HarvestSelection['ambiguous'] = [];
  for (const members of groups.values()) {
    const first = members[0];
    if (!first) continue;
    const source = CLI_CREDENTIAL_FILES[first.provider.name];
    if (!source) continue;

    const volumes = new Set(members.map((m) => userVolumeOf(m.provider, source.authPathIdx)));
    if (volumes.size > 1) {
      ambiguous.push({ taskId: first.taskId, providerName: first.provider.name });
      continue;
    }
    // Every member resolves to the same user volume, so any row speaks for it. Lowest
    // provider id, so a settled tick picks the same row every time.
    const chosen = [...members].sort((a, b) => a.provider.id.localeCompare(b.provider.id))[0];
    if (chosen) targets.push(chosen);
  }
  return { targets, ambiguous };
}

/**
 * Carry a credential the in-task CLI refreshed back onto the user auth volume WHILE the task
 * is still running, instead of waiting for its teardown.
 *
 * syncRefreshedAuthToUserVolumes already does this at task end, which cleans up after the
 * damage rather than preventing it: the poller reads the USER volume, so a task that outlives
 * its own access token leaves the meter dead and hands the next task a spent single-use
 * refresh token. Measured: a codex user volume ten days and three in-task refreshes behind,
 * its access token expired at 18:20, while the live task's copy had been refreshed at 20:57.
 *
 * Runs on the usage-poll tick because that worker is the singleton that must not race a
 * second rotator over a single-use refresh token, and because deduping by volume there costs
 * a handful of helper containers every five minutes — ten codex provider rows share one user
 * volume, so this is a few reads per tick, not a few per invocation.
 *
 * NOT metering: like refreshExpiringCliCredentials it is deliberately not gated on
 * USAGE_WINDOW_ENABLED, because a user who hides the meters still expects to stay signed in.
 *
 * Best-effort by contract: every failure is logged and swallowed. The cost of skipping is one
 * more stale tick, never a broken credential.
 */
export async function harvestInTaskCredentials(
  db: Database,
  runner: DockerRunner = defaultDockerRunner,
): Promise<void> {
  const names = Object.keys(CLI_CREDENTIAL_FILES) as CliProviderName[];
  if (names.length === 0) return;

  // The provider ROWS each live task actually used, from the invocation ledger — the same
  // source the teardown sync trusts, and the only one that skips a CLI the task never touched.
  const pairs = await db
    .selectDistinct({
      taskId: schema.cliInvocations.taskId,
      id: schema.cliProviders.id,
      userId: schema.cliProviders.userId,
      name: schema.cliProviders.name,
      authMode: schema.cliProviders.authMode,
      isolateAuth: schema.cliProviders.isolateAuth,
    })
    .from(schema.cliInvocations)
    .innerJoin(schema.tasks, eq(schema.cliInvocations.taskId, schema.tasks.id))
    .innerJoin(schema.cliProviders, eq(schema.cliInvocations.cliProviderId, schema.cliProviders.id))
    .where(
      and(
        notInArray(schema.tasks.status, [...TERMINAL_STATUSES]),
        inArray(schema.cliProviders.name, names),
      ),
    );
  if (pairs.length === 0) return;

  // The canonical live predicate (pause.ts's hasLiveCliInvocation). Rows with no started_at
  // are queued, not running, so their CLI is not holding the auth file open.
  const busy = await db
    .selectDistinct({ taskId: schema.cliInvocations.taskId })
    .from(schema.cliInvocations)
    .where(
      and(
        isNotNull(schema.cliInvocations.startedAt),
        isNull(schema.cliInvocations.endedAt),
        isNull(schema.cliInvocations.supersededAt),
      ),
    );

  const { targets, ambiguous } = selectHarvestTargets(
    pairs.map((p) => ({
      taskId: p.taskId,
      provider: {
        id: p.id,
        userId: p.userId,
        name: p.name,
        authMode: p.authMode,
        isolateAuth: p.isolateAuth,
      },
    })),
    new Set(busy.map((b) => b.taskId)),
  );

  for (const a of ambiguous) {
    log.warn(
      a,
      'credential harvest skipped: this task used two provider rows of one CLI that do not share a user auth volume, so the task volume cannot be attributed',
    );
  }

  for (const target of targets) {
    await syncProviderAuthBack(target.taskId, target.provider, runner);
  }
}
