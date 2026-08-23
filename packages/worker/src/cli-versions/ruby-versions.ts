import { schema, type Database } from '@haive/database';
import { logger, type RefreshCliVersionsJobResult } from '@haive/shared';

const log = logger.child({ module: 'ruby-version-refresh' });

/**
 * `ruby/ruby-builder`'s `toolcache` release: prebuilt interpreter tarballs, the same
 * artifacts `ruby/setup-ruby` installs. This is what lets the sandbox image honour a declared
 * Ruby version at all — apt ships exactly one interpreter per suite, and compiling with
 * rbenv/ruby-build would cost minutes on every image build.
 *
 * Deliberately NOT `ruby/setup-ruby`'s `ruby-builder-versions.json`, which is the obvious
 * cheap choice at 2.9 KB against 1.78 MB here: it is OS-AGNOSTIC and OVER-CLAIMS. MEASURED
 * 2026-08-23 — it lists 134 CRuby versions including 4.0.6, which has no ubuntu-24.04 build
 * at all. Offering it would hand out a version whose download 404s at image-build time. The
 * assets ARE the per-OS truth, so they are what gets parsed.
 *
 * Public and unauthenticated, like the Chrome for Testing and OpenRouter catalogs, so the
 * resolution works before anyone has configured anything. The release returns all of its
 * assets inline (MEASURED: 919 of them, no pagination), which is why one request is enough.
 */
const RUBY_BUILDER_RELEASE_URL =
  'https://api.github.com/repos/ruby/ruby-builder/releases/tags/toolcache';

/** ~1.8 MB, but bounded so a hung host cannot wedge the shared REFRESH_VERSIONS job. */
const FETCH_TIMEOUT_MS = 30_000;

/**
 * The OS suffix in an asset name. Tied to `computeBaseImage` in
 * `step-engine/steps/env-replicate/01-declare-deps.ts`, which returns ubuntu:24.04 for every
 * container tool — a tarball is built against one suite's shared libraries and will not run
 * on another, so if that base ever moves this must move with it. The catalog then goes empty
 * rather than wrong, because no asset matches, and the Ruby install falls back to apt.
 */
const ASSET_OS_SUFFIX = 'ubuntu-24.04';

/**
 * CRuby assets for our base image, newest first.
 *
 * Every anchor here earns its place, MEASURED against the live release:
 * - `^ruby-` excludes `jruby-` and `truffleruby-`, which are 33 of the 129 assets carrying
 *   this OS suffix and are not interpreters this image can install.
 * - requiring the name to END with `.tar.gz` excludes the `-ubuntu-24.04-arm64.tar.gz`
 *   builds, which would otherwise match and install an unrunnable binary.
 * - requiring a numeric patch (with the optional `-pNNN` that 2.0/2.1-era releases carry)
 *   excludes `ruby-3.5.0-preview1`. A preview is not something to silently hand a project.
 *
 * That leaves 95 versions across 13 minor lines, 2.0.0-p648 through 3.4.6.
 */
export function parseRubyBuilderAssets(payload: unknown): { version: string; label: string }[] {
  const assets = (payload as { assets?: { name?: unknown }[] })?.assets;
  if (!Array.isArray(assets)) return [];
  const pattern = new RegExp(
    `^ruby-(\\d+\\.\\d+\\.\\d+(?:-p\\d+)?)-${ASSET_OS_SUFFIX.replace(/\./g, '\\.')}\\.tar\\.gz$`,
  );
  const seen = new Set<string>();
  const out: { version: string; label: string; sort: number[] }[] = [];
  for (const asset of assets) {
    const name = typeof asset?.name === 'string' ? asset.name : '';
    const version = pattern.exec(name)?.[1];
    if (!version || seen.has(version)) continue;
    seen.add(version);
    // `-pNNN` sorts after the same x.y.z without one, which is the real release order.
    const [base, patchLevel] = version.split('-p');
    const sort = [...(base ?? '').split('.').map(Number), Number(patchLevel ?? 0)];
    out.push({ version, label: `Ruby ${version}`, sort });
  }
  out.sort((a, b) => {
    for (let i = 0; i < Math.max(a.sort.length, b.sort.length); i += 1) {
      const d = (b.sort[i] ?? 0) - (a.sort[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  });
  return out.map(({ version, label }) => ({ version, label }));
}

/**
 * Refresh the cached Ruby version catalog.
 *
 * Mirrors `refreshBrowserVersions` deliberately, including the failure branch that RECORDS
 * the error on the row instead of throwing: this shares the REFRESH_VERSIONS job, so one
 * unreachable feed must not fail the job or wipe the other caches.
 */
export async function refreshRubyVersions(db: Database): Promise<RefreshCliVersionsJobResult> {
  const runtime = 'ruby';
  try {
    const resp = await fetch(RUBY_BUILDER_RELEASE_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`${RUBY_BUILDER_RELEASE_URL} HTTP ${resp.status}`);
    const versions = parseRubyBuilderAssets(await resp.json());
    // An empty catalog from a successful fetch means the release or the asset naming changed
    // under us. Treat it as an error rather than overwriting a good cache with nothing: an
    // empty catalog is indistinguishable from "no version is installable".
    if (versions.length === 0) throw new Error('ruby catalog parsed to 0 entries');
    const now = new Date();
    await db
      .insert(schema.runtimeVersionCache)
      .values({ runtime, versions, fetchedAt: now, fetchError: null, updatedAt: now })
      .onConflictDoUpdate({
        target: schema.runtimeVersionCache.runtime,
        set: { versions, fetchedAt: now, fetchError: null, updatedAt: now },
      });
    log.info({ runtime, count: versions.length }, 'refreshed ruby version catalog');
    return {
      ok: true,
      refreshed: [{ name: runtime, count: versions.length, latest: versions[0]?.version ?? null }],
      errors: [],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err, runtime }, 'ruby version refresh failed; declared versions fall back to apt');
    // Record the failure WITHOUT touching `versions`: a stale catalog still resolves versions
    // that built yesterday, which beats dropping every Ruby project back to apt because a
    // host blipped.
    await db
      .insert(schema.runtimeVersionCache)
      .values({ runtime, versions: [], fetchedAt: null, fetchError: message })
      .onConflictDoUpdate({
        target: schema.runtimeVersionCache.runtime,
        set: { fetchError: message, updatedAt: new Date() },
      })
      .catch(() => {});
    return { ok: false, refreshed: [], errors: [{ name: runtime, error: message }] };
  }
}
