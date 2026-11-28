import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ interrupt: false, events: [] as string[] }));
vi.mock('@haive/shared/fs-safe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@haive/shared/fs-safe')>();
  return {
    ...actual,
    writeFileNoFollow: async (...args: Parameters<typeof actual.writeFileNoFollow>) => {
      h.events.push(`write:${args[1]}`);
      if (h.interrupt && args[1].startsWith('.haive-data/knowledge_base/')) {
        h.interrupt = false;
        await actual.writeFileNoFollow(args[0], args[1], '#', args[3]);
        throw new Error('interrupted before the complete body was written');
      }
      return actual.writeFileNoFollow(...args);
    },
    syncDirectoryNoFollow: async (...args: Parameters<typeof actual.syncDirectoryNoFollow>) => {
      h.events.push(`sync:${args[1]}`);
      return actual.syncDirectoryNoFollow(...args);
    },
  };
});
import { restoreKbReroutes } from '../src/step-engine/steps/onboarding/_kb-reroute-recovery.js';

let repo: string;
afterEach(async () => {
  if (repo) await rm(repo, { recursive: true, force: true });
  h.interrupt = false;
  h.events = [];
});

it('never publishes a partial restored file; Retry recovers the complete journal body', async () => {
  repo = await mkdtemp(path.join(os.tmpdir(), 'haive-kb-atomic-'));
  const recovery = path.join(repo, '.haive/kb-reroute-recovery');
  await mkdir(recovery, { recursive: true });
  const body = '# Complete original article';
  await writeFile(
    path.join(recovery, `${createHash('sha256').update('task').digest('hex')}.json`),
    JSON.stringify({ version: 1, files: [{ path: 'a.md', body }] }),
  );
  h.interrupt = true;
  // Simulate death after the target of the write has been created with incomplete bytes.
  await restoreKbReroutes(repo, 'task').catch(() => {});
  expect(
    await readFile(path.join(repo, '.haive-data/knowledge_base/a.md'), 'utf8').catch(() => null),
    'partial body published at the final KB name',
  ).toBeNull();
  await restoreKbReroutes(repo, 'task');
  expect(await readFile(path.join(repo, '.haive-data/knowledge_base/a.md'), 'utf8')).toBe(body);
});

it('syncs the new recovery directory entry in .haive before authorizing a move', async () => {
  repo = await mkdtemp(path.join(os.tmpdir(), 'haive-kb-fsync-'));
  const recovery = await restoreKbReroutes(repo, 'task');
  const remember = recovery.rememberReroute;
  await remember('a.md', '# Original');
  expect(h.events).toContain('sync:.haive');
  const journalWrite = h.events.findIndex((event) => event.endsWith('.json'));
  expect(h.events.indexOf('sync:.haive')).toBeLessThan(journalWrite);
  expect(h.events.indexOf('sync:.haive/kb-reroute-recovery')).toBeGreaterThan(journalWrite);
});

it('bounds journal reads without accepting a truncated valid prefix', async () => {
  const { KB_REROUTE_JOURNAL_MAX_BYTES } =
    await import('../src/step-engine/steps/onboarding/_kb-reroute-recovery.js');
  expect(KB_REROUTE_JOURNAL_MAX_BYTES).toBe(16 * 1024 * 1024);
  repo = await mkdtemp(path.join(os.tmpdir(), 'haive-kb-cap-'));
  const recovery = path.join(repo, '.haive/kb-reroute-recovery');
  await mkdir(recovery, { recursive: true });
  const valid = JSON.stringify({ version: 1, files: [] });
  const journal = path.join(recovery, `${createHash('sha256').update('task').digest('hex')}.json`);
  await writeFile(journal, valid + ' invalid private trailing data');
  const warn = vi.fn();
  const result = await restoreKbReroutes(repo, 'task', { warn }, Buffer.byteLength(valid));
  expect(result.canPurgeDrafts).toBe(false);
  // Over the bound is deterministic content, not an IO fault: the bytes may hold the only
  // original bodies, so they are set aside untouched and a fresh journal lets this run move files.
  expect(result.canDeleteLocal).toBe(true);
  expect(warn).toHaveBeenCalledWith({ errorClass: 'RangeError' }, expect.any(String));
  expect(await readFile(`${journal}.unusable`, 'utf8')).toBe(
    valid + ' invalid private trailing data',
  );
});
