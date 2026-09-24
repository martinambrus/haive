import { mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RTK_REF_MARKER_END, RTK_REF_MARKER_START } from '@haive/shared';
import { RULES_FILE_READ_CAP, rtkBlockFiles } from '@haive/shared/rules-files';
import {
  stripRtkBlocks,
  withoutRtkBlocks,
} from '../src/step-engine/steps/onboarding/_rules-files.js';
import { buildRtkAwarenessBlock } from '../src/step-engine/steps/onboarding/_rtk-templates.js';

const LEGACY_REF = `${RTK_REF_MARKER_START}\n@RTK.md\n${RTK_REF_MARKER_END}\n`;

/** What 07's `appendOrCreate` does to a file that has no RTK block yet. */
const appendBlock = (content: string) =>
  `${content}${content.length === 0 || content.endsWith('\n') ? '' : '\n'}${buildRtkAwarenessBlock()}`;

describe('withoutRtkBlocks', () => {
  it('is null for a file with no complete block', () => {
    expect(withoutRtkBlocks('# Project\n')).toBeNull();
    expect(withoutRtkBlocks(`# Project\n${RTK_REF_MARKER_START}\nno end\n`)).toBeNull();
    expect(withoutRtkBlocks(`${RTK_REF_MARKER_END}\n${RTK_REF_MARKER_START}\n`)).toBeNull();
  });

  it('takes back exactly what an append wrote, however often RTK is switched', () => {
    for (const original of ['# Project\n\nOur notes.\n', '# Project', '']) {
      let content = original;
      for (let i = 0; i < 3; i++) content = withoutRtkBlocks(appendBlock(content)) ?? content;
      expect(content).toBe(
        original.length === 0 || original.endsWith('\n') ? original : `${original}\n`,
      );
    }
  });

  it('keeps the text around a block and takes every block', () => {
    const content = `# Project\n${LEGACY_REF}middle\n${buildRtkAwarenessBlock()}after\n`;
    expect(withoutRtkBlocks(content)).toBe('# Project\nmiddle\nafter\n');
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

  it('strips the awareness block and a legacy import, leaving a file with none alone', async () => {
    await writeFile(path.join(repo, 'AGENTS.md'), appendBlock('# Project\n'));
    await writeFile(path.join(repo, 'CLAUDE.md'), `@AGENTS.md\n${LEGACY_REF}`);
    expect(await rtkBlockFiles(repo)).toEqual(['AGENTS.md', 'CLAUDE.md']);

    expect(await stripRtkBlocks(repo)).toEqual([
      { file: 'AGENTS.md', result: 'stripped' },
      { file: 'CLAUDE.md', result: 'stripped' },
      { file: 'GEMINI.md', result: 'none' },
    ]);
    expect(await read('AGENTS.md')).toBe('# Project\n');
    expect(await read('CLAUDE.md')).toBe('@AGENTS.md\n');
    expect(await rtkBlockFiles(repo)).toEqual([]);
    expect((await stripRtkBlocks(repo)).map((o) => o.result)).toEqual(['none', 'none', 'none']);
  });

  it('refuses a file past the read cap, which the plan could not report either', async () => {
    const big = appendBlock(`${'x'.repeat(RULES_FILE_READ_CAP)}\n`);
    await writeFile(path.join(repo, 'AGENTS.md'), big);
    expect(await rtkBlockFiles(repo)).toEqual([]);
    const [agents] = await stripRtkBlocks(repo);
    expect(agents).toMatchObject({ file: 'AGENTS.md', result: 'refused' });
    expect(await read('AGENTS.md')).toBe(big);
  });

  it('leaves a link to AGENTS.md to AGENTS.md, and refuses any other link', async () => {
    await writeFile(path.join(repo, 'AGENTS.md'), appendBlock('# Project\n'));
    await symlink('AGENTS.md', path.join(repo, 'CLAUDE.md'));
    const elsewhere = path.join(outside, 'GEMINI.md');
    await writeFile(elsewhere, LEGACY_REF);
    await symlink(elsewhere, path.join(repo, 'GEMINI.md'));

    const outcomes = await stripRtkBlocks(repo);
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
