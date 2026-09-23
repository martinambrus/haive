import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appliedImportStubs,
  appliedWrittenPaths,
  headLacksImport,
} from '../src/step-engine/steps/onboarding-upgrade/03-upgrade-commit.js';

const run = promisify(execFile);

describe('appliedWrittenPaths', () => {
  it('stages the repository paths 02 reports writing', () => {
    expect(
      appliedWrittenPaths({ writtenPaths: ['AGENTS.md', 'CLAUDE.md', '.claude/x.md'] }),
    ).toEqual(['AGENTS.md', 'CLAUDE.md', '.claude/x.md']);
  });

  it('drops anything that is not a path inside the repository', () => {
    expect(
      appliedWrittenPaths({ writtenPaths: ['../escape.md', '/etc/passwd', '', 42, 'AGENTS.md'] }),
    ).toEqual(['AGENTS.md']);
  });

  it('reads nothing from an output persisted before the field existed', () => {
    expect(appliedWrittenPaths({ appliedCount: 1 })).toEqual([]);
    expect(appliedWrittenPaths(null)).toEqual([]);
  });
});

describe('appliedImportStubs', () => {
  it('keeps every stub left holding the import, including one 02 did not have to write', () => {
    expect(
      appliedImportStubs({
        rulesImportStubs: [
          { file: 'CLAUDE.md', result: 'unchanged' },
          { file: 'GEMINI.md', result: 'created' },
          { file: 'x/CLAUDE.md', result: 'appended' },
        ],
      }),
    ).toEqual(['CLAUDE.md', 'GEMINI.md', 'x/CLAUDE.md']);
  });

  it('skips a refused stub and a link to AGENTS.md', () => {
    expect(
      appliedImportStubs({
        rulesImportStubs: [
          { file: 'CLAUDE.md', result: 'refused', error: 'link' },
          { file: 'GEMINI.md', result: 'skipped-link' },
        ],
      }),
    ).toEqual([]);
  });

  it('drops malformed entries and paths outside the repository', () => {
    expect(
      appliedImportStubs({
        rulesImportStubs: [
          null,
          { file: 7, result: 'created' },
          { file: '../CLAUDE.md', result: 'created' },
          { file: 'CLAUDE.md' },
        ],
      }),
    ).toEqual([]);
  });

  it('reads nothing from an output persisted before the field existed', () => {
    expect(appliedImportStubs({ writtenPaths: ['CLAUDE.md'] })).toEqual([]);
    expect(appliedImportStubs(null)).toEqual([]);
  });
});

describe('headLacksImport', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'haive-upgrade-commit-'));
    await run('git', ['-C', repo, 'init', '-q']);
    await run('git', ['-C', repo, 'config', 'user.email', 't@example.com']);
    await run('git', ['-C', repo, 'config', 'user.name', 'T']);
    await run('git', ['-C', repo, 'config', 'gc.auto', '0']);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  const commit = async (name: string, body: string): Promise<void> => {
    await writeFile(join(repo, name), body);
    await run('git', ['-C', repo, 'add', '--', name]);
    await run('git', ['-C', repo, 'commit', '-qm', name]);
  };

  it('is true before the first commit', async () => {
    await writeFile(join(repo, 'CLAUDE.md'), '@AGENTS.md\n');
    expect(await headLacksImport(repo, 'CLAUDE.md')).toBe(true);
  });

  it('is true for a stub on disk that was never committed', async () => {
    await commit('README.md', 'hi\n');
    await writeFile(join(repo, 'CLAUDE.md'), '@AGENTS.md\n');
    expect(await headLacksImport(repo, 'CLAUDE.md')).toBe(true);
  });

  it('is true when the committed copy lacks the line, however the working copy looks', async () => {
    await commit('CLAUDE.md', '# Notes\n');
    await writeFile(join(repo, 'CLAUDE.md'), '# Notes\n@AGENTS.md\n');
    expect(await headLacksImport(repo, 'CLAUDE.md')).toBe(true);
  });

  it('is false once HEAD carries the line, so a clean stub is never re-staged', async () => {
    await commit('CLAUDE.md', '# Notes\n@AGENTS.md\n');
    await writeFile(join(repo, 'CLAUDE.md'), '# Notes, edited\n@AGENTS.md\n');
    expect(await headLacksImport(repo, 'CLAUDE.md')).toBe(false);
  });
});
