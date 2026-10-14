import { describe, expect, it } from 'vitest';
import { effectiveNetworkPolicy, type CliNetworkPolicy } from '../src/schemas/cli-providers.js';

const FULL: CliNetworkPolicy = { mode: 'full', domains: [], ips: [] };
const NONE: CliNetworkPolicy = { mode: 'none', domains: [], ips: [] };
const ALLOWLIST: CliNetworkPolicy = {
  mode: 'allowlist',
  domains: ['registry.example.com'],
  ips: ['10.0.0.0/8'],
};

describe('effectiveNetworkPolicy', () => {
  it.each([
    ['none over full', NONE, FULL],
    ['full over none', FULL, NONE],
    ['an allowlist over full', ALLOWLIST, FULL],
    ['none over no provider policy', NONE, null],
  ])("is the task's own policy when metadata.egress carries one: %s", (_name, task, provider) => {
    expect(effectiveNetworkPolicy({ egress: task }, provider)).toBe(task);
  });

  it.each([
    ['metadata with no egress', {}],
    ['an egress of undefined', { egress: undefined }],
    ['an egress of null', { egress: null }],
    ['other metadata keys only', { kind: 'kb_author', index: 3 }],
    ['null metadata', null],
    ['undefined metadata', undefined],
    ['text metadata', 'egress'],
    ['numeric metadata', 5],
    ['array metadata', []],
  ])('is the provider policy, as it was, when the task carries none: %s', (_name, metadata) => {
    expect(effectiveNetworkPolicy(metadata, ALLOWLIST)).toBe(ALLOWLIST);
    expect(effectiveNetworkPolicy(metadata, null)).toBeNull();
  });

  it('reads only metadata.egress: a policy-shaped value under another key is not an override', () => {
    expect(effectiveNetworkPolicy({ network: NONE, policy: NONE, mode: 'none' }, FULL)).toBe(FULL);
  });
});
