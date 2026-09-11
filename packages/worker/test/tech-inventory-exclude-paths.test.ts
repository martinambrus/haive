import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildTechInventory } from '../src/step-engine/steps/onboarding/_tech-inventory.js';

// IGNORE_DIRS matches a bare directory NAME (`vendor`, `node_modules`), which cannot
// express a third-party tree that lives at a PATH. MEASURED on a live Drupal 7 repo: a
// `symfony/polyfill-mbstring` vendored inside `sites/all/libraries/PhpSpreadsheet`
// counted as the Symfony FRAMEWORK and put `symfony-specialist` on the user's form.
describe('buildTechInventory — excludePaths', () => {
  let dir: string;

  const write = async (rel: string, body: string): Promise<void> => {
    const abs = path.join(dir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, body);
  };

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'haive-techinv-'));
    // Real code: D7 procedural hooks.
    for (const n of ['a', 'b', 'c']) {
      await write(
        `sites/all/modules/custom/activit/${n}.module`,
        '<?php function x_menu(){} hook_menu();',
      );
    }
    // Third-party, vendored at a PATH rather than in a dir called `vendor`.
    for (const n of ['x', 'y', 'z']) {
      await write(
        `sites/all/libraries/PhpSpreadsheet/symfony/polyfill/${n}.php`,
        '<?php\nuse Symfony\\Polyfill\\Mbstring;\n',
      );
    }
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const names = (inv: { items: { name: string }[] }): string[] =>
    inv.items.map((i) => i.name).sort();

  it('counts a vendored tree as real usage when nothing is excluded', async () => {
    expect(names(await buildTechInventory(dir))).toContain('symfony');
  });

  it('drops it once the framework names that path', async () => {
    const inv = await buildTechInventory(dir, { excludePaths: ['sites/all/libraries/'] });
    expect(names(inv)).not.toContain('symfony');
  });

  // The exclusion must not cost the project its own stack.
  it('keeps the project code that lives outside the excluded path', async () => {
    const inv = await buildTechInventory(dir, { excludePaths: ['sites/all/libraries/'] });
    expect(names(inv)).toContain('drupal-7');
  });

  it('tolerates leading and trailing slashes in the pattern', async () => {
    for (const p of ['/sites/all/libraries', 'sites/all/libraries', 'sites/all/libraries/']) {
      expect(names(await buildTechInventory(dir, { excludePaths: [p] }))).not.toContain('symfony');
    }
  });

  // A prefix must match a whole path SEGMENT, never a partial name.
  it('does not exclude a sibling whose name merely starts the same', async () => {
    const inv = await buildTechInventory(dir, { excludePaths: ['sites/all/lib'] });
    expect(names(inv)).toContain('symfony');
  });

  it('is unchanged from the old behaviour when given no paths', async () => {
    expect(names(await buildTechInventory(dir, {}))).toEqual(names(await buildTechInventory(dir)));
  });
});
