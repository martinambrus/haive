import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  deleteRefusal,
  pathContentHash,
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

describe('deleteRefusal', () => {
  const hash = (text: string) => sha256Hex(normalizeContent(text));

  it('allows a delete while the path holds what Haive wrote, or nothing', () => {
    expect(deleteRefusal('a.md', hash('HAIVE'), hash('HAIVE'))).toBeNull();
    expect(deleteRefusal('a.md', null, hash('HAIVE'))).toBeNull();
  });

  it('keeps a file edited since Haive wrote it', () => {
    expect(deleteRefusal('a.md', hash('EDITED'), hash('HAIVE'))).toMatch(/^kept a\.md: /);
  });

  it('keeps a file Haive never wrote, whose row holds only the render', () => {
    expect(deleteRefusal('a.md', hash('THEIRS'), hash('RENDER'))).toMatch(/^kept a\.md: /);
  });

  it('keeps a file when nothing records what Haive wrote', () => {
    expect(deleteRefusal('a.md', hash('ANY'), undefined)).toMatch(/^kept a\.md: /);
  });
});

describe('pathContentHash', () => {
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

  it('hashes a whole file as the plan does', async () => {
    const root = await repo();
    await writeFile(join(root, 'a.md'), 'body\r\n', 'utf8');
    expect(await pathContentHash(root, 'a.md', 'agent')).toBe(
      sha256Hex(normalizeContent('body\r\n')),
    );
  });

  it('hashes only the rules region, so an edit around it changes nothing', async () => {
    const root = await repo();
    await writeFile(join(root, 'AGENTS.md'), `# One\n\n${region}\n`, 'utf8');
    const before = await pathContentHash(root, 'AGENTS.md', CLI_RULES_TEMPLATE_KIND);
    await writeFile(join(root, 'AGENTS.md'), `# Two, edited\n\n${region}\n\nMore.\n`, 'utf8');
    expect(before).toBe(sha256Hex(normalizeContent(region)));
    expect(await pathContentHash(root, 'AGENTS.md', CLI_RULES_TEMPLATE_KIND)).toBe(before);
  });

  it('answers null for a missing file or a file with no region', async () => {
    const root = await repo();
    expect(await pathContentHash(root, 'gone.md', 'agent')).toBeNull();
    await writeFile(join(root, 'AGENTS.md'), '# No region\n', 'utf8');
    expect(await pathContentHash(root, 'AGENTS.md', CLI_RULES_TEMPLATE_KIND)).toBeNull();
  });
});
