import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
  NPM_CACHE_BASE_DIR,
  NPM_CACHE_DIR,
  NPM_CACHE_ENV,
  NPM_CACHE_SEED_PRELUDE,
  NPM_CACHE_VOLUME,
  npmCacheMount,
  packageNameFromSpec,
} from './npm-cache.js';

const m = vi.hoisted(() => ({ exec: vi.fn() }));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const { promisify } = await import('node:util');
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: m.exec }) };
});

/** F8: chrome-devtools-mcp is launched as `npx -y chrome-devtools-mcp@<version>`, and in a
 *  `--rm` sandbox that means a cold fetch every invocation. MEASURED 111-146s cold against
 *  an agent that stopped looking for its tools at ~50s, so 08a fell back to static analysis
 *  while still reporting a pass. Warm resolve is 4s.
 *
 *  These assert the contract the fix rests on rather than re-measuring docker. */
describe('shared npm cache', () => {
  it('mounts the shared base read-only, separate from where npm_config_cache points', () => {
    const mount = npmCacheMount();
    expect(mount.source).toBe(NPM_CACHE_VOLUME);
    expect(mount.target).toBe(NPM_CACHE_BASE_DIR);
    expect(mount.readOnly).toBe(true);
    expect(NPM_CACHE_ENV.npm_config_cache).toBe(NPM_CACHE_DIR);
  });

  it('is read-only — no sandbox may write the shared base', () => {
    expect(npmCacheMount().readOnly).toBe(true);
    expect(NPM_CACHE_BASE_DIR).not.toBe(NPM_CACHE_DIR);
  });

  it('seeds the private cache from the base and ends so callers can append', () => {
    expect(NPM_CACHE_SEED_PRELUDE).toContain(NPM_CACHE_BASE_DIR);
    expect(NPM_CACHE_SEED_PRELUDE).toContain(NPM_CACHE_DIR);
    expect(NPM_CACHE_SEED_PRELUDE).toContain('cp -a');
    expect(NPM_CACHE_SEED_PRELUDE.endsWith('; ')).toBe(true);
  });

  // A failed seed must leave the command running on an empty private cache, with a warning.
  // `set -e` would turn it into a dead sandbox, and a fallback that mounted the shared base
  // read-write would reopen the hole this closes.
  it('falls back to an empty private cache with a warning, never aborting the command', () => {
    expect(NPM_CACHE_SEED_PRELUDE).not.toContain('set -e');
    expect(NPM_CACHE_SEED_PRELUDE).toMatch(/\|\| echo '.+' >&2; $/);
  });

  // MEASURED live: the sandbox user (uid 1000) got `mkdir: cannot create directory
  // '/haive-npm-cache': Permission denied`, so the seed was skipped and npm failed on its own
  // write. Only a path under /tmp (1777) can be created by that user.
  it('keeps the private cache where the non-root sandbox user can create it', () => {
    expect(NPM_CACHE_DIR.startsWith('/tmp/')).toBe(true);
    expect(NPM_CACHE_BASE_DIR.startsWith(NPM_CACHE_DIR)).toBe(false);
  });

  // The purge that repairs a poisoned tree keys on this name, so getting it wrong either
  // spares the broken entry or deletes an unrelated one.
  it('takes the version off a spec without eating a scope', () => {
    expect(packageNameFromSpec('chrome-devtools-mcp@latest')).toBe('chrome-devtools-mcp');
    expect(packageNameFromSpec('chrome-devtools-mcp@0.6.1')).toBe('chrome-devtools-mcp');
    // A scoped name's leading @ is not a version separator.
    expect(packageNameFromSpec('@modelcontextprotocol/server-filesystem')).toBe(
      '@modelcontextprotocol/server-filesystem',
    );
    expect(packageNameFromSpec('@modelcontextprotocol/server-filesystem@2026.8.1')).toBe(
      '@modelcontextprotocol/server-filesystem',
    );
    expect(packageNameFromSpec('plain-package')).toBe('plain-package');
  });

  it('stays clear of the sandbox user home, where the auth volume machinery binds', () => {
    // A bind over part of the CLI auth volume is destructive in two ways at once
    // (see the McpDelivery docs), so the cache must not live under it.
    expect(NPM_CACHE_DIR.startsWith('/home/')).toBe(false);
    expect(NPM_CACHE_DIR.startsWith('/root/')).toBe(false);
  });

  it('uses the env var npm and npx actually read', () => {
    // `npm_config_cache` is npm's documented env form of the `cache` config; npx inherits
    // it. NPM_CONFIG_CACHE would work too, but lowercase is what npm docs specify and what
    // was verified end to end.
    expect(Object.keys(NPM_CACHE_ENV)).toEqual(['npm_config_cache']);
  });
});

/** The package spec the warm is asked for must match what mcp-config launches, or the
 *  cache is populated for a version the sandbox never requests. */
describe('warm spec matches the launched spec', () => {
  const specFor = (version: string | null): string =>
    `chrome-devtools-mcp@${version?.trim() || 'latest'}`;

  it('falls back to latest when no per-repo version is pinned', () => {
    expect(specFor(null)).toBe('chrome-devtools-mcp@latest');
    expect(specFor('   ')).toBe('chrome-devtools-mcp@latest');
  });

  it('honours a per-repo pin — the version is NOT baked into the image', () => {
    expect(specFor('0.6.1')).toBe('chrome-devtools-mcp@0.6.1');
  });
});

/** A base written while the volume was still mounted read-write may hold content a sandbox
 *  planted. The align container empties it once, then the warm every invocation runs refills
 *  it; MEASURED live on a tainted volume (dotfile, symlink and leading-dash names included). */
describe('re-warm of a base written before it was read-only', () => {
  beforeEach(() => {
    m.exec.mockReset();
    m.exec.mockResolvedValue({ stdout: '', stderr: '' });
    vi.resetModules();
  });

  async function alignScript(): Promise<string> {
    const { ensureNpmCacheVolume } = await import('./npm-cache.js');
    await ensureNpmCacheVolume('img');
    const call = m.exec.mock.calls.find(([, args]) => (args as string[]).includes('-c'));
    const args = call![1] as string[];
    return args[args.indexOf('-c') + 1]!;
  }

  it('empties everything but the markers once, and writes the migrated marker after the wipe', async () => {
    const script = await alignScript();
    const migrated = `${NPM_CACHE_DIR}/.haive-cache-ro-migrated`;
    // Guarded by its own marker, so a later boot leaves the warmed base alone.
    expect(script.startsWith(`test -f ${migrated} ||`)).toBe(true);
    // Every top-level entry, dotfiles included, except the two markers.
    expect(script).toContain('-mindepth 1 -maxdepth 1');
    expect(script).toContain(`! -path ${migrated}`);
    expect(script).toMatch(/! -path \S+\.haive-cache-owner-\d+/);
    // The marker is written last: a wipe that dies midway runs again at the next boot.
    expect(script.indexOf('rm -rf --')).toBeGreaterThan(-1);
    expect(script.indexOf('rm -rf --')).toBeLessThan(script.lastIndexOf(`touch ${migrated}`));
  });
});
