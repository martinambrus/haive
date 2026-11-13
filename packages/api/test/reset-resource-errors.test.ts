import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ root: '', armed: false, error: new Error() }));
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>();
  return {
    ...real,
    lstat: (...args: Parameters<typeof real.lstat>) => {
      if (h.armed && String(args[0]).endsWith('/settings.json')) {
        h.armed = false;
        throw h.error;
      }
      return real.lstat(...args);
    },
  };
});
vi.mock('@haive/shared/fs-safe', async (original) => {
  const real = await original<typeof import('@haive/shared/fs-safe')>();
  return {
    ...real,
    removeFileIfNoFollow: async (...args: Parameters<typeof real.removeFileIfNoFollow>) => {
      const result = await real.removeFileIfNoFollow(...args);
      if (args[1] === '.claude/settings.json' && result === 'removed') {
        const fs = await import('node:fs/promises');
        await fs.writeFile(`${h.root}/.claude/settings.json`, 'user save');
        h.armed = true;
      }
      return result;
    },
  };
});
import { normalizeContent, sha256Hex } from '@haive/shared';
import { resetOnboardingArtifacts } from '../src/routes/repos.js';
afterEach(async () => {
  h.armed = false;
  await rm(h.root, { recursive: true, force: true });
});
it.each(['EMFILE', 'ENFILE'])(
  'keeps a retaken reset path and its ledger claim on %s',
  async (code) => {
    h.root = await mkdtemp(path.join(tmpdir(), 'reset-resource-'));
    await mkdir(path.join(h.root, '.claude'));
    await writeFile(path.join(h.root, '.claude/settings.json'), 'haive');
    // Ensure a partial reset reports its outcome instead of the untouched-tree refusal.
    await writeFile(path.join(h.root, '.claude/workflow-config.json'), 'generated');
    h.error = Object.assign(new Error('injected'), { code });
    const outcome = await resetOnboardingArtifacts(h.root, {
      writtenHashes: new Map([['.claude/settings.json', sha256Hex(normalizeContent('haive'))]]),
      haiveDirs: new Set(),
      haiveEntries: new Map([['.claude/workflow-config.json', null]]),
    });
    expect(outcome.vacatedPaths.has('.claude/settings.json')).toBe(false);
    expect(outcome.skipped).toContainEqual({
      path: '.claude/settings.json',
      reason: expect.stringContaining(code),
    });
    expect(await readFile(path.join(h.root, '.claude/settings.json'), 'utf8')).toBe('user save');
  },
);

it('reports a lone reset whose removed file cannot be re-read instead of refusing it', async () => {
  h.root = await mkdtemp(path.join(tmpdir(), 'reset-resource-'));
  await mkdir(path.join(h.root, '.claude'));
  await writeFile(path.join(h.root, '.claude/settings.json'), 'haive');
  h.error = Object.assign(new Error('injected'), { code: 'EMFILE' });
  // The old file is already unlinked, so the tree changed: the untouched-tree 500 would leave
  // live rows naming a deleted file.
  const outcome = await resetOnboardingArtifacts(h.root, {
    writtenHashes: new Map([['.claude/settings.json', sha256Hex(normalizeContent('haive'))]]),
    haiveDirs: new Set(),
    haiveEntries: new Map(),
  });
  expect(outcome.vacatedPaths.has('.claude/settings.json')).toBe(false);
  expect(outcome.skipped).toContainEqual({
    path: '.claude/settings.json',
    reason: expect.stringContaining('EMFILE'),
  });
});
