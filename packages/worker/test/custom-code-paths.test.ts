import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectPathsForTest } from '../src/step-engine/steps/onboarding/01-env-detect.js';
import { repoOwnRef } from '../src/step-engine/steps/onboarding/08-knowledge-acquisition.js';

// MEASURED across nine onboarding runs of one Drupal 7 repo — identical on claude-code,
// codex sol, codex astra, grok, glm and muse, because this value never reaches a model:
// `customCodePaths.include` came back as the framework CONVENTION
// (`sites/all/modules/custom/`) while the repo's own module sat at
// `sites/all/modules/activit/`. Downstream, a non-empty include is authoritative, so no
// file matched it, `repoOwnRef` never fired, and a repo-specific page reached the SHARED
// global KB.
let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(path.join(os.tmpdir(), 'haive-custompaths-'));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true }).catch(() => {});
});

describe('detectPaths: customCodePaths are checked against the tree', () => {
  it('drops a convention directory this repo does not have', async () => {
    await mkdir(path.join(repo, 'sites/all/modules/activit'), { recursive: true });
    const paths = await detectPathsForTest(repo, 'drupal7');
    expect(paths.customCodePaths.include).toEqual([]);
    // The exclude list is a different thing: those ARE real Drupal core dirs and the
    // fallback predicate depends on them, so it is reported whether present or not.
    expect(paths.customCodePaths.exclude).toContain('includes/');
  });

  it('keeps the convention directory when the repo actually uses it', async () => {
    await mkdir(path.join(repo, 'sites/all/modules/custom'), { recursive: true });
    const paths = await detectPathsForTest(repo, 'drupal7');
    expect(paths.customCodePaths.include).toEqual(['sites/all/modules/custom/']);
  });
});

describe('repoOwnRef: an include that matches nothing is no include at all', () => {
  const detect = (include: string[]) =>
    ({ customCode: { include, exclude: ['includes/', 'modules/'] } }) as never;

  it('falls back to the heuristic when the stored include exists nowhere', async () => {
    // The persisted-payload case: a detect output written before the filter existed still
    // names a directory this repo has never had. With nothing usable left, the heuristic
    // decides — and here it can, because no exclude prefix matches.
    await mkdir(path.join(repo, 'src'), { recursive: true });
    await writeFile(path.join(repo, 'src/app.php'), 'x');
    const ref = await repoOwnRef(
      'see `src/app.php` for the entry point',
      undefined,
      detect(['lib/']),
      repo,
    );
    expect(ref).toBe('src/app.php');
  });

  it('still honours an include that does describe the repo', async () => {
    await mkdir(path.join(repo, 'sites/all/modules/custom/mine'), { recursive: true });
    await writeFile(path.join(repo, 'sites/all/modules/custom/mine/a.module'), 'x');
    await mkdir(path.join(repo, 'modules/contrib'), { recursive: true });
    await writeFile(path.join(repo, 'modules/contrib/b.module'), 'x');
    const inc = detect(['sites/all/modules/custom/']);
    expect(await repoOwnRef('`sites/all/modules/custom/mine/a.module`', undefined, inc, repo)).toBe(
      'sites/all/modules/custom/mine/a.module',
    );
    // A vendor path must not become repo-own just because the include is usable.
    expect(await repoOwnRef('`modules/contrib/b.module`', undefined, inc, repo)).toBeNull();
  });
});

describe('detectPaths: a Drupal site that ignores the custom/ convention', () => {
  // MEASURED on a live Drupal 7 site: 40 modules carry a `.info` and exactly one lacks
  // `project`, which drupal.org's packaging script stamps into every contrib release.
  it('finds the hand-written extension and leaves contrib alone', async () => {
    const mk = async (rel: string, info: string) => {
      await mkdir(path.join(repo, rel), { recursive: true });
      await writeFile(path.join(repo, rel, `${path.basename(rel)}.info`), info);
    };
    await mk('sites/all/modules/activit', 'name = Activit\nversion = 1.0\n');
    await mk('sites/all/modules/webform', 'name = Webform\nproject = "webform"\ndatestamp = "1"\n');
    await mk('sites/all/themes/activit', 'name = Activit theme\n');
    // A grouping dir with no info file must not be claimed.
    await mkdir(path.join(repo, 'sites/all/modules/contrib'), { recursive: true });

    const paths = await detectPathsForTest(repo, 'drupal7');
    expect(paths.customCodePaths.include).toEqual([
      'sites/all/modules/activit/',
      'sites/all/themes/activit/',
    ]);
  });

  it('and that include then beats the bare modules/ exclude', async () => {
    // The whole point: `modules/` matches anywhere, so before the specificity rule the
    // site's own module could never be repo-own.
    await mkdir(path.join(repo, 'sites/all/modules/activit'), { recursive: true });
    await writeFile(path.join(repo, 'sites/all/modules/activit/activit.module'), 'x');
    const ref = await repoOwnRef(
      'see `sites/all/modules/activit/activit.module`',
      undefined,
      {
        customCode: {
          include: ['sites/all/modules/activit/'],
          exclude: ['includes/', 'modules/', 'themes/'],
        },
      } as never,
      repo,
    );
    expect(ref).toBe('sites/all/modules/activit/activit.module');
  });
});
