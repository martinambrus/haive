import { and, eq, inArray } from 'drizzle-orm';
import { logger, resolveCliAuthUserVolumeName, type CliProviderName } from '@haive/shared';
import { schema, type Database } from '@haive/database';
import {
  applyGrokRefresh,
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

/** True when any per-task auth volume for this CLI exists, i.e. some task is holding a
 *  copy of the credential. Pure so the yield rule is testable without docker. */
export function taskVolumesHoldProvider(
  volumeNames: string[],
  providerName: CliProviderName,
): boolean {
  return volumeNames.some(
    (name) => name.startsWith('haive_cli_auth_task_') && name.includes(`_${providerName}_`),
  );
}

/**
 * Keep stored CLI logins alive without a re-login.
 *
 * Runs on the usage-poll tick but is NOT usage metering, so it is deliberately not gated
 * on USAGE_WINDOW_ENABLED — a user who hides the meters still expects their CLI to stay
 * signed in.
 *
 * Two rules make this safe:
 *  - It YIELDS to running work. A per-task auth volume existing for the CLI means some
 *    task holds a copy of the same credential and may refresh off the same single-use
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
  if (taskVolumesHoldProvider(taskVolumes, GROK)) {
    log.debug({ provider: GROK }, 'credential refresh yielded: a task holds a copy');
    return;
  }

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
    try {
      await refreshGrokVolume(db, vol, sharing, runner);
    } catch (err) {
      log.warn({ err, vol }, 'grok credential refresh failed; leaving the stored login as-is');
    }
  }
}

async function refreshGrokVolume(
  db: Database,
  vol: string,
  sharing: GrokProviderRow[],
  runner: DockerRunner,
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
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('invalid_grant')) {
      // Transient (network / 5xx). Leave the stored credential untouched and retry next
      // tick; the access token may still have life left in it.
      log.warn({ vol, err }, 'grok token refresh failed (transient); retrying next tick');
      return;
    }
    // Permanently rejected — revoked, or the refresh token was already spent by a run
    // whose copy never made it back. Only a re-login fixes it, so say so on the provider
    // rows instead of letting the next task discover it as "Not signed in".
    deadRefreshToken.set(vol, cred.refreshToken);
    log.warn(
      { vol, providerIds: sharing.map((r) => r.id) },
      'grok refresh token rejected (invalid_grant); marking the provider as needing a re-login',
    );
    await db
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
          sharing.map((r) => r.id),
        ),
      );
    return;
  }

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
