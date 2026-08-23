import { schema, type Database } from '@haive/database';
import { logger, type RefreshCliVersionsJobResult } from '@haive/shared';

const log = logger.child({ module: 'browser-version-refresh' });

/**
 * Chrome for Testing's per-milestone feed: one entry per Chrome milestone, each with the
 * full version and a linux64 download URL.
 *
 * Deliberately NOT `known-good-versions.json`, which is the same data at build granularity:
 * MEASURED, 2478 entries against 42 here. A dropdown cannot show 2478 builds, and the extra
 * precision buys nothing — a milestone is what a project actually cares about.
 *
 * Public and unauthenticated, like the OpenRouter catalog, so the picker can populate before
 * anyone has configured anything.
 */
const CFT_MILESTONES_URL =
  'https://googlechromelabs.github.io/chrome-for-testing/latest-versions-per-milestone-with-downloads.json';

/** ~85 KB, but bounded so a hung host cannot wedge the shared REFRESH_VERSIONS job. */
const FETCH_TIMEOUT_MS = 30_000;

interface CftMilestone {
  milestone?: string;
  version?: string;
  downloads?: { chrome?: { platform?: string; url?: string }[] };
}

/** Milestones that actually ship a linux64 build, newest first. A milestone with no linux64
 *  download is unusable here and is dropped rather than offered and failed later. */
export function parseCftMilestones(payload: unknown): { version: string; label: string }[] {
  const milestones = (payload as { milestones?: Record<string, CftMilestone> })?.milestones;
  if (!milestones || typeof milestones !== 'object') return [];
  const out: { version: string; label: string; sort: number }[] = [];
  for (const [key, m] of Object.entries(milestones)) {
    const version = typeof m?.version === 'string' ? m.version.trim() : '';
    if (!version) continue;
    const hasLinux = (m?.downloads?.chrome ?? []).some((d) => d?.platform === 'linux64' && d?.url);
    if (!hasLinux) continue;
    const milestone = (m?.milestone ?? key).trim();
    out.push({ version, label: `Chrome ${milestone}`, sort: Number(milestone) || 0 });
  }
  out.sort((a, b) => b.sort - a.sort);
  return out.map(({ version, label }) => ({ version, label }));
}

/**
 * Refresh the cached browser version catalog.
 *
 * Mirrors `refreshOpenRouterModels` deliberately, including the failure branch that RECORDS
 * the error on the row instead of throwing: this shares the REFRESH_VERSIONS job, so one
 * unreachable feed must not fail the job or wipe the other caches.
 *
 * Chrome only for now. Edge's catalog comes from its apt index (which, unlike Google's, keeps
 * old debs) and lands with the Edge install path; Opera publishes only its current release, so
 * it never gets a row and can only ever be system default.
 */
export async function refreshBrowserVersions(db: Database): Promise<RefreshCliVersionsJobResult> {
  try {
    const resp = await fetch(CFT_MILESTONES_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`${CFT_MILESTONES_URL} HTTP ${resp.status}`);
    const versions = parseCftMilestones(await resp.json());
    // An empty catalog from a 200 means the payload shape changed under us. Treat it as an
    // error rather than overwriting a good cache with nothing: a picker with no versions is
    // indistinguishable from "Chrome has no releases".
    if (versions.length === 0) throw new Error('milestone feed parsed to 0 entries');
    const now = new Date();
    await db
      .insert(schema.browserVersionCache)
      .values({ browser: 'chrome', versions, fetchedAt: now, fetchError: null, updatedAt: now })
      .onConflictDoUpdate({
        target: schema.browserVersionCache.browser,
        set: { versions, fetchedAt: now, fetchError: null, updatedAt: now },
      });
    log.info({ count: versions.length }, 'refreshed browser version catalog');
    return {
      ok: true,
      refreshed: [{ name: 'chrome', count: versions.length, latest: null }],
      errors: [],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err }, 'browser version refresh failed; the picker degrades to system default');
    // Record the failure WITHOUT touching `versions`: a stale catalog still lets a user pick
    // something that built yesterday, which beats collapsing the picker to nothing because a
    // static host blipped.
    await db
      .insert(schema.browserVersionCache)
      .values({ browser: 'chrome', versions: [], fetchedAt: null, fetchError: message })
      .onConflictDoUpdate({
        target: schema.browserVersionCache.browser,
        set: { fetchError: message, updatedAt: new Date() },
      })
      .catch(() => {});
    return { ok: false, refreshed: [], errors: [{ name: 'chrome', error: message }] };
  }
}
