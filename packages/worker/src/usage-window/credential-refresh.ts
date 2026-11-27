import { cliAuthScope } from '@haive/shared/cli-auth-state';
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import {
  cliAuthIdSlug,
  cliAuthTaskVolumePrefix,
  cliAuthVolumeOwner,
  logger,
  lockLoginSet,
  resolveCliAuthUserVolumeName,
  type CliProviderName,
} from '@haive/shared';
import { schema, tryCliAuthLock, type CliAuthLock, type Database } from '@haive/database';
import {
  applyGrokRefresh,
  GrokOauthError,
  grokTokenNeedsRefresh,
  parseGrokAuthFile,
  refreshGrokToken,
} from '../cli-adapters/grok-oauth.js';
import { listTaskAuthVolumes } from '../sandbox/auth-volume-reaper.js';
import { defaultDockerRunner, type DockerRunner } from '../sandbox/docker-runner.js';
import { GROK_CREDENTIAL_FILE } from './credential-files.js';
import { readVolumeFile, writeVolumeFile } from './token-source.js';

const log = logger.child({ module: 'credential-refresh' });

/** The one CLI Haive refreshes itself.
 *
 *  Every other CLI either refreshes its own credential somewhere Haive keeps
 *  (claude-code, amp), or is deliberately left alone: fetchers/index.ts records why codex
 *  and gemini are not refreshed from here (single-use vendor refresh tokens plus per-task
 *  auth-copy divergence). grok differs because it has no other path back to a live token —
 *  its 6-hour access token is refreshed only inside the per-task copy Haive then destroys,
 *  so without this the login simply dies six hours after it is made. */
const GROK: CliProviderName = 'grok';

/** Refresh tokens the endpoint has permanently rejected, keyed by USER VOLUME name (the
 *  unit that is actually rotated) -> the exact dead token. Stops every tick re-firing a
 *  doomed grant. Self-clearing: a re-login writes a different token, which no longer
 *  matches. In-process; a restart re-discovers it with one wasted call. */
const deadRefreshToken = new Map<string, string>();

interface GrokProviderRow {
  id: string;
  userId: string;
  name: CliProviderName;
  authMode: 'subscription' | 'api_key';
  isolateAuth: boolean;
}

/** Only copies that live work can still rotate hold background refresh. Labels scope
 * the hold to the original credential volume, even if a provider's settings moved.
 * Unknown status/source holds this tick; nothing is cached, so a successful lookup on
 * a later usage tick releases it once the task and its invocations have settled. */
export async function taskVolumesHoldProvider(
  volumeNames: string[],
  providerName: CliProviderName,
  userVolume: string,
  db: Database,
  runner: DockerRunner,
): Promise<boolean> {
  const candidates = volumeNames.filter(
    (name) => name.startsWith(cliAuthTaskVolumePrefix()) && name.includes(`_${providerName}_`),
  );
  if (candidates.length === 0) return false;
  let tasks: { id: string; status: string }[] | undefined;
  try {
    tasks = await db.query.tasks.findMany({ columns: { id: true, status: true } });
  } catch (err) {
    log.warn({ err }, 'credential refresh task status lookup failed; retrying next tick');
  }
  for (const name of candidates) {
    const slug = cliAuthVolumeOwner(name)?.slug;
    const owners = tasks?.filter((task) => cliAuthIdSlug(task.id) === slug);
    // Missing tasks have no invocation ledger left. Slug collisions hold if ANY owner
    // can still rotate; do not arbitrarily choose one of the matching tasks.
    let mayRotate =
      !owners || owners.some((task) => !['completed', 'failed', 'cancelled'].includes(task.status));
    if (!mayRotate && owners && owners.length > 0) {
      try {
        mayRotate = Boolean(
          await db.query.cliInvocations.findFirst({
            where: and(
              inArray(
                schema.cliInvocations.taskId,
                owners.map((task) => task.id),
              ),
              isNotNull(schema.cliInvocations.startedAt),
              isNull(schema.cliInvocations.endedAt),
              isNull(schema.cliInvocations.supersededAt),
            ),
            columns: { id: true },
          }),
        );
      } catch (err) {
        mayRotate = true;
        log.warn(
          { err, volume: name },
          'credential refresh invocation lookup failed; retrying next tick',
        );
      }
    }
    if (!mayRotate) continue;
    try {
      const label = await runner.volumeLabel?.(name, 'haive.auth-source');
      if (label === 'none') continue;
      if (!label) return true; // Legacy or unavailable source: retain the CLI-wide hold.
      const source: unknown = JSON.parse(label);
      if (!source || typeof source !== 'object' || Array.isArray(source)) return true;
      const fields = source as Record<string, unknown>;
      // The known unversioned v0 and v1 shapes have the same source fields. Unknown
      // versions cannot prove which credential this live copy holds.
      if (
        ('version' in fields && fields.version !== 1) ||
        typeof fields.userVolume !== 'string' ||
        (fields.authMode !== 'subscription' && fields.authMode !== 'api_key') ||
        typeof fields.isolateAuth !== 'boolean'
      )
        return true;
      if (fields.userVolume === userVolume) return true;
    } catch (err) {
      log.warn(
        { err, volume: name },
        'credential refresh source lookup failed; retrying next tick',
      );
      return true;
    }
  }
  return false;
}

/**
 * Keep stored CLI logins alive without a re-login.
 *
 * Runs on the usage-poll tick but is NOT usage metering, so it is deliberately not gated
 * on USAGE_WINDOW_ENABLED — a user who hides the meters still expects their CLI to stay
 * signed in.
 *
 * Two rules make this safe:
 *  - It YIELDS to live work holding a copy of this credential (by source label,
 *    conservatively CLI-wide for an unknown source). Both may refresh off the same single-use
 *    refresh token; rotating concurrently signs one of the two out mid-run. Waiting costs
 *    a tick, and the task's own teardown sync carries its refresh back anyway.
 *  - It rotates each USER VOLUME once, not each provider row. Several rows of one CLI share
 *    a volume unless `isolate_auth` is set, and a second grant would be made with a token
 *    the first one just spent.
 *
 * Best-effort by contract: every failure is logged and swallowed. The cost of skipping is
 * one more stale tick, never a broken credential.
 */
export async function refreshExpiringCliCredentials(
  db: Database,
  runner: DockerRunner = defaultDockerRunner,
): Promise<void> {
  const rows = (await db.query.cliProviders.findMany({
    where: and(
      eq(schema.cliProviders.enabled, true),
      eq(schema.cliProviders.name, GROK),
      // api_key rows authenticate from an injected env secret; their volume holds nothing
      // that authenticates, so there is nothing to rotate.
      eq(schema.cliProviders.authMode, 'subscription'),
    ),
    columns: { id: true, userId: true, name: true, authMode: true, isolateAuth: true },
  })) as GrokProviderRow[];
  if (rows.length === 0) return;

  const taskVolumes = await listTaskAuthVolumes();

  // One entry per distinct user volume; the rows sharing it all get the same verdict.
  const byVolume = new Map<string, GrokProviderRow[]>();
  for (const row of rows) {
    const vol = resolveCliAuthUserVolumeName(
      {
        userId: row.userId,
        providerId: row.id,
        providerName: row.name,
        authMode: row.authMode,
        isolateAuth: row.isolateAuth,
      },
      GROK_CREDENTIAL_FILE.authPathIdx,
    );
    byVolume.set(vol, [...(byVolume.get(vol) ?? []), row]);
  }

  for (const [vol, sharing] of byVolume) {
    let release: CliAuthLock | null = null;
    try {
      if (await taskVolumesHoldProvider(taskVolumes, GROK, vol, db, runner)) {
        log.debug({ vol }, 'credential refresh yielded: live work may rotate a copy');
        continue;
      }
      release = await tryCliAuthLock(db, cliAuthScope(sharing[0]!));
      if (!release) {
        log.debug(
          { providerId: sharing[0]!.id },
          'credential refresh skipped: authentication is busy',
        );
        continue;
      }
      await refreshGrokVolume(db, vol, sharing, runner, release.assertHeld);
    } catch (err) {
      log.warn({ err, vol }, 'grok credential refresh failed; leaving the stored login as-is');
    } finally {
      await release?.();
    }
  }
}

async function refreshGrokVolume(
  db: Database,
  vol: string,
  sharing: GrokProviderRow[],
  runner: DockerRunner,
  assertHeld: () => Promise<void>,
): Promise<void> {
  const raw = await readVolumeFile(vol, GROK_CREDENTIAL_FILE.relPath, runner);
  if (!raw) return; // not signed in, or grok already deleted the file
  const cred = parseGrokAuthFile(raw);
  if (!cred) return;
  if (!grokTokenNeedsRefresh(cred.expiresAtMs)) return;
  if (deadRefreshToken.get(vol) === cred.refreshToken) return;

  let fresh;
  try {
    fresh = await refreshGrokToken(cred.refreshToken, cred.clientId);
  } catch (err) {
    if (!(err instanceof GrokOauthError && err.code === 'invalid_grant')) {
      // Transient (network / 5xx). Leave the stored credential untouched and retry next
      // tick; the access token may still have life left in it.
      log.warn({ vol, err }, 'grok token refresh failed (transient); retrying next tick');
      return;
    }
    // Permanently rejected — revoked, or the refresh token was already spent by a run
    // whose copy never made it back. Only a re-login fixes it, so say so on the provider
    // rows instead of letting the next task discover it as "Not signed in".
    log.warn(
      { vol, providerIds: sharing.map((r) => r.id) },
      'grok refresh token rejected (invalid_grant); marking the provider as needing a re-login',
    );
    // The set lock comes first: the image job locks provider rows in id order without the auth
    // lock, so an UPDATE that locks rows as it scans them could hold a higher id while it waits.
    // The rows written are the rows locked: the set as it is now, not as the tick read it earlier.
    await db.transaction(async (tx) => {
      const members = await lockLoginSet(tx, sharing[0]!);
      await assertHeld();
      await tx
        .update(schema.cliProviders)
        .set({
          authStatus: 'unknown',
          authMessage:
            'grok sign-in expired and could not be renewed — log in to this CLI again from the Haive providers page.',
          authLastCheckedAt: new Date(),
        })
        .where(
          inArray(
            schema.cliProviders.id,
            members.map((m) => m.id),
          ),
        );
    });
    // Suppress retries only after the re-login status was recorded successfully.
    deadRefreshToken.set(vol, cred.refreshToken);
    return;
  }

  await assertHeld();
  const wrote = await writeVolumeFile(
    vol,
    GROK_CREDENTIAL_FILE.relPath,
    applyGrokRefresh(cred, fresh),
    runner,
  );
  if (!wrote) {
    // The grant already spent the old refresh token, so a failed write leaves the volume
    // holding a credential that can no longer be renewed. Loud, because the only repair is
    // a re-login and nothing downstream will say so.
    log.error(
      { vol },
      'grok token refreshed but the write back to the user auth volume failed — the stored login is now stale',
    );
    return;
  }
  deadRefreshToken.delete(vol);
  log.info(
    { vol, expiresAt: new Date(fresh.expiresAtMs).toISOString() },
    'rotated the stored grok credential',
  );
}
