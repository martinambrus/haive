import { mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  normalizeContent,
  RTK_REF_MARKER_END,
  RTK_REF_MARKER_START,
  sha256Hex,
} from '@haive/shared';
import { RULES_FILE_READ_CAP, rtkBlockFiles } from '@haive/shared/rules-files';
import {
  restoreRtkBlocks,
  stripRtkBlocks,
  withoutRtkBlocks,
} from '../src/step-engine/steps/onboarding/_rules-files.js';
import { buildRtkAwarenessBlock } from '../src/step-engine/steps/onboarding/_rtk-templates.js';

const LEGACY_REF = `${RTK_REF_MARKER_START}\n@RTK.md\n${RTK_REF_MARKER_END}\n`;

/** What 07's `appendOrCreate` does to a file that has no RTK block yet. */
const appendBlock = (content: string) =>
  `${content}${content.length === 0 || content.endsWith('\n') ? '' : '\n'}${buildRtkAwarenessBlock()}`;

const hashOf = (text: string) => sha256Hex(normalizeContent(text));

describe('withoutRtkBlocks', () => {
  it('is null for a file with no complete block', () => {
    expect(withoutRtkBlocks('# Project\n')).toBeNull();
    expect(withoutRtkBlocks(`# Project\n${RTK_REF_MARKER_START}\nno end\n`)).toBeNull();
    expect(withoutRtkBlocks(`${RTK_REF_MARKER_END}\n${RTK_REF_MARKER_START}\n`)).toBeNull();
  });

  it('takes back exactly what an append wrote, however often RTK is switched', () => {
    for (const original of ['# Project\n\nOur notes.\n', '# Project', '']) {
      let content = original;
      for (let i = 0; i < 3; i++) {
        content = withoutRtkBlocks(appendBlock(content))?.text ?? content;
      }
      expect(content).toBe(
        original.length === 0 || original.endsWith('\n') ? original : `${original}\n`,
      );
    }
  });

  it('keeps the text around a block and takes every block', () => {
    const content = `# Project\n${LEGACY_REF}middle\n${buildRtkAwarenessBlock()}after\n`;
    expect(withoutRtkBlocks(content)).toEqual({
      text: '# Project\nmiddle\nafter\n',
      blocks: [LEGACY_REF, buildRtkAwarenessBlock()],
    });
  });
});

describe('stripRtkBlocks', () => {
  let repo: string;
  let outside: string;

  beforeEach(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), 'haive-rtk-strip-'));
    outside = await mkdtemp(path.join(os.tmpdir(), 'haive-rtk-strip-out-'));
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true }).catch(() => {});
    await rm(outside, { recursive: true, force: true }).catch(() => {});
  });

  const read = (rel: string) => readFile(path.join(repo, rel), 'utf8');
  const noRecord = async () => {};

  it('strips the awareness block and a legacy import, leaving a file with none alone', async () => {
    await writeFile(path.join(repo, 'AGENTS.md'), appendBlock('# Project\n'));
    await writeFile(path.join(repo, 'CLAUDE.md'), `@AGENTS.md\n${LEGACY_REF}`);
    expect(await rtkBlockFiles(repo)).toEqual(['AGENTS.md', 'CLAUDE.md']);

    const recorded: [string, string, string][] = [];
    expect(
      await stripRtkBlocks(repo, async (file, before, after) => {
        recorded.push([file, before, after]);
      }),
    ).toEqual([
      { file: 'AGENTS.md', result: 'stripped' },
      { file: 'CLAUDE.md', result: 'stripped' },
      { file: 'GEMINI.md', result: 'none' },
    ]);
    expect(recorded).toEqual([
      ['AGENTS.md', appendBlock('# Project\n'), '# Project\n'],
      ['CLAUDE.md', `@AGENTS.md\n${LEGACY_REF}`, '@AGENTS.md\n'],
    ]);
    expect(await read('AGENTS.md')).toBe('# Project\n');
    expect(await read('CLAUDE.md')).toBe('@AGENTS.md\n');
    expect(await rtkBlockFiles(repo)).toEqual([]);
    expect((await stripRtkBlocks(repo, noRecord)).map((o) => o.result)).toEqual([
      'none',
      'none',
      'none',
    ]);
  });

  it('leaves a file as it was when its record cannot be written', async () => {
    await writeFile(path.join(repo, 'AGENTS.md'), appendBlock('# Project\n'));
    const [agents] = await stripRtkBlocks(repo, async () => {
      throw new Error('record failed');
    });
    expect(agents).toEqual({ file: 'AGENTS.md', result: 'refused', error: 'record failed' });
    expect(await read('AGENTS.md')).toBe(appendBlock('# Project\n'));
  });

  it('keeps every byte of a file that is not UTF-8, and says why', async () => {
    const bytes = Buffer.concat([
      Buffer.from('# Caf'),
      Buffer.from([0xe9]),
      Buffer.from(`\n${buildRtkAwarenessBlock()}`),
    ]);
    await writeFile(path.join(repo, 'AGENTS.md'), bytes);
    const [agents] = await stripRtkBlocks(repo, noRecord);
    expect(agents).toMatchObject({ file: 'AGENTS.md', result: 'refused' });
    expect(agents!.error).toContain('not valid UTF-8');
    expect((await readFile(path.join(repo, 'AGENTS.md'))).equals(bytes)).toBe(true);
  });

  it('refuses a file past the read cap, which the plan could not report either', async () => {
    const big = appendBlock(`${'x'.repeat(RULES_FILE_READ_CAP)}\n`);
    await writeFile(path.join(repo, 'AGENTS.md'), big);
    expect(await rtkBlockFiles(repo)).toEqual([]);
    const [agents] = await stripRtkBlocks(repo, noRecord);
    expect(agents).toMatchObject({ file: 'AGENTS.md', result: 'refused' });
    expect(await read('AGENTS.md')).toBe(big);
  });

  it('leaves a link to AGENTS.md to AGENTS.md, and refuses any other link', async () => {
    await writeFile(path.join(repo, 'AGENTS.md'), appendBlock('# Project\n'));
    await symlink('AGENTS.md', path.join(repo, 'CLAUDE.md'));
    const elsewhere = path.join(outside, 'GEMINI.md');
    await writeFile(elsewhere, LEGACY_REF);
    await symlink(elsewhere, path.join(repo, 'GEMINI.md'));

    const outcomes = await stripRtkBlocks(repo, noRecord);
    expect(outcomes.map((o) => [o.file, o.result])).toEqual([
      ['AGENTS.md', 'stripped'],
      ['CLAUDE.md', 'skipped-link'],
      ['GEMINI.md', 'refused'],
    ]);
    expect(await read('AGENTS.md')).toBe('# Project\n');
    expect(await readlink(path.join(repo, 'CLAUDE.md'))).toBe('AGENTS.md');
    expect(await readFile(elsewhere, 'utf8')).toBe(LEGACY_REF);
  });
});

describe('restoreRtkBlocks', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), 'haive-rtk-restore-'));
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true }).catch(() => {});
  });

  const file = 'CLAUDE.md';
  const before = `@AGENTS.md\n${LEGACY_REF}More notes.\n`;
  const left = '@AGENTS.md\nMore notes.\n';
  const put = (content: string | Buffer) => writeFile(path.join(repo, file), content);
  const now = () => readFile(path.join(repo, file), 'utf8');
  const restore = () => restoreRtkBlocks(repo, file, before, hashOf(left));

  it('puts the whole file back while it holds what the strip left', async () => {
    await put(left);
    expect(await restore()).toEqual({ outcome: 'restored' });
    expect(await now()).toBe(before);
  });

  it('adds the block back at the end of a file edited since, the way 07 appends it', async () => {
    await put(`${left}Later notes.\n`);
    expect(await restore()).toEqual({ outcome: 'restored' });
    expect(await now()).toBe(`${left}Later notes.\n${LEGACY_REF}`);
    await put('@AGENTS.md');
    expect(await restore()).toEqual({ outcome: 'restored' });
    expect(await now()).toBe(`@AGENTS.md\n${LEGACY_REF}`);
  });

  it('counts the same block standing there as put back', async () => {
    await put(before);
    expect(await restore()).toEqual({ outcome: 'standing' });
    expect(await now()).toBe(before);
  });

  it('keeps a file holding another RTK block, and leaves a removed file removed', async () => {
    const other = `@AGENTS.md\n${buildRtkAwarenessBlock()}`;
    await put(other);
    expect(await restore()).toEqual({ outcome: 'kept', reason: 'it holds another RTK block now' });
    expect(await now()).toBe(other);
    await rm(path.join(repo, file));
    expect(await restore()).toEqual({ outcome: 'absent' });
    await expect(now()).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps a file that is not UTF-8, or a link, as it is', async () => {
    const bytes = Buffer.concat([Buffer.from(left), Buffer.from([0xe9])]);
    await put(bytes);
    expect(await restore()).toMatchObject({ outcome: 'kept' });
    expect((await readFile(path.join(repo, file))).equals(bytes)).toBe(true);
    await rm(path.join(repo, file));
    await writeFile(path.join(repo, 'AGENTS.md'), left);
    await symlink('AGENTS.md', path.join(repo, file));
    expect(await restore()).toMatchObject({ outcome: 'kept' });
    expect(await readFile(path.join(repo, 'AGENTS.md'), 'utf8')).toBe(left);
  });
});
