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
 * Edge's apt index. Unlike Google's repo — which publishes exactly ONE google-chrome-stable
 * and keeps no archive — Microsoft's keeps old debs: MEASURED, 184 of them across 39 majors
 * (95 to 151). That is why Edge needs no zip overlay: apt can pin it directly.
 *
 * Plain text, not JSON, so it is parsed rather than deserialized.
 */
const EDGE_PACKAGES_URL =
  'https://packages.microsoft.com/repos/edge/dists/stable/main/binary-amd64/Packages';

/** Newest build per MAJOR, newest major first. 184 builds is not a dropdown; 39 majors is,
 *  and a project cares which Edge major it runs against, not which patch. */
export function parseEdgePackages(text: string): { version: string; label: string }[] {
  const best = new Map<number, { version: string; parts: number[] }>();
  for (const block of text.split(/\n\s*\n/)) {
    if (!/^Package: microsoft-edge-stable\s*$/m.test(block)) continue;
    const m = /^Version: (\S+)/m.exec(block);
    if (!m) continue;
    const version = m[1] ?? '';
    if (!version) continue;
    const parts = version.split(/[.-]/).map((n) => Number(n) || 0);
    const major = parts[0] ?? 0;
    if (!major) continue;
    const prev = best.get(major);
    if (!prev || compareParts(parts, prev.parts) > 0) best.set(major, { version, parts });
  }
  return [...best.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([major, v]) => ({ version: v.version, label: `Edge ${major}` }));
}

function compareParts(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
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
async function refreshOne(
  db: Database,
  browser: 'chrome' | 'edge',
  load: () => Promise<{ version: string; label: string }[]>,
): Promise<RefreshCliVersionsJobResult> {
  try {
    const versions = await load();
    // An empty catalog from a successful fetch means the payload shape changed under us.
    // Treat it as an error rather than overwriting a good cache with nothing: a picker with
    // no versions is indistinguishable from "this browser has no releases".
    if (versions.length === 0) throw new Error(`${browser} catalog parsed to 0 entries`);
    const now = new Date();
    await db
      .insert(schema.browserVersionCache)
      .values({ browser, versions, fetchedAt: now, fetchError: null, updatedAt: now })
      .onConflictDoUpdate({
        target: schema.browserVersionCache.browser,
        set: { versions, fetchedAt: now, fetchError: null, updatedAt: now },
      });
    log.info({ browser, count: versions.length }, 'refreshed browser version catalog');
    return {
      ok: true,
      refreshed: [{ name: browser, count: versions.length, latest: null }],
      errors: [],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err, browser }, 'browser version refresh failed; picker degrades to system default');
    // Record the failure WITHOUT touching `versions`: a stale catalog still lets a user pick
    // something that built yesterday, which beats collapsing the picker because a host blipped.
    await db
      .insert(schema.browserVersionCache)
      .values({ browser, versions: [], fetchedAt: null, fetchError: message })
      .onConflictDoUpdate({
        target: schema.browserVersionCache.browser,
        set: { fetchError: message, updatedAt: new Date() },
      })
      .catch(() => {});
    return { ok: false, refreshed: [], errors: [{ name: browser, error: message }] };
  }
}

async function fetchText(url: string): Promise<string> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`${url} HTTP ${resp.status}`);
  return resp.text();
}

/**
 * Refresh the cached browser version catalogs.
 *
 * Mirrors `refreshOpenRouterModels` deliberately, including the failure branch that RECORDS
 * the error on the row instead of throwing: this shares the REFRESH_VERSIONS job, so one
 * unreachable feed must not fail the job or wipe the other caches. The two browsers refresh
 * independently for the same reason — Microsoft being down must not cost us Chrome's list.
 *
 * Opera is absent on purpose: it publishes only its current release, so it can never offer a
 * version and would be a row that is permanently empty.
 */
export async function refreshBrowserVersions(db: Database): Promise<RefreshCliVersionsJobResult> {
  const [chrome, edge] = await Promise.all([
    refreshOne(db, 'chrome', async () =>
      parseCftMilestones(JSON.parse(await fetchText(CFT_MILESTONES_URL))),
    ),
    refreshOne(db, 'edge', async () => parseEdgePackages(await fetchText(EDGE_PACKAGES_URL))),
  ]);
  return {
    ok: chrome.ok && edge.ok,
    refreshed: [...chrome.refreshed, ...edge.refreshed],
    errors: [...chrome.errors, ...edge.errors],
  };
}
