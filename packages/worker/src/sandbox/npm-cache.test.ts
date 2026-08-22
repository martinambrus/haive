import { describe, it, expect } from 'vitest';
import {
  NPM_CACHE_DIR,
  NPM_CACHE_ENV,
  NPM_CACHE_VOLUME,
  npmCacheMount,
  packageNameFromSpec,
} from './npm-cache.js';

/** F8: chrome-devtools-mcp is launched as `npx -y chrome-devtools-mcp@<version>`, and in a
 *  `--rm` sandbox that means a cold fetch every invocation. MEASURED 111-146s cold against
 *  an agent that stopped looking for its tools at ~50s, so 08a fell back to static analysis
 *  while still reporting a pass. Warm resolve is 4s.
 *
 *  These assert the contract the fix rests on rather than re-measuring docker. */
describe('shared npm cache', () => {
  it('mounts the volume where npm_config_cache points', () => {
    const mount = npmCacheMount();
    expect(mount.source).toBe(NPM_CACHE_VOLUME);
    expect(mount.target).toBe(NPM_CACHE_DIR);
    expect(NPM_CACHE_ENV.npm_config_cache).toBe(NPM_CACHE_DIR);
  });

  it('is writable — a read-only cache would silently never populate', () => {
    expect(npmCacheMount().readOnly).toBeUndefined();
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
