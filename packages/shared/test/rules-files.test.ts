import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  importRulesFilesFor,
  readUpgradeFile,
  removableClaim,
  RULES_FILE_READ_CAP,
  rulesImportState,
  rtkBlockFiles,
} from '../src/rules-files.js';
import { RTK_REF_MARKER_END, RTK_REF_MARKER_START } from '../src/templates/cli-rules.js';
import { normalizeContent, sha256Hex } from '../src/templates/manifest.js';
import { buildClaudeSettingsJson } from '../src/templates/rtk-settings.js';

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

  it('reads a file that is not UTF-8 as present while it holds the line, else as unreadable', async () => {
    const bad = Buffer.from([0xe9, 0x0a]);
    await writeFile(
      path.join(repo, 'CLAUDE.md'),
      Buffer.concat([bad, Buffer.from('@AGENTS.md\n')]),
    );
    await writeFile(path.join(repo, 'GEMINI.md'), bad);
    expect(await rulesImportState(repo, 'CLAUDE.md')).toBe('present');
    expect(await rulesImportState(repo, 'GEMINI.md')).toBe('unreadable');
  });
});

describe('rtkBlockFiles', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'rtk-block-files-'));
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('names a file holding the block, and none that is not UTF-8, which no strip can edit', async () => {
    const block = `${RTK_REF_MARKER_START}\nrtk\n${RTK_REF_MARKER_END}\n`;
    await writeFile(path.join(repo, 'AGENTS.md'), block, 'utf8');
    await writeFile(
      path.join(repo, 'CLAUDE.md'),
      Buffer.concat([Buffer.from([0xe9, 0x0a]), Buffer.from(block)]),
    );
    expect(await rtkBlockFiles(repo)).toEqual(['AGENTS.md']);
  });
});

describe('readUpgradeFile', () => {
  let repo: string;
  let outside: string;

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'upgrade-read-'));
    outside = await mkdtemp(path.join(tmpdir(), 'upgrade-read-out-'));
    await writeFile(path.join(outside, 'elsewhere.md'), 'not ours', 'utf8');
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('reads a file up to the cap, and reports nothing there as absent', async () => {
    await writeFile(path.join(repo, 'a.md'), 'x'.repeat(RULES_FILE_READ_CAP), 'utf8');
    const read = await readUpgradeFile(repo, 'a.md');
    expect(read.kind === 'text' && read.text.length).toBe(RULES_FILE_READ_CAP);
    expect(await readUpgradeFile(repo, 'missing.md')).toEqual({ kind: 'absent' });
    expect(await readUpgradeFile(repo, 'no-dir/missing.md')).toEqual({ kind: 'absent' });
  });

  it('reads no file past the cap', async () => {
    await writeFile(path.join(repo, 'big.md'), 'x'.repeat(RULES_FILE_READ_CAP + 1), 'utf8');
    expect(await readUpgradeFile(repo, 'big.md')).toEqual({ kind: 'unread', reason: 'oversized' });
  });

  it('reads a link, a directory or a path through a link as unread, never as absent', async () => {
    await symlink(path.join(outside, 'elsewhere.md'), path.join(repo, 'link.md'));
    await mkdir(path.join(repo, 'dir.md'));
    await symlink(outside, path.join(repo, 'sub'));
    const unread = { kind: 'unread', reason: 'unreadable' };
    expect(await readUpgradeFile(repo, 'link.md')).toEqual(unread);
    expect(await readUpgradeFile(repo, 'dir.md')).toEqual(unread);
    expect(await readUpgradeFile(repo, 'sub/elsewhere.md')).toEqual(unread);
  });

  it('reads a file that is not UTF-8 as unread, and one holding U+FFFD itself as text', async () => {
    await writeFile(path.join(repo, 'latin1.md'), Buffer.from([0x43, 0x61, 0x66, 0xe9]));
    await writeFile(path.join(repo, 'bom.md'), '﻿x�', 'utf8');
    expect(await readUpgradeFile(repo, 'latin1.md')).toEqual({
      kind: 'unread',
      reason: 'undecodable',
    });
    expect(await readUpgradeFile(repo, 'bom.md')).toEqual({ kind: 'text', text: '﻿x�' });
  });
});

describe('removableClaim', () => {
  // Not normalize-stable: CRLF line ends, trailing spaces and extra blank lines.
  const WROTE = 'recorded body  \r\nwith CRLF line ends\r\n\r\n\r\n';
  const claim = { templateId: 'agent.old', writtenHash: sha256Hex(normalizeContent(WROTE)) };
  const text = (body: string) => ({ kind: 'text', text: body }) as const;

  it('holds for a path with nothing at it', () => {
    expect(removableClaim({ kind: 'absent' }, claim)).toBe(true);
  });

  it('holds for a file with the bytes its row records, however they are spelled', () => {
    expect(normalizeContent(WROTE)).not.toBe(WROTE);
    expect(removableClaim(text(WROTE), claim)).toBe(true);
    expect(removableClaim(text(normalizeContent(WROTE)), claim)).toBe(true);
  });

  it('does not hold for a file that was changed, or one that could not be read whole', () => {
    expect(removableClaim(text('a person changed this\n'), claim)).toBe(false);
    expect(removableClaim({ kind: 'unread', reason: 'oversized' }, claim)).toBe(false);
    expect(removableClaim({ kind: 'unread', reason: 'unreadable' }, claim)).toBe(false);
  });

  it('holds for an RTK settings file edited around the hook, which can have the hook taken out', () => {
    const rtk = { templateId: 'rtk.claude-settings', writtenHash: 'what-its-row-records' };
    const edited = buildClaudeSettingsJson().replace('{\n', '{\n  "model": "ours",\n');
    expect(removableClaim(text(edited), rtk)).toBe(true);
    expect(removableClaim(text('{\n  "model": "ours"\n}\n'), rtk)).toBe(false);
    expect(removableClaim(text(edited), { ...rtk, templateId: 'agent.old' })).toBe(false);
  });
});
