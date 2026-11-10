import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { readFileNoFollow, writeFileNoFollow } from '@haive/shared/fs-safe';

let root: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
});

it('worker startup enables recovery only for writes, after the full git park window', async () => {
  root = await mkdtemp(path.join(tmpdir(), 'worker-park-recovery-'));
  const parked = '.AGENTS.md.haive-park-1-' + randomUUID();
  await writeFile(path.join(root, parked), 'rules');
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 25 * 60 * 60 * 1000);
  await writeFileNoFollow(root, 'trigger', 'api-style write');
  expect(await readFileNoFollow(root, 'AGENTS.md')).toBeNull();
  await import('../src/fs-recovery.js');
  expect(await readFileNoFollow(root, 'AGENTS.md')).toBeNull();
  await writeFileNoFollow(root, 'trigger', 'worker write');
  expect((await readFileNoFollow(root, 'AGENTS.md'))?.data.toString()).toBe('rules');
  const entry = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  expect(entry).toContain("import './fs-recovery.js';");
});
