import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLI_RULES_END,
  CLI_RULES_START,
  CLI_RULES_TEMPLATE_KIND,
  normalizeContent,
  sha256Hex,
} from '@haive/shared';
import {
  classifyApplyAction,
  pathContent,
  removeIfHaives,
  resolveBundleItemId,
  safeDiskRel,
  type ApplyAction,
  type ApplySelections,
} from '../src/step-engine/steps/onboarding-upgrade/02-upgrade-apply.js';
import type {
  UpgradePlanBucket,
  UpgradePlanEntry,
} from '../src/step-engine/steps/onboarding-upgrade/01-upgrade-plan.js';

function entry(
  bucket: UpgradePlanBucket,
  diskPath: string,
  partial: Partial<UpgradePlanEntry> = {},
): UpgradePlanEntry {
  return {
    entryId: `e:${diskPath}:${bucket}`,
    bucket,
    templateId: 'template.x',
    templateKind: 'agent',
    diskPath,
    liveArtifactId: null,
    currentContent: null,
    newContent: null,
    baselineContent: null,
    currentHash: null,
    baselineWrittenHash: null,
    newContentHash: null,
    baselineTemplateContentHash: null,
    currentTemplateContentHash: null,
    templateSchemaVersion: 1,
    delta: null,
    ...partial,
  };
}

function selections(over: Partial<ApplySelections> = {}): ApplySelections {
  return {
    selectedUpdates: new Set(),
    selectedNew: new Set(),
    selectedReinstate: new Set(),
    selectedObsoleteRemovals: new Set(),
    selectedRtkHookStrips: new Set(),
    conflictChoices: new Map(),
    ...over,
  };
}

function classify(
  bucket: UpgradePlanBucket,
  diskPath: string,
  over: Partial<UpgradePlanEntry>,
  sel: Partial<ApplySelections>,
  others: UpgradePlanEntry[] = [],
): ApplyAction {
  const e = entry(bucket, diskPath, over);
  return classifyApplyAction(e, [e, ...others], selections(sel));
}

describe('safeDiskRel', () => {
  // Every write and delete in the upgrade and rollback steps joins `diskPath` onto the repository
  // root, and it arrives from a plan row — i.e. from the database — with no validation anywhere
  // before this.
  it('accepts the disk paths the manifest actually produces', () => {
    for (const p of [
      'AGENTS.md',
      '.claude/agents/peer-reviewer.md',
      '.claude/skills/testing/SKILL.md',
      '.haive/install.json',
      // Dotfile SEGMENTS are not traversal, and the Drupal LSP plugin files are full of them.
      '.claude/plugins/drupal-php-lsp/.claude-plugin/plugin.json',
    ]) {
      expect(safeDiskRel(p)).toBe(p);
    }
  });

  it('refuses anything that would leave the repository, by returning null rather than throwing', () => {
    for (const p of ['..', '../escape.md', 'a/../b.md', '/etc/passwd', '']) {
      // Returning null is the whole point: the apply branch is not inside a `try`, so a throw would
      // abort every remaining entry instead of skipping the one bad row.
      expect(safeDiskRel(p)).toBeNull();
    }
  });

  // Counterintuitive and deliberate: a template ID is a COMPOSITE KEY that embeds a path, so it
  // passes this check while yielding a nonsense rel — its first segment contains `..` without
  // BEING `..`. The guard is "never hand an id to it", not "it will catch one".
  it('does NOT protect against a template id being passed where a disk path belongs', () => {
    const id = 'plugin.drupal-php-lsp..claude/plugins/drupal-php-lsp/.claude-plugin/plugin.json';
    expect(safeDiskRel(id)).not.toBeNull();
  });
});

describe('classifyApplyAction — primary buckets', () => {
  it('clean_update with id selected → apply', () => {
    expect(
      classify(
        'clean_update',
        'a.md',
        { entryId: 'sel-1' },
        { selectedUpdates: new Set(['sel-1']) },
      ),
    ).toBe('apply');
  });

  it('clean_update with id not selected → skip', () => {
    expect(classify('clean_update', 'a.md', { entryId: 'sel-1' }, {})).toBe('skip');
  });

  it('new_artifact with id selected → apply', () => {
    expect(
      classify('new_artifact', 'a.md', { entryId: 'sel-1' }, { selectedNew: new Set(['sel-1']) }),
    ).toBe('apply');
  });

  it('user_deleted with id selected → apply (reinstate)', () => {
    expect(
      classify(
        'user_deleted',
        'a.md',
        { entryId: 'sel-1' },
        { selectedReinstate: new Set(['sel-1']) },
      ),
    ).toBe('apply');
  });

  it('conflict with apply_theirs → apply', () => {
    expect(
      classify(
        'conflict',
        'a.md',
        { entryId: 'sel-1' },
        { conflictChoices: new Map([['sel-1', 'apply_theirs']]) },
      ),
    ).toBe('apply');
  });

  it('conflict with keep_ours → keep, a decision Skip does not record', () => {
    expect(
      classify(
        'conflict',
        'a.md',
        { entryId: 'sel-1' },
        { conflictChoices: new Map([['sel-1', 'keep_ours']]) },
      ),
    ).toBe('keep');
    expect(
      classify(
        'conflict',
        'a.md',
        { entryId: 'sel-1' },
        { conflictChoices: new Map([['sel-1', 'skip']]) },
      ),
    ).toBe('skip');
  });

  it('obsolete with removal selected → delete', () => {
    expect(
      classify(
        'obsolete',
        'a.md',
        { entryId: 'sel-1' },
        { selectedObsoleteRemovals: new Set(['sel-1']) },
      ),
    ).toBe('delete');
  });

  it('obsolete with the RTK hook strip selected → strip, and a selected removal still wins', () => {
    const strip = { selectedRtkHookStrips: new Set(['sel-1']) };
    expect(classify('obsolete', '.claude/settings.json', { entryId: 'sel-1' }, strip)).toBe(
      'strip',
    );
    expect(
      classify(
        'obsolete',
        '.claude/settings.json',
        { entryId: 'sel-1' },
        { ...strip, selectedObsoleteRemovals: new Set(['sel-1']) },
      ),
    ).toBe('delete');
  });

  it('unchanged → skip (no action)', () => {
    expect(classify('unchanged', 'a.md', {}, {})).toBe('skip');
  });
});

describe('classifyApplyAction — untrack-dangling branch', () => {
  it('obsolete custom row that user skipped + no other entry rewrites the path → untrack', () => {
    expect(
      classify(
        'obsolete',
        '.claude/skills/x/SKILL.md',
        {
          entryId: 'sel-1',
          templateId: 'custom.bundle-1.deleted-uuid',
          liveArtifactId: 'live-1',
        },
        {},
      ),
    ).toBe('untrack');
  });

  it('obsolete custom row whose path will be rewritten by a new_artifact entry → skip (not untrack)', () => {
    // The new_artifact entry's apply will write the same diskPath, so
    // pre-superseding through untrack would race against the insert.
    // classifyApplyAction must return 'skip' so the loop does nothing for the
    // obsolete entry — defensive supersede in the apply transaction handles
    // the live row when the new_artifact INSERT runs.
    const target = entry('obsolete', '.claude/skills/x/SKILL.md', {
      entryId: 'sel-1',
      templateId: 'custom.bundle-1.deleted-uuid',
      liveArtifactId: 'live-1',
    });
    const competitor = entry('new_artifact', '.claude/skills/x/SKILL.md', {
      entryId: 'sel-2',
      templateId: 'custom.bundle-1.new-uuid',
    });
    expect(classifyApplyAction(target, [target, competitor], selections())).toBe('skip');
  });

  it('non-custom obsolete row (Haive template) is never untracked — only deleted explicitly', () => {
    expect(
      classify(
        'obsolete',
        '.claude/agents/old.md',
        { entryId: 'sel-1', templateId: 'agent.old', liveArtifactId: 'live-1' },
        {},
      ),
    ).toBe('skip');
  });

  it('obsolete custom row WITH user-selected removal → delete (not untrack — removal wins)', () => {
    expect(
      classify(
        'obsolete',
        '.claude/skills/x/SKILL.md',
        {
          entryId: 'sel-1',
          templateId: 'custom.bundle-1.deleted-uuid',
          liveArtifactId: 'live-1',
        },
        { selectedObsoleteRemovals: new Set(['sel-1']) },
      ),
    ).toBe('delete');
  });

  it('obsolete custom row without a liveArtifactId stays as skip (no row to supersede)', () => {
    expect(
      classify(
        'obsolete',
        '.claude/skills/x/SKILL.md',
        {
          entryId: 'sel-1',
          templateId: 'custom.bundle-1.deleted-uuid',
          liveArtifactId: null,
        },
        {},
      ),
    ).toBe('skip');
  });
});

describe('resolveBundleItemId', () => {
  it('returns the item id when extracted from custom.* templateId AND it exists in live set', () => {
    const live = new Set(['item-1']);
    expect(resolveBundleItemId('custom.bundle-x.item-1', live)).toBe('item-1');
  });

  it('returns null when the extracted id is not in the live set (FK guard)', () => {
    expect(resolveBundleItemId('custom.bundle-x.deleted', new Set())).toBe(null);
  });

  it('returns null for non-custom templateIds', () => {
    expect(resolveBundleItemId('agent.code-reviewer', new Set(['code-reviewer']))).toBe(null);
  });

  it('returns null for malformed custom templateIds (missing parts)', () => {
    expect(resolveBundleItemId('custom.', new Set())).toBe(null);
    expect(resolveBundleItemId('custom.only-bundle', new Set())).toBe(null);
  });

  it('rejoins dotted ids past the second segment so UUIDs and content with dots work', () => {
    // extractBundleItemId joins parts.slice(2) with '.' — e.g. an item id of
    // 'foo.bar' would round-trip. (UUIDs don't contain dots, but the helper
    // is dot-tolerant by design.)
    expect(resolveBundleItemId('custom.bundle.foo.bar', new Set(['foo.bar']))).toBe('foo.bar');
  });
});

describe('pathContent', () => {
  const dirs: string[] = [];
  const repo = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'upgrade-path-hash-'));
    dirs.push(dir);
    return dir;
  };
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });
  const region = `${CLI_RULES_START}\nKeep every change small.\n${CLI_RULES_END}`;
  const hashAt = async (root: string, rel: string, kind: string) =>
    (await pathContent(root, rel, kind))?.hash ?? null;

  it('hashes a whole file as the plan does', async () => {
    const root = await repo();
    await writeFile(join(root, 'a.md'), 'body\r\n', 'utf8');
    expect(await hashAt(root, 'a.md', 'agent')).toBe(sha256Hex(normalizeContent('body\r\n')));
  });

  it('hashes only the rules region, so an edit around it changes nothing', async () => {
    const root = await repo();
    await writeFile(join(root, 'AGENTS.md'), `# One\n\n${region}\n`, 'utf8');
    const before = await hashAt(root, 'AGENTS.md', CLI_RULES_TEMPLATE_KIND);
    await writeFile(join(root, 'AGENTS.md'), `# Two, edited\n\n${region}\n\nMore.\n`, 'utf8');
    expect(before).toBe(sha256Hex(normalizeContent(region)));
    expect(await hashAt(root, 'AGENTS.md', CLI_RULES_TEMPLATE_KIND)).toBe(before);
  });

  it('refuses a link or a directory at the path instead of reading it as absent', async () => {
    const root = await repo();
    await writeFile(join(root, 'target.md'), 'body\n', 'utf8');
    await symlink(join(root, 'target.md'), join(root, 'link.md'));
    await mkdir(join(root, 'dir.md'));
    await expect(pathContent(root, 'link.md', 'agent')).rejects.toThrow();
    await expect(pathContent(root, 'dir.md', 'agent')).rejects.toThrow();
  });

  it('answers null for a missing file or a file with no region', async () => {
    const root = await repo();
    expect(await pathContent(root, 'gone.md', 'agent')).toBeNull();
    await writeFile(join(root, 'AGENTS.md'), '# No region\n', 'utf8');
    expect(await pathContent(root, 'AGENTS.md', CLI_RULES_TEMPLATE_KIND)).toBeNull();
  });
});

describe('removeIfHaives', () => {
  const dirs: string[] = [];
  const repo = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'upgrade-remove-'));
    dirs.push(dir);
    return dir;
  };
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });
  const hash = (text: string) => sha256Hex(normalizeContent(text));
  const exists = (p: string) =>
    lstat(p).then(
      () => true,
      () => false,
    );
  const agent = (rel: string) => ({ diskPath: rel, templateKind: 'agent' });
  const rules = { diskPath: 'AGENTS.md', templateKind: CLI_RULES_TEMPLATE_KIND };
  const region = `${CLI_RULES_START}\nKeep every change small.\n${CLI_RULES_END}`;

  it('removes the file Haive wrote, and reports a path holding nothing as absent', async () => {
    const root = await repo();
    await writeFile(join(root, 'a.md'), 'HAIVE\n', 'utf8');
    expect(await removeIfHaives(root, 'a.md', agent('a.md'), hash('HAIVE\n'))).toEqual({
      outcome: 'removed',
    });
    expect(await exists(join(root, 'a.md'))).toBe(false);
    expect(await removeIfHaives(root, 'gone.md', agent('gone.md'), hash('HAIVE\n'))).toEqual({
      outcome: 'absent',
    });
  });

  it('keeps a file edited since, one Haive never wrote, and one nothing records', async () => {
    const root = await repo();
    await writeFile(join(root, 'a.md'), 'EDITED\n', 'utf8');
    for (const written of [hash('HAIVE\n'), hash('RENDER\n'), undefined]) {
      expect(await removeIfHaives(root, 'a.md', agent('a.md'), written)).toMatchObject({
        outcome: 'kept',
        refusal: expect.stringMatching(/^kept a\.md: /),
      });
    }
    expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('EDITED\n');
  });

  it('keeps a link, a directory, or a path through either, none of which Haive wrote', async () => {
    const root = await repo();
    await writeFile(join(root, 'target.md'), 'HAIVE\n', 'utf8');
    await symlink(join(root, 'target.md'), join(root, 'link.md'));
    await mkdir(join(root, 'dir.md'));
    await mkdir(join(root, 'real'));
    await writeFile(join(root, 'real', 'a.md'), 'HAIVE\n', 'utf8');
    await symlink(join(root, 'real'), join(root, 'via'));
    await writeFile(join(root, 'flat'), 'HAIVE\n', 'utf8');
    for (const rel of ['link.md', 'dir.md', 'via/a.md', 'flat/a.md']) {
      expect(await removeIfHaives(root, rel, agent(rel), hash('HAIVE\n')), rel).toMatchObject({
        outcome: 'kept',
      });
    }
    expect(await readFile(join(root, 'real', 'a.md'), 'utf8')).toBe('HAIVE\n');
    expect(await readFile(join(root, 'target.md'), 'utf8')).toBe('HAIVE\n');
  });

  it('strips the rules region Haive wrote and leaves the rest of AGENTS.md', async () => {
    const root = await repo();
    await writeFile(join(root, 'AGENTS.md'), `# Project\n\n${region}\n\nMine.\n`, 'utf8');
    expect(await removeIfHaives(root, 'AGENTS.md', rules, hash(region))).toEqual({
      outcome: 'removed',
    });
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe('# Project\n\n\n\nMine.\n');
  });

  it('keeps an edited rules region with the file as it is', async () => {
    const root = await repo();
    const edited = `# Project\n\n${region.replace('small', 'tiny')}\n`;
    await writeFile(join(root, 'AGENTS.md'), edited, 'utf8');
    expect(await removeIfHaives(root, 'AGENTS.md', rules, hash(region))).toMatchObject({
      outcome: 'kept',
    });
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe(edited);
  });

  it('leaves an absent AGENTS.md absent, and one with no region byte for byte', async () => {
    const root = await repo();
    expect(await removeIfHaives(root, 'AGENTS.md', rules, hash(region))).toEqual({
      outcome: 'absent',
    });
    expect(await exists(join(root, 'AGENTS.md'))).toBe(false);
    await writeFile(join(root, 'AGENTS.md'), '# No region, no newline', 'utf8');
    expect(await removeIfHaives(root, 'AGENTS.md', rules, hash(region))).toEqual({
      outcome: 'absent',
    });
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe('# No region, no newline');
  });
});
