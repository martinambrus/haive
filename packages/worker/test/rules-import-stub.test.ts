import { mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureRulesImportStub,
  missingRulesImportStubs,
  restoreRulesImportStubs,
} from '../src/step-engine/steps/onboarding/_rules-files.js';

let repo: string;
let outside: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(os.tmpdir(), 'haive-rules-stub-'));
  outside = await mkdtemp(path.join(os.tmpdir(), 'haive-rules-stub-out-'));
  await writeFile(path.join(outside, 'elsewhere.md'), 'not ours', 'utf8');
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true }).catch(() => {});
  await rm(outside, { recursive: true, force: true }).catch(() => {});
});

const read = (rel: string) => readFile(path.join(repo, rel), 'utf8');

describe('ensureRulesImportStub', () => {
  it('creates a missing file holding the import line alone', async () => {
    expect(await ensureRulesImportStub(repo, 'CLAUDE.md')).toBe('created');
    expect(await read('CLAUDE.md')).toBe('@AGENTS.md\n');
  });

  it('appends the line to a file that lacks it, keeping what was there', async () => {
    await writeFile(path.join(repo, 'CLAUDE.md'), '# Notes\nkeep me', 'utf8');
    expect(await ensureRulesImportStub(repo, 'CLAUDE.md')).toBe('appended');
    expect(await read('CLAUDE.md')).toBe('# Notes\nkeep me\n@AGENTS.md\n');
  });

  it('leaves a file that already imports AGENTS.md untouched', async () => {
    await writeFile(path.join(repo, 'CLAUDE.md'), '@AGENTS.md\n# mine\n', 'utf8');
    expect(await ensureRulesImportStub(repo, 'CLAUDE.md')).toBe('unchanged');
    expect(await read('CLAUDE.md')).toBe('@AGENTS.md\n# mine\n');
  });

  it('skips a rules file that links to AGENTS.md, in either spelling', async () => {
    await symlink('AGENTS.md', path.join(repo, 'CLAUDE.md'));
    await symlink('./AGENTS.md', path.join(repo, 'GEMINI.md'));
    expect(await ensureRulesImportStub(repo, 'CLAUDE.md')).toBe('skipped-link');
    expect(await ensureRulesImportStub(repo, 'GEMINI.md')).toBe('skipped-link');
    expect(await readlink(path.join(repo, 'CLAUDE.md'))).toBe('AGENTS.md');
  });

  it('refuses a rules file linked anywhere else and writes nothing through it', async () => {
    await symlink(path.join(outside, 'elsewhere.md'), path.join(repo, 'CLAUDE.md'));
    await expect(ensureRulesImportStub(repo, 'CLAUDE.md')).rejects.toMatchObject({
      reason: 'link',
    });
    expect(await readFile(path.join(outside, 'elsewhere.md'), 'utf8')).toBe('not ours');
  });
});

describe('restoreRulesImportStubs', () => {
  it('records a refusal per file and still restores the others', async () => {
    await symlink(path.join(outside, 'elsewhere.md'), path.join(repo, 'CLAUDE.md'));
    const outcomes = await restoreRulesImportStubs(repo, ['CLAUDE.md', 'GEMINI.md']);
    expect(outcomes[0]).toMatchObject({ file: 'CLAUDE.md', result: 'refused' });
    expect(outcomes[0]?.error).toBeTruthy();
    expect(outcomes[1]).toEqual({ file: 'GEMINI.md', result: 'created' });
    expect(await read('GEMINI.md')).toBe('@AGENTS.md\n');
  });
});

describe('missingRulesImportStubs', () => {
  it('names the files that do not import AGENTS.md, and not a link to it', async () => {
    await writeFile(path.join(repo, 'CLAUDE.md'), '# no import here\n', 'utf8');
    await symlink('AGENTS.md', path.join(repo, 'GEMINI.md'));
    expect(await missingRulesImportStubs(repo, ['CLAUDE.md', 'GEMINI.md', 'OTHER.md'])).toEqual([
      'CLAUDE.md',
      'OTHER.md',
    ]);
  });
});
