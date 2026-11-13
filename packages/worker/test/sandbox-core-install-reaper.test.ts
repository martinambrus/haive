import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { INSTALL_LABEL, installLabel } from '@haive/shared';

const h = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: h.spawn,
}));

import { reapSupersededSandboxCores } from '../src/sandbox/sandbox-image-reaper.js';
import { CORE_IDENTITY_LABEL } from '../src/sandbox/sandbox-core-image.js';
import { defaultDockerRunner } from '../src/sandbox/docker-runner.js';

const OWN = 'sha256:' + 'a'.repeat(64);
const FOREIGN = 'sha256:' + 'b'.repeat(64);
const LEGACY = 'sha256:' + 'c'.repeat(64);
const UNRELATED = 'sha256:' + 'd'.repeat(64);
const TAGGED = 'sha256:' + 'e'.repeat(64);
const IN_USE = 'sha256:' + 'f'.repeat(64);
const calls: string[][] = [];

beforeEach(() => {
  vi.stubEnv('HAIVE_INSTALL_ID', 'tib_second');
  calls.length = 0;
  h.spawn.mockReset().mockImplementation((_cmd: string, args: string[]) => {
    calls.push(args);
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    queueMicrotask(() => {
      let stdout = '';
      let code = 0;
      if (args[0] === 'images') {
        const images = [
          {
            id: OWN,
            dangling: true,
            labels: { [INSTALL_LABEL]: 'tib_second', [CORE_IDENTITY_LABEL]: 'old' },
          },
          {
            id: FOREIGN,
            dangling: true,
            labels: { [INSTALL_LABEL]: 'elsewhere', [CORE_IDENTITY_LABEL]: 'old' },
          },
          { id: LEGACY, dangling: true, labels: { [CORE_IDENTITY_LABEL]: 'old' } },
          { id: UNRELATED, dangling: true, labels: { [INSTALL_LABEL]: 'tib_second' } },
          {
            id: TAGGED,
            dangling: false,
            labels: { [INSTALL_LABEL]: 'tib_second', [CORE_IDENTITY_LABEL]: 'current' },
          },
          {
            id: IN_USE,
            dangling: true,
            labels: { [INSTALL_LABEL]: 'tib_second', [CORE_IDENTITY_LABEL]: 'old' },
          },
        ];
        const filters = args.flatMap((v, i) => (v === '--filter' ? [args[i + 1]!] : []));
        stdout = images
          .filter((image) =>
            filters.every((filter) => {
              if (filter === 'dangling=true') return image.dangling;
              if (!filter.startsWith('label=')) throw new Error(`unexpected filter ${filter}`);
              const [key, value] = filter.slice(6).split('=');
              const actual = (image.labels as Record<string, string>)[key!];
              return value === undefined ? actual !== undefined : actual === value;
            }),
          )
          .map((image) => image.id)
          .join('\n');
      } else if (args[0] === 'image' && args[1] === 'rm') {
        code = args.includes(IN_USE) ? 1 : 0;
      } else if (args[0] === 'image' && args[1] === 'inspect') {
        stdout = OWN;
      } else if (args[0] !== 'build') {
        throw new Error(`unexpected docker command ${args.join(' ')}`);
      }
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      child.emit('close', code);
    });
    return child;
  });
});
afterEach(() => vi.unstubAllEnvs());

it('removes only this install’s dangling cores, without forcing an in-use image', async () => {
  await expect(reapSupersededSandboxCores()).resolves.toBe(1);
  expect(calls.filter((args) => args[0] === 'image')).toEqual([
    ['image', 'rm', OWN],
    ['image', 'rm', IN_USE],
  ]);
});

it('stamps worker image builds so dangling cores retain their install ownership', async () => {
  await defaultDockerRunner.build({
    contextDir: '/tib-context',
    tag: 'tib_second-cli-sandbox:latest',
  });
  const build = calls.find((args) => args[0] === 'build')!;
  expect(build[build.indexOf('--label') + 1]).toBe(installLabel());
});
