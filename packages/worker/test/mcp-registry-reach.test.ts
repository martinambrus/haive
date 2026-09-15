import { describe, expect, it } from 'vitest';
import { networkPolicyReachesPackageRegistries } from '../src/queues/cli-exec/resolvers.js';

// `mcp-server-git` runs through uvx, and the sandbox image ships no Python, so every run
// downloads an interpreter as well as the package. Under a per-task egress override none of
// that is reachable, the server never starts, and exec-core discards the whole run — an
// anchored kb_author enrich with `egress: none` failed all three attempts that way.
describe('networkPolicyReachesPackageRegistries', () => {
  it('allows the unrestricted policy every provider actually ships', () => {
    expect(networkPolicyReachesPackageRegistries({ mode: 'full', domains: [], ips: [] })).toBe(
      true,
    );
  });

  it('allows an absent policy, which is no egress gateway at all', () => {
    expect(networkPolicyReachesPackageRegistries(null)).toBe(true);
  });

  it('refuses a per-task override that cannot reach a registry', () => {
    expect(networkPolicyReachesPackageRegistries({ mode: 'none', domains: [], ips: [] })).toBe(
      false,
    );
    // An allowlist names the article's own sources, never PyPI plus the GitHub releases uv
    // pulls a Python from, so it cannot be assumed to reach either.
    expect(
      networkPolicyReachesPackageRegistries({
        mode: 'allowlist',
        domains: ['docs.example'],
        ips: [],
      }),
    ).toBe(false);
  });
});
