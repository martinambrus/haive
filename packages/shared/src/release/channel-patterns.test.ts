import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { CHANNEL_PATTERN, REGISTRY_PREFIX_PATTERN } from './manifest.js';

const source = (path: string) => readFile(new URL(`../../../../${path}`, import.meta.url), 'utf8');

it('pins the build, publish and boot script copies to the shared patterns', async () => {
  const build = await source('scripts/build-channel.mjs');
  expect(build).toContain(`const CHANNEL = ${CHANNEL_PATTERN};`);
  expect(build).toContain(`const PREFIX = ${REGISTRY_PREFIX_PATTERN};`);
  expect(await source('scripts/publish-channel.mjs')).toContain(
    `const PREFIX = ${REGISTRY_PREFIX_PATTERN};`,
  );
  expect(await source('scripts/channel-boot-check.mjs')).toContain(
    `${CHANNEL_PATTERN}.test(doc.channel)`,
  );
});

it('pins the read-only shell and PowerShell installer copies to the shared source text', async () => {
  const shell = await source('install/install.sh');
  const powershell = await source('install/install.ps1');
  for (const pattern of [CHANNEL_PATTERN, REGISTRY_PREFIX_PATTERN]) {
    // ERE has ordinary capturing groups; PowerShell uses absolute .NET anchors and bare slashes.
    const bare = pattern.source.replaceAll('\\/', '/');
    expect(shell).toContain(`grep -Eq '${bare.replaceAll('(?:', '(')}'`);
    expect(powershell).toContain(`-cnotmatch '\\A${bare.slice(1, -1)}\\z'`);
  }
});

it.each(['a', 'a'.repeat(32), 'acme-2'])('accepts channel %s', (channel) => {
  expect(CHANNEL_PATTERN.test(channel)).toBe(true);
});
it.each(['', 'A', '-a', 'a-', 'a'.repeat(33), 'a/b'])('refuses channel %j', (channel) => {
  expect(CHANNEL_PATTERN.test(channel)).toBe(false);
});
it.each(['localhost:5000/customer', 'ghcr.io/vendor', 'private'])('accepts prefix %s', (prefix) => {
  expect(REGISTRY_PREFIX_PATTERN.test(prefix)).toBe(true);
});
it.each(['', 'https://private', 'private/../repo', 'private:tag', 'Private/repo', 'private/'])(
  'refuses prefix %j',
  (prefix) => {
    expect(REGISTRY_PREFIX_PATTERN.test(prefix)).toBe(false);
  },
);
