import { execFile } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { hardenGitArgs } from '@haive/shared/git-args';
import {
  ensureDirNoFollow,
  lstatNoFollow,
  readFileNoFollow,
  readdirNoFollow,
  writeFileNoFollow,
} from '@haive/shared/fs-safe';
import {
  claimFileName,
  emptyProjectState,
  parseProjectState,
  renderProjectState,
} from '@haive/shared/project-state';
import { resetOnboardingArtifacts } from '../src/routes/repos.js';

const exec = promisify(execFile);
const roots: string[] = [];
const state = '.haive-data/state';
const legacyPath = '.git/hooks/pre-commit';
const claim = claimFileName(legacyPath);
const provenance = {
  writtenHashes: new Map<string, string>(),
  haiveDirs: new Set<string>(),
  haiveEntries: new Map<string, string | null>(),
};
const git = async (root: string, args: string[]) =>
  exec(
    'git',
    hardenGitArgs(['-c', 'user.name=probe', '-c', 'user.email=probe@example.test', ...args]),
    {
      cwd: root,
    },
  );
async function readRecord(root: string) {
  const files = new Map<string, string>();
  const walk = async (rel: string) => {
    for (const entry of (await readdirNoFollow(root, rel, { strict: true })) ?? []) {
      const name = `${rel}/${entry.name}`;
      if (entry.isDirectory()) await walk(name);
      else {
        const read = await readFileNoFollow(root, name, { strict: true });
        if (read) files.set(name.slice(state.length + 1), read.data.toString('utf8'));
      }
    }
  };
  await walk(state);
  return files;
}
async function buildFixture() {
  const root = await mkdtemp(join(tmpdir(), 'git-reset-claim-'));
  await git(root, ['init', '-q', '-b', 'main']);
  await ensureDirNoFollow(root, `${state}/artifacts`);
  await ensureDirNoFollow(root, `${state}/project`);
  for (const [rel, text] of renderProjectState({
    ...emptyProjectState(),
    render: {
      projectInfo: {},
      framework: null,
      acceptedAgentIds: [],
      customAgentSpecs: [],
      lspLanguages: [],
    },
  }))
    await writeFileNoFollow(root, `${state}/${rel}`, text);
  await git(root, ['add', '.haive-data']);
  await git(root, ['commit', '-qm', 'last synchronized record']);
  return root;
}

let template: string;
beforeAll(async () => {
  template = await buildFixture();
});
afterAll(async () => {
  if (template) await rm(template, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'git-reset-claim-copy-'));
  roots.push(root);
  await cp(template, root, { recursive: true });
  return root;
}

describe('reset after a user merges a compatible legacy claim before the observer syncs', () => {
  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  it('removes an owned codec-valid git-data claim and leaves the record absent', async () => {
    const root = await fixture();
    // A teammate/archived branch from before the git-data writer ban is supported input.
    // No live ledger row or sync base can name this newly merged legacy claim yet.
    await git(root, ['checkout', '-qb', 'teammate']);
    const legacy = {
      path: legacyPath,
      templateId: 'agent.code-reviewer',
      kind: 'agent',
      schemaVersion: 1,
      templateHash: 'a'.repeat(64),
      writtenHash: 'b'.repeat(64),
      haiveVersion: '0.1.0',
    };
    await writeFileNoFollow(root, `${state}/${claim}`, `${JSON.stringify(legacy)}\n`);
    await git(root, ['add', '.haive-data']);
    await git(root, ['commit', '-qm', 'legacy team record']);
    await git(root, ['checkout', '-q', 'main']);
    await git(root, ['merge', '--ff-only', 'teammate']);
    expect(parseProjectState(await readRecord(root))).toMatchObject({
      ok: true,
      gitDataClaims: [legacy],
    });

    await resetOnboardingArtifacts(root, provenance);
    const remaining = await readRecord(root);
    expect.soft(await lstatNoFollow(root, `${state}/${claim}`)).toBeNull();
    // The sync and record writer parse any nonempty remainder, rather than treating it as absent.
    expect.soft(remaining.size === 0 ? 'absent' : parseProjectState(remaining)).toBe('absent');
  });

  it('takes back a base-owned legacy claim while preserving unknown neighboring files', async () => {
    const root = await fixture();
    await writeFileNoFollow(root, `${state}/${claim}`, '{}\n');
    await writeFileNoFollow(root, `${state}/artifacts/personal.txt`, 'personal\n');
    await resetOnboardingArtifacts(root, { ...provenance, baseGitDataPaths: [legacyPath] });
    expect(await lstatNoFollow(root, `${state}/${claim}`)).toBeNull();
    const kept = await readFileNoFollow(root, `${state}/artifacts/personal.txt`, { strict: true });
    expect(kept?.data.toString()).toBe('personal\n');
  });
});
