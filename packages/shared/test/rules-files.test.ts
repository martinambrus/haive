import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importRulesFilesFor, RULES_FILE_READ_CAP, rulesImportState } from '../src/rules-files.js';

describe('importRulesFilesFor', () => {
  it('names each import-mode rules file once, in provider order', () => {
    expect(importRulesFilesFor(['gemini', 'claude-code', 'zai'])).toEqual([
      'GEMINI.md',
      'CLAUDE.md',
    ]);
  });

  it('names nothing for a CLI that reads AGENTS.md itself, or one the catalog does not know', () => {
    expect(importRulesFilesFor(['codex', 'amp', 'grok', 'antigravity', 'no-such-cli'])).toEqual([]);
  });
});

describe('rulesImportState', () => {
  let repo: string;
  let outside: string;

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'rules-files-'));
    outside = await mkdtemp(path.join(tmpdir(), 'rules-files-out-'));
    await writeFile(path.join(outside, 'elsewhere.md'), '@AGENTS.md\n', 'utf8');
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('reads a file holding the import line as present, and one without it as missing', async () => {
    await writeFile(path.join(repo, 'CLAUDE.md'), '# mine\n@AGENTS.md\n', 'utf8');
    await writeFile(path.join(repo, 'GEMINI.md'), '# no import here\n', 'utf8');
    expect(await rulesImportState(repo, 'CLAUDE.md')).toBe('present');
    expect(await rulesImportState(repo, 'GEMINI.md')).toBe('missing');
    expect(await rulesImportState(repo, 'OTHER.md')).toBe('missing');
  });

  it('reads a link to AGENTS.md as present, in either spelling', async () => {
    await symlink('AGENTS.md', path.join(repo, 'CLAUDE.md'));
    await symlink('./AGENTS.md', path.join(repo, 'GEMINI.md'));
    expect(await rulesImportState(repo, 'CLAUDE.md')).toBe('present');
    expect(await rulesImportState(repo, 'GEMINI.md')).toBe('present');
  });

  it('reads any other link as linked elsewhere, without following it', async () => {
    await symlink(path.join(outside, 'elsewhere.md'), path.join(repo, 'CLAUDE.md'));
    expect(await rulesImportState(repo, 'CLAUDE.md')).toBe('linked-elsewhere');
  });

  it('reads a file past the cap, or a directory, as unreadable', async () => {
    await writeFile(path.join(repo, 'CLAUDE.md'), 'x'.repeat(RULES_FILE_READ_CAP + 1), 'utf8');
    await mkdir(path.join(repo, 'GEMINI.md'));
    expect(await rulesImportState(repo, 'CLAUDE.md')).toBe('unreadable');
    expect(await rulesImportState(repo, 'GEMINI.md')).toBe('unreadable');
  });
});
