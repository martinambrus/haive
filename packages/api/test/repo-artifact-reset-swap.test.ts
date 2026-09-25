import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  swap: null as null | { when: string; path: string; content: string },
}));

vi.mock('@haive/shared', async (importOriginal) => {
  const real = await importOriginal<typeof import('@haive/shared')>();
  return {
    ...real,
    // A person saving the file at the moment the reset hashes it to decide whether it is Haive's.
    sha256Hex: (input: string) => {
      const swap = h.swap;
      if (swap && input === swap.when) {
        h.swap = null;
        writeFileSync(swap.path, swap.content);
      }
      return real.sha256Hex(input);
    },
  };
});

import { normalizeContent, sha256Hex } from '@haive/shared';
import { resetOnboardingArtifacts, type OnboardingResetProvenance } from '../src/routes/repos.js';

const OURS = '{"haive":"generated"}\n';
const MINE = 'MINE\n';

const dirs: string[] = [];
afterEach(async () => {
  h.swap = null;
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function repoWith(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reset-swap-'));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), content, 'utf8');
  }
  return root;
}

/** Reset with the person's save landing on `rel` as the reset hashes it; answers what `rel` holds. */
async function resetDuringSave(
  root: string,
  rel: string,
  provenance: OnboardingResetProvenance,
): Promise<{ onDisk: string; skipped: Array<{ path: string; reason: string }> }> {
  h.swap = { when: normalizeContent(OURS), path: path.join(root, rel), content: MINE };
  const outcome = await resetOnboardingArtifacts(root, provenance);
  expect(h.swap).toBeNull();
  return { onDisk: await readFile(path.join(root, rel), 'utf8'), skipped: outcome.skipped };
}

const hashOfOurs = (): string => sha256Hex(normalizeContent(OURS));

describe('the reset never takes a file saved while it was being judged', () => {
  it('in the settings pass', async () => {
    const rel = '.claude/settings.json';
    const root = await repoWith({ [rel]: OURS });
    const result = await resetDuringSave(root, rel, {
      writtenHashes: new Map([[rel, hashOfOurs()]]),
      haiveDirs: new Set(),
      haiveEntries: new Map(),
    });
    expect(result.onDisk).toBe(MINE);
    expect(result.skipped).toContainEqual({ path: rel, reason: 'edited since Haive wrote it' });
  });

  it('for a file the .claude sweep claims by the hash its step recorded', async () => {
    const rel = '.claude/workflow-config.json';
    const root = await repoWith({ [rel]: OURS });
    const result = await resetDuringSave(root, rel, {
      writtenHashes: new Map(),
      haiveDirs: new Set(),
      haiveEntries: new Map([[rel, hashOfOurs()]]),
    });
    expect(result.onDisk).toBe(MINE);
    expect(result.skipped).toContainEqual({ path: rel, reason: 'edited since Haive wrote it' });
  });

  it('for a claimed file in a .claude directory the reset walks', async () => {
    const rel = '.claude/plugins/drupal-php-lsp/plugin.json';
    const root = await repoWith({ [rel]: OURS });
    const result = await resetDuringSave(root, rel, {
      writtenHashes: new Map(),
      haiveDirs: new Set(),
      haiveEntries: new Map([[rel, hashOfOurs()]]),
    });
    expect(result.onDisk).toBe(MINE);
    expect(result.skipped).toContainEqual({ path: rel, reason: 'edited since Haive wrote it' });
  });

  it('for a legacy RTK.md outside .claude', async () => {
    const rel = 'RTK.md';
    const root = await repoWith({ [rel]: OURS });
    const result = await resetDuringSave(root, rel, {
      writtenHashes: new Map(),
      haiveDirs: new Set(),
      haiveEntries: new Map([[rel, hashOfOurs()]]),
    });
    expect(result.onDisk).toBe(MINE);
    expect(result.skipped).toContainEqual({ path: rel, reason: 'edited since Haive wrote it' });
  });

  it('for a claimed file in an agents directory that cannot go whole', async () => {
    const rel = '.claude/agents/ours.md';
    // The person's definition cannot be moved aside, since a quarantined one holds its name.
    const root = await repoWith({
      [rel]: OURS,
      '.claude/agents/theirs.md': 'theirs\n',
      '.claude/agents-legacy/theirs.md': 'an earlier run\n',
    });
    const result = await resetDuringSave(root, rel, {
      writtenHashes: new Map(),
      haiveDirs: new Set(['.claude/agents']),
      haiveEntries: new Map([[rel, hashOfOurs()]]),
    });
    expect(result.onDisk).toBe(MINE);
    expect(result.skipped).toContainEqual({ path: rel, reason: 'edited since Haive wrote it' });
  });
});
