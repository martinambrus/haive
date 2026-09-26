import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface Swap {
  when: string;
  path: string;
  content: string;
  then?: Swap;
}

const h = vi.hoisted(() => ({
  swap: null as null | Swap,
  longest: 0,
}));

vi.mock('@haive/shared', async (importOriginal) => {
  const real = await importOriginal<typeof import('@haive/shared')>();
  return {
    ...real,
    // A person saving the file at the moment the reset hashes it to decide whether it is Haive's.
    sha256Hex: (input: string) => {
      h.longest = Math.max(h.longest, input.length);
      const swap = h.swap;
      if (swap && input === swap.when) {
        h.swap = swap.then ?? null;
        writeFileSync(swap.path, swap.content);
      }
      return real.sha256Hex(input);
    },
  };
});

import { normalizeContent, sha256Hex } from '@haive/shared';
import { resetOnboardingArtifacts, type OnboardingResetProvenance } from '../src/routes/repos.js';
import { MAX_FILE_CONTENT_BYTES } from '../src/routes/tasks/_helpers.js';

const OURS = '{"haive":"generated"}\n';
const MINE = 'MINE\n';

const dirs: string[] = [];
afterEach(async () => {
  h.swap = null;
  h.longest = 0;
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

describe('a file the reset cannot put back', () => {
  it('is reported with where it is, and the reset carries on', async () => {
    const rel = '.claude/settings.json';
    const other = '.claude/workflow-config.json';
    const OTHER = '{"haive":"config"}\n';
    const root = await repoWith({ [rel]: OURS, [other]: OTHER });
    const provenance = {
      writtenHashes: new Map([[rel, hashOfOurs()]]),
      haiveDirs: new Set<string>(),
      haiveEntries: new Map([[other, sha256Hex(normalizeContent(OTHER))]]),
    };
    // Saved over after the reset read it as Haive's, and again while the copy it parked is judged.
    h.swap = {
      when: normalizeContent(OURS),
      path: path.join(root, rel),
      content: MINE,
      then: { when: normalizeContent(MINE), path: path.join(root, rel), content: 'AGAIN\n' },
    };
    const outcome = await resetOnboardingArtifacts(root, provenance);
    expect(h.swap).toBeNull();

    expect(await readFile(path.join(root, rel), 'utf8')).toBe('AGAIN\n');
    const parked = (await readdir(path.join(root, '.claude'))).filter((n) =>
      n.includes('.haive-park-'),
    );
    expect(parked).toHaveLength(1);
    expect(await readFile(path.join(root, '.claude', parked[0]!), 'utf8')).toBe(MINE);
    expect(outcome.skipped).toContainEqual({
      path: rel,
      reason: `EEXIST; the file is now at .claude/${parked[0]}`,
    });
    expect(outcome.removed).toContain(other);
  });
});

describe('the reset reads no claimed file past the size cap', () => {
  // Twice the cap, so a whole read and a capped one (the cap plus the newline normalizing adds)
  // cannot be mistaken for each other.
  const big = 'x'.repeat(2 * MAX_FILE_CONTENT_BYTES);

  it('keeps one that grows past it while it is being judged, without reading it', async () => {
    const rel = '.claude/settings.json';
    const root = await repoWith({ [rel]: OURS });
    // Built before the swap is armed, since the hash below would otherwise set it off.
    const provenance = {
      writtenHashes: new Map([[rel, hashOfOurs()]]),
      haiveDirs: new Set<string>(),
      haiveEntries: new Map<string, string | null>(),
    };
    h.swap = { when: normalizeContent(OURS), path: path.join(root, rel), content: big };
    const outcome = await resetOnboardingArtifacts(root, provenance);
    expect(h.swap).toBeNull();
    expect((await readFile(path.join(root, rel), 'utf8')).length).toBe(big.length);
    expect(outcome.skipped).toContainEqual({ path: rel, reason: 'edited since Haive wrote it' });
    expect(h.longest).toBeLessThanOrEqual(MAX_FILE_CONTENT_BYTES + 1);
  });

  it.each([
    ['a settings file its row names', '.claude/settings.json', 'row'],
    ['a file its row names', '.claude/workflow-config.json', 'row'],
    ['a file its step recorded', '.claude/workflow-config.json', 'step'],
  ] as const)('keeps %s already past it, even holding the recorded bytes', async (_, rel, by) => {
    const root = await repoWith({ [rel]: big });
    const recorded = sha256Hex(normalizeContent(big));
    h.longest = 0;
    await resetOnboardingArtifacts(root, {
      writtenHashes: new Map(by === 'row' ? [[rel, recorded]] : []),
      haiveDirs: new Set(),
      haiveEntries: new Map(by === 'step' ? [[rel, recorded]] : []),
    });
    expect((await readFile(path.join(root, rel), 'utf8')).length).toBe(big.length);
    expect(h.longest).toBeLessThanOrEqual(MAX_FILE_CONTENT_BYTES + 1);
  });
});
