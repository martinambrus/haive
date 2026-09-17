import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { KB_DIR } from '@haive/shared/knowledge-paths';
import { checkOnboardingMarkers, stripHaiveContent } from '../src/routes/repos.js';

const dirs: string[] = [];

/** A fresh tree per case. `mkdtemp` rather than a fixed name because the walk opens the ANCHOR
 *  itself and will not create it, so a leftover directory from an earlier run is the difference
 *  between a suite that passes here and one that fails on a clean runner. */
async function repo(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function installMarkers(root: string): Promise<void> {
  await mkdir(path.join(root, KB_DIR), { recursive: true });
  await mkdir(path.join(root, '.claude/agents'), { recursive: true });
  await mkdir(path.join(root, '.claude/skills'), { recursive: true });
  await writeFile(path.join(root, '.claude/workflow-config.json'), '{}', 'utf8');
}

describe('stripHaiveContent', () => {
  it('removes the marker regions and keeps the author text', async () => {
    const root = await repo('reset-strip-');
    await writeFile(
      path.join(root, 'AGENTS.md'),
      '# Mine\n\n<!-- haive:project-info -->\ngenerated\n<!-- /haive:project-info -->\n\nkeep me\n',
      'utf8',
    );

    expect(await stripHaiveContent(root, 'AGENTS.md')).toEqual({ changed: true, deleted: false });
    const left = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
    expect(left).toContain('# Mine');
    expect(left).toContain('keep me');
    expect(left).not.toContain('haive:project-info');
  });

  it('deletes a file that was nothing but Haive content', async () => {
    const root = await repo('reset-empty-');
    await writeFile(
      path.join(root, 'CLAUDE.md'),
      '<!-- haive:cli-rules -->\nrules\n<!-- /haive:cli-rules -->\n',
      'utf8',
    );

    expect(await stripHaiveContent(root, 'CLAUDE.md')).toEqual({ changed: true, deleted: true });
    await expect(readFile(path.join(root, 'CLAUDE.md'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('answers null for a file that is not there', async () => {
    // This is what replaced the caller's `pathExists` probe, which followed a link and read a
    // dangling one as absent.
    expect(await stripHaiveContent(await repo('reset-absent-'), 'GEMINI.md')).toBeNull();
  });

  it('refuses a rules file that is a link and leaves its target alone', async () => {
    // The write it replaced followed the link: a repo whose AGENTS.md pointed out of the tree had
    // the FILE ON THE OTHER END rewritten — and emptied out, deleted — by the artifact reset.
    const root = await repo('reset-link-');
    const outside = await repo('reset-link-out-');
    const target = path.join(outside, 'their-agents.md');
    await writeFile(
      target,
      '<!-- haive:cli-rules -->\ntheirs\n<!-- /haive:cli-rules -->\n',
      'utf8',
    );
    await symlink(target, path.join(root, 'AGENTS.md'));

    await expect(stripHaiveContent(root, 'AGENTS.md')).rejects.toMatchObject({ reason: 'link' });
    expect(await readFile(target, 'utf8')).toContain('haive:cli-rules');
  });
});

describe('checkOnboardingMarkers', () => {
  it('finds every marker an onboarding run installs', async () => {
    const root = await repo('markers-');
    await installMarkers(root);

    const { present, missing } = await checkOnboardingMarkers(root);
    expect(missing).toEqual([]);
    expect(present).toHaveLength(4);
  });

  it('does not count an agents directory that is a link', async () => {
    // The onboarded verdict and `mark-onboarded` both rest on these counts, and the `stat`-based
    // probe this replaced followed the link — so definitions living outside the tree counted as
    // installed, and the repo read as onboarded on the strength of them.
    const root = await repo('markers-link-');
    const outside = await repo('markers-link-out-');
    await installMarkers(root);
    await rm(path.join(root, '.claude/agents'), { recursive: true, force: true });
    await mkdir(path.join(outside, 'agents'), { recursive: true });
    await symlink(path.join(outside, 'agents'), path.join(root, '.claude/agents'));

    const { present, missing } = await checkOnboardingMarkers(root);
    expect(missing).toEqual(['.claude/agents']);
    expect(present).not.toContain('.claude/agents');
  });

  it('counts nothing for a repository root that is not there', async () => {
    const { present, missing } = await checkOnboardingMarkers('/definitely/not/a/path');
    expect(present).toEqual([]);
    expect(missing).toHaveLength(4);
  });
});
