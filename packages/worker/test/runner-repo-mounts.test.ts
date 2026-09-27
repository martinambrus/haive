import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RUNNER_SUBPATH_LABEL } from '@haive/shared';
import { buildMountArgs } from '../src/sandbox/docker-runner.js';

const SUBPATH = '11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222';
const DUMP_DIR = '_uploads/33333333-3333-3333-3333-333333333333';

/** What both runners now emit for their repository volume. Spelled here rather than driven through
 *  `startAppRunner`/`startDdevRunner`, which need docker, an image and a task row; what has to hold
 *  is the ARGV shape — the destination is unchanged, so every `/repos/<subpath>` path a step builds
 *  still resolves, and no argument mounts the volume root. */
const repoMountArgs = (subpath: string, dumpDir?: string): string[] =>
  buildMountArgs([
    { source: 'haive_repos', target: `/repos/${subpath}`, subpath },
    ...(dumpDir
      ? [{ source: 'haive_repos', target: `/repos/${dumpDir}`, subpath: dumpDir, readOnly: true }]
      : []),
  ]);

describe('a runtime runner mounts', () => {
  it('its own repository subpath at the path it always had, and never the volume root', () => {
    const args = repoMountArgs(SUBPATH);
    expect(args.join(' ')).toContain(`destination=/repos/${SUBPATH}`);
    expect(args.join(' ')).toContain(`volume-subpath=${SUBPATH}`);
    // The whole-volume form this replaced: `-v haive_repos:/repos`.
    expect(args).not.toContain('haive_repos:/repos');
    expect(args.join(' ')).not.toContain('destination=/repos,');
  });

  it('the database dump read-only, and only its own', () => {
    const args = repoMountArgs(SUBPATH, DUMP_DIR).join(' ');
    // `ddev import-db` reads the dump by the `/repos/_uploads/...` path 01c translates it to, and
    // that directory is outside the repository subpath.
    expect(args).toContain(`destination=/repos/${DUMP_DIR}`);
    expect(args).toContain(`volume-subpath=${DUMP_DIR}`);
    const dumpFlag = args.split('--mount ').find((a) => a.includes(DUMP_DIR)) ?? '';
    expect(dumpFlag).toContain('readonly');
    const repoFlag = args.split('--mount ').find((a) => a.includes(`volume-subpath=${SUBPATH},`));
    expect(repoFlag).toBeDefined();
    expect(repoFlag).not.toContain('readonly');
  });

  it('nothing for the dump when the task has none', () => {
    expect(repoMountArgs(SUBPATH).join(' ')).not.toContain('_uploads');
  });
});

describe('the boot-subpath label', () => {
  it('is the one a reuse compares against', () => {
    // Stamped at create by all three runners; `runnerSubpathVerdict` reads exactly this key, and
    // an EMPTY value (a container from before this existed, mounting the whole volume) is `other`.
    expect(RUNNER_SUBPATH_LABEL).toBe('haive.repo.subpath');
  });
});

describe('no container mounts the repos volume whole', () => {
  it('has no whole-volume argument left in the sandbox sources', async () => {
    // The argv assertions above are built here rather than driven through `startAppRunner` /
    // `startDdevRunner`, which need docker, an image and a task row — so on their own they stay
    // green if a runner goes back to `-v <volume>:/repos`. This is what bites: the mount must name
    // a subpath, so a destination of exactly `/repos` (or `/repos` with nothing after it) is the
    // shape that may not come back.
    const dir = fileURLToPath(new URL('../src/sandbox/', import.meta.url));
    const offenders: string[] = [];
    for (const rel of await readdir(dir, { recursive: true })) {
      if (!rel.endsWith('.ts') || rel.endsWith('.test.ts')) continue;
      const text = await readFile(path.join(dir, rel), 'utf8');
      for (const m of text.matchAll(
        /(?:`\$\{REPO_VOLUME\}:\/repos`|destination=\/repos[,`'"\s])/g,
      )) {
        offenders.push(`sandbox/${rel}:${text.slice(0, m.index).split('\n').length}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
