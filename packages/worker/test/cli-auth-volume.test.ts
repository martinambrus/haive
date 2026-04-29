import { describe, expect, it } from 'vitest';
import {
  expandTildeToSandbox,
  resolveCliAuthMounts,
  type CliAuthMountContext,
} from '../src/sandbox/cli-auth-volume.js';

const SHARED_CTX: CliAuthMountContext = {
  userId: 'aaaa-bbbb-cccc-dddd',
  providerId: 'prov-1',
  providerName: 'gemini',
  isolateAuth: false,
};

const ISOLATED_CTX: CliAuthMountContext = {
  userId: 'aaaa-bbbb-cccc-dddd',
  providerId: 'pppp-qqqq-rrrr-ssss',
  providerName: 'gemini',
  isolateAuth: true,
};

describe('resolveCliAuthMounts', () => {
  it('shared mode emits one mount per authConfigPath using the per-user volume', () => {
    const mounts = resolveCliAuthMounts(SHARED_CTX);
    expect(mounts).toHaveLength(2);
    expect(mounts[0].source).toBe('haive_cli_auth_aaaabbbbcccc_gemini_0');
    expect(mounts[1].source).toBe('haive_cli_auth_aaaabbbbcccc_gemini_1');
  });

  it('isolated mode emits one mount per authConfigPath using the per-provider volume', () => {
    const mounts = resolveCliAuthMounts(ISOLATED_CTX);
    expect(mounts).toHaveLength(2);
    expect(mounts[0].source).toBe('haive_cli_auth_p_ppppqqqqrrrr_gemini_0');
    expect(mounts[1].source).toBe('haive_cli_auth_p_ppppqqqqrrrr_gemini_1');
  });

  it('isolated and shared volume names never collide for the same user/provider/idx', () => {
    const shared = resolveCliAuthMounts(SHARED_CTX);
    const isolated = resolveCliAuthMounts(ISOLATED_CTX);
    const sharedNames = new Set(shared.map((m) => m.source));
    expect(isolated.every((m) => !sharedNames.has(m.source))).toBe(true);
  });

  it('targets are expanded relative to /home/node (sandbox HOME)', () => {
    const mounts = resolveCliAuthMounts(SHARED_CTX);
    expect(mounts.map((m) => m.target)).toEqual([
      '/home/node/.config/gemini',
      '/home/node/.gemini',
    ]);
  });

  it('defaults to read-only mounts; opts.writable=true flips to writable', () => {
    const ro = resolveCliAuthMounts(SHARED_CTX);
    expect(ro.every((m) => m.readOnly === true)).toBe(true);
    const rw = resolveCliAuthMounts(SHARED_CTX, { writable: true });
    expect(rw.every((m) => m.readOnly === false)).toBe(true);
  });
});

describe('expandTildeToSandbox', () => {
  it('expands ~ to the sandbox HOME', () => {
    expect(expandTildeToSandbox('~')).toBe('/home/node');
  });

  it('expands ~/foo to /home/node/foo', () => {
    expect(expandTildeToSandbox('~/.codex')).toBe('/home/node/.codex');
  });

  it('passes absolute paths through unchanged', () => {
    expect(expandTildeToSandbox('/etc/foo')).toBe('/etc/foo');
  });
});
