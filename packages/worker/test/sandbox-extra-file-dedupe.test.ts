import { describe, expect, it } from 'vitest';
import { dedupeExtraFilesByPath } from '../src/sandbox/sandbox-runner.js';

// The exact collision that broke every cli-exec on a DDEV repo: the traefik key is both a
// `#ddev-generated` file (integrity mask, real bytes) and a `**/*.key` secret (secrecy
// mask, empty). Docker answered with "Duplicate mount point: <path>" and refused to start
// the container at all, so the invocation failed before the CLI ever ran.
const KEY_PATH = '/haive/workdir/.ddev/traefik/certs/rs-codex-5-6-ultra.key';

describe('dedupeExtraFilesByPath', () => {
  it('keeps the FIRST claim on a contested path', () => {
    const out = dedupeExtraFilesByPath([
      { containerPath: KEY_PATH, content: '' },
      { containerPath: KEY_PATH, content: '-----BEGIN PRIVATE KEY-----\n' },
    ]);
    expect(out).toHaveLength(1);
    // Secret masks are composed first, so the empty one wins and the key bytes never
    // reach the container.
    expect(out[0]!.content).toBe('');
  });

  it('leaves distinct paths alone and preserves order', () => {
    const files = [
      { containerPath: '/haive/workdir/.git', content: '' },
      { containerPath: '/haive/workdir/.env', content: '' },
      { containerPath: KEY_PATH, content: '' },
    ];
    expect(dedupeExtraFilesByPath(files)).toEqual(files);
  });

  it('collapses more than two claims on one path', () => {
    const out = dedupeExtraFilesByPath([
      { containerPath: KEY_PATH, content: 'a' },
      { containerPath: KEY_PATH, content: 'b' },
      { containerPath: KEY_PATH, content: 'c' },
    ]);
    expect(out).toEqual([{ containerPath: KEY_PATH, content: 'a' }]);
  });

  it('handles an empty list', () => {
    expect(dedupeExtraFilesByPath([])).toEqual([]);
  });
});
