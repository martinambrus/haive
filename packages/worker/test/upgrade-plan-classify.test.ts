import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildCliRulesBlock,
  CLI_RULES_DISK_PATH,
  CLI_RULES_END,
  CLI_RULES_SCHEMA_VERSION,
  CLI_RULES_START,
  CLI_RULES_TEMPLATE_ID,
  CLI_RULES_TEMPLATE_KIND,
  extractRegion,
  normalizeContent,
  sha256Hex,
} from '@haive/shared';
import { PROJECT_STATE_IMPORT_STEP_ID } from '@haive/shared/project-state';
import { RULES_FILE_READ_CAP } from '@haive/shared/rules-files';
import {
  backfillRecord,
  classifyEntry,
  pickRenderSnapshot,
  readDiskContent,
  UNREAD_HASH,
  type LiveArtifactRow,
} from '../src/step-engine/steps/onboarding-upgrade/01-upgrade-plan.js';
import {
  classifyApplyAction,
  keptRowUpdate,
  type ApplySelections,
} from '../src/step-engine/steps/onboarding-upgrade/02-upgrade-apply.js';
import { cliRulesRegionRecord } from '../src/step-engine/steps/onboarding/_rules-files.js';
import { REFERENCE_CONTEXT, type ExpandedRendering } from '../src/step-engine/template-manifest.js';

function live(partial: Partial<LiveArtifactRow> = {}): LiveArtifactRow {
  return {
    id: 'live-1',
    diskPath: '.claude/agents/x.md',
    templateId: 'agent.x',
    templateKind: 'agent',
    templateContentHash: 'hash-A',
    templateSchemaVersion: 1,
    writtenHash: 'wh-A',
    formValuesSnapshot: null,
    source: 'onboarding',
    sourceStepId: '12-post-onboarding',
    haiveVersion: null,
    bundleItemId: null,
    generatedAt: null,
    ...partial,
  };
}

function current(partial: Partial<ExpandedRendering> = {}): ExpandedRendering {
  return {
    templateId: 'agent.x',
    templateKind: 'agent',
    templateSchemaVersion: 1,
    templateContentHash: 'hash-A',
    diskPath: '.claude/agents/x.md',
    content: 'BODY',
    writtenHash: 'wh-A',
    ...partial,
  };
}

describe('classifyEntry', () => {
  it('live without current → obsolete', () => {
    expect(classifyEntry({ live: live(), current: null, diskHash: 'wh-A' })).toBe('obsolete');
  });

  it('current without live → new_artifact', () => {
    expect(classifyEntry({ live: null, current: current(), diskHash: null })).toBe('new_artifact');
  });

  it('current without live, and the render already on disk → new_artifact', () => {
    expect(classifyEntry({ live: null, current: current(), diskHash: 'wh-A' })).toBe(
      'new_artifact',
    );
  });

  it('current without live, and some other file already on disk → conflict', () => {
    expect(
      classifyEntry({
        live: null,
        current: current(),
        diskHash: 'wh-USER',
      }),
    ).toBe('conflict');
  });

  it('current without live, and an earlier recorded render on disk → new_artifact', () => {
    expect(
      classifyEntry({
        live: null,
        current: current(),
        diskHash: 'wh-OLD',
        recordedRenderHashes: new Set(['wh-OLD']),
      }),
    ).toBe('new_artifact');
  });

  it('both present + missing on disk → user_deleted', () => {
    expect(
      classifyEntry({
        live: live(),
        current: current(),
        diskHash: null,
      }),
    ).toBe('user_deleted');
  });

  it('matching content hash and matching templateId → unchanged', () => {
    expect(
      classifyEntry({
        live: live({ templateContentHash: 'h', templateId: 'agent.x' }),
        current: current({ templateContentHash: 'h', templateId: 'agent.x' }),
        diskHash: 'wh-A',
      }),
    ).toBe('unchanged');
  });

  it('schema-version change refreshes an unmodified artifact even when its canonical hash matches', () => {
    expect(
      classifyEntry({
        live: live({ templateSchemaVersion: 1, templateContentHash: 'h' }),
        current: current({ templateSchemaVersion: 2, templateContentHash: 'h' }),
        diskHash: 'wh-A',
      }),
    ).toBe('clean_update');
  });

  it('matching content hash but custom templateId shifted → clean_update (auto-realigns dangling tracking)', () => {
    // Same content hash means the rendered output is byte-identical, but the
    // templateId points at a different bundle_item UUID — typically because
    // the user replaced the bundle and persistBundleItems re-keyed by source
    // path. apply must rewrite the artifact row with the new templateId so
    // upgrade-status drift detection can clear.
    expect(
      classifyEntry({
        live: live({
          templateContentHash: 'h',
          templateId: 'custom.bundle-1.OLD-uuid',
        }),
        current: current({
          templateContentHash: 'h',
          templateId: 'custom.bundle-1.NEW-uuid',
        }),
        diskHash: 'wh-A',
      }),
    ).toBe('clean_update');
  });

  it('matching content hash with templateId shift on a non-custom item stays unchanged', () => {
    // Haive templates have stable ids. A mismatch here would be a generator
    // bug and should NOT silently rewrite history.
    expect(
      classifyEntry({
        live: live({ templateContentHash: 'h', templateId: 'agent.code-reviewer' }),
        current: current({
          templateContentHash: 'h',
          templateId: 'agent.code-reviewer-renamed',
        }),
        diskHash: 'wh-A',
      }),
    ).toBe('unchanged');
  });

  it('different template hash + disk matches baseline → clean_update', () => {
    expect(
      classifyEntry({
        live: live({ templateContentHash: 'old', writtenHash: 'wh-A' }),
        current: current({ templateContentHash: 'new' }),
        diskHash: 'wh-A',
      }),
    ).toBe('clean_update');
  });

  it('different template hash + disk already holding the new render → adopt', () => {
    expect(
      classifyEntry({
        live: live({ templateContentHash: 'old', writtenHash: 'wh-A' }),
        current: current({ templateContentHash: 'new', writtenHash: 'wh-NEW' }),
        diskHash: 'wh-NEW',
      }),
    ).toBe('adopt');
  });

  it('different template hash + disk diverged from baseline → conflict', () => {
    expect(
      classifyEntry({
        live: live({ templateContentHash: 'old', writtenHash: 'wh-A' }),
        current: current({ templateContentHash: 'new' }),
        diskHash: 'wh-USER',
      }),
    ).toBe('conflict');
  });
});

describe('classifyEntry on the cli-rules row, recorded from the region on disk', () => {
  const a = buildCliRulesBlock(['Rule A.']) as string;
  const b = buildCliRulesBlock(['Rule B.']) as string;
  const edited = a.replace('Rule A.', 'Rule A, reworded by hand.');
  const regionOf = (block: string): string =>
    extractRegion(`# Project\n\n${block}`, CLI_RULES_START, CLI_RULES_END) ?? '';
  const hashOf = (block: string): string => sha256Hex(normalizeContent(block));
  const cliRules = {
    diskPath: CLI_RULES_DISK_PATH,
    templateId: CLI_RULES_TEMPLATE_ID,
    templateKind: CLI_RULES_TEMPLATE_KIND,
    templateSchemaVersion: CLI_RULES_SCHEMA_VERSION,
  };

  /** The row records `recorded` against `render`; the plan then reads `onDisk` and renders `now`. */
  const plan = (args: {
    recorded: string;
    render: string;
    earlier?: string[];
    onDisk: string;
    now: string;
  }) => {
    const record = cliRulesRegionRecord(
      regionOf(args.recorded),
      args.render,
      new Set((args.earlier ?? []).map(hashOf)),
    );
    const diskContent = normalizeContent(regionOf(args.onDisk));
    return classifyEntry({
      live: live({
        ...cliRules,
        templateContentHash: record.templateContentHash,
        writtenHash: record.writtenHash,
      }),
      current: current({
        ...cliRules,
        templateContentHash: hashOf(args.now),
        content: args.now,
        writtenHash: hashOf(args.now),
      }),
      diskHash: sha256Hex(diskContent),
    });
  };

  it('an untouched region with unchanged rules is unchanged', () => {
    expect(plan({ recorded: a, render: a, onDisk: a, now: a })).toBe('unchanged');
  });

  it('an untouched region is updated when the rules change', () => {
    expect(plan({ recorded: a, render: a, onDisk: a, now: b })).toBe('clean_update');
  });

  it('a stale region an earlier onboarding rendered is offered and updated', () => {
    expect(plan({ recorded: b, render: a, earlier: [b], onDisk: b, now: a })).toBe('clean_update');
  });

  it('a region nobody rendered is a conflict, never an overwrite', () => {
    expect(edited).not.toBe(a);
    expect(plan({ recorded: edited, render: a, onDisk: edited, now: a })).toBe('conflict');
  });

  it('a region edited after it was recorded is a conflict once the rules change', () => {
    expect(plan({ recorded: a, render: a, onDisk: edited, now: b })).toBe('conflict');
  });

  /** No row at all: the plan reads `onDisk` against the render `now` and the renders recorded. */
  const untracked = (args: { onDisk: string; now: string; earlier?: string[] }) => {
    const diskContent = normalizeContent(regionOf(args.onDisk));
    return classifyEntry({
      live: null,
      current: current({ ...cliRules, content: args.now, writtenHash: hashOf(args.now) }),
      diskHash: sha256Hex(diskContent),
      recordedRenderHashes: new Set((args.earlier ?? []).map(hashOf)),
    });
  };

  it('an untracked region an earlier render wrote is replaced by default', () => {
    expect(untracked({ onDisk: b, now: a, earlier: [b] })).toBe('new_artifact');
  });

  it('an untracked region nobody rendered is a conflict', () => {
    expect(untracked({ onDisk: edited, now: a, earlier: [b] })).toBe('conflict');
  });
});

describe('backfillRecord', () => {
  const render = current({
    content: 'RENDER',
    writtenHash: 'wh-RENDER',
    templateContentHash: 'h1',
  });

  it("keeps an edited file's bytes but claims neither them nor the template", () => {
    expect(backfillRecord(render, { content: 'EDITED', hash: 'wh-EDITED' })).toEqual({
      templateContentHash: 'wh-EDITED',
      writtenHash: 'wh-RENDER',
      writtenContent: 'EDITED',
      lastObservedDiskHash: 'wh-EDITED',
      userModified: true,
    });
  });

  it('records an untouched file as the render it is', () => {
    expect(backfillRecord(render, { content: 'RENDER', hash: 'wh-RENDER' })).toMatchObject({
      templateContentHash: 'h1',
      writtenHash: 'wh-RENDER',
      writtenContent: 'RENDER',
      userModified: false,
    });
  });

  /** The next plan over a row holding `row`, with the edit still on disk and the template at `now`. */
  const next = (row: { templateContentHash: string; writtenHash: string }, now: string) =>
    classifyEntry({
      live: live(row),
      current: current({
        templateContentHash: now,
        content: `RENDER-${now}`,
        writtenHash: `wh-RENDER-${now}`,
      }),
      diskHash: 'wh-EDITED',
    });

  it('leaves an edited file a conflict, whether or not the template changes', () => {
    const record = backfillRecord(render, { content: 'EDITED', hash: 'wh-EDITED' });
    expect(next(record, 'h1')).toBe('conflict');
    expect(next(record, 'h2')).toBe('conflict');
  });

  it('offers a claim the boot repair swapped while the template is unchanged', () => {
    // A pre-fix row held the disk hash as writtenHash; the repair swaps it with the template's.
    expect(next({ templateContentHash: 'wh-EDITED', writtenHash: 'h1' }, 'h1')).toBe('conflict');
  });
});

describe('keptRowUpdate', () => {
  it('stops offering a kept custom item that was re-ingested under a new id', () => {
    const row = live({
      templateId: 'custom.b.old',
      templateContentHash: 'h-old',
      writtenHash: 'w-old',
      bundleItemId: 'old',
    });
    const next = current({
      templateId: 'custom.b.new',
      templateContentHash: 'h-new',
      content: 'NEW',
      writtenHash: 'w-new',
    });
    const disk = { current: next, diskHash: 'wh-EDITED' };
    expect(classifyEntry({ live: row, ...disk })).toBe('conflict');

    const kept = { content: 'EDITED', hash: 'wh-EDITED' };
    const update = keptRowUpdate(next, next.templateContentHash, kept, new Set(['new']));
    expect(update.bundleItemId).toBe('new');
    // What a later rollback restores is the bytes kept, never the older render the row held.
    expect(update.writtenContent).toBe('EDITED');
    expect(update).not.toHaveProperty('writtenHash');
    expect(classifyEntry({ live: { ...row, ...update }, ...disk })).toBe('unchanged');
  });
});

describe('pickRenderSnapshot', () => {
  const row = (id: string, formValuesSnapshot: Record<string, unknown> | null, at = 0) => ({
    id,
    generatedAt: new Date(at),
    formValuesSnapshot,
  });
  const context = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    ...(REFERENCE_CONTEXT as unknown as Record<string, unknown>),
    ...over,
  });
  const withoutRtk = (): Record<string, unknown> => {
    const { rtkEnabled: _own, ...rest } = context();
    return rest;
  };

  it('renders from a snapshot that recorded an RTK choice ahead of one from before RTK', () => {
    const beforeRtk = { ...withoutRtk(), framework: 'drupal' };
    const recorded = context({ framework: 'drupal', rtkEnabled: false });
    expect(
      pickRenderSnapshot([row('a', null), row('b', beforeRtk, 2), row('c', recorded, 1)]),
    ).toBe(recorded);
    expect(pickRenderSnapshot([row('a', beforeRtk)])).toBe(beforeRtk);
    expect(pickRenderSnapshot([row('a', null)])).toBeNull();
  });

  it('does not count a snapshot that does not decode as a render context', () => {
    const full = context({ framework: 'drupal' });
    const beforeRtk = withoutRtk();
    for (const bad of [{}, { framework: 'drupal', rtkEnabled: false }]) {
      expect(pickRenderSnapshot([row('a', full, 1), row('b', bad, 2)])).toBe(full);
      expect(pickRenderSnapshot([row('a', beforeRtk, 1), row('b', bad, 2)])).toBe(beforeRtk);
      expect(pickRenderSnapshot([row('a', bad, 2)])).toBeNull();
    }
  });

  it('takes the newest recorded snapshot, whatever order the rows come in', () => {
    const older = context({
      rtkEnabled: true,
      enabledCliProviders: [{ name: 'gemini', rulesFile: 'GEMINI.md', rulesFileMode: 'import' }],
    });
    const newer = context({
      rtkEnabled: true,
      enabledCliProviders: [
        { name: 'claude-code', rulesFile: 'CLAUDE.md', rulesFileMode: 'import' },
      ],
    });
    expect(pickRenderSnapshot([row('a', older, 1), row('b', newer, 2)])).toBe(newer);
    expect(pickRenderSnapshot([row('b', newer, 2), row('a', older, 1)])).toBe(newer);
    expect(pickRenderSnapshot([row('a', older, 1), row('b', newer, 1)])).toBe(newer);
  });
});

describe('a path the plan did not read', () => {
  let repo: string;
  let outside: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'upgrade-plan-unread-'));
    outside = await mkdtemp(join(tmpdir(), 'upgrade-plan-unread-out-'));
    await writeFile(join(outside, 'x.md'), 'not ours', 'utf8');
    await mkdir(join(repo, '.claude/agents'), { recursive: true });
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('is read no further than the cap, its content withheld', async () => {
    const big = `BODY${'\n'.repeat(RULES_FILE_READ_CAP)}`;
    await writeFile(join(repo, '.claude/agents/x.md'), big, 'utf8');
    expect(await readDiskContent(repo, '.claude/agents/x.md')).toEqual({
      content: null,
      hash: UNREAD_HASH,
      unread: 'oversized',
    });
  });

  it('reads a link or a directory standing there as unread, never as absent', async () => {
    await symlink(join(outside, 'x.md'), join(repo, '.claude/agents/x.md'));
    await mkdir(join(repo, '.claude/agents/y.md'));
    const unread = { content: null, hash: UNREAD_HASH, unread: 'unreadable' };
    expect(await readDiskContent(repo, '.claude/agents/x.md')).toEqual(unread);
    expect(await readDiskContent(repo, '.claude/agents/y.md')).toEqual(unread);
    expect(await readDiskContent(repo, '.claude/agents/z.md')).toEqual({
      content: null,
      hash: null,
    });
  });

  it('is never deleted, never new and never matched to a record', () => {
    const changed = current({ templateContentHash: 'hash-B', writtenHash: 'wh-B' });
    const unread = { diskHash: UNREAD_HASH };
    expect(classifyEntry({ live: live(), current: changed, ...unread })).toBe('conflict');
    expect(classifyEntry({ live: live(), current: current(), ...unread })).toBe('unchanged');
    expect(classifyEntry({ live: null, current: current(), ...unread })).toBe('conflict');
    expect(classifyEntry({ live: live(), current: null, ...unread })).toBe('obsolete');
  });
});

describe('rows imported from another install', () => {
  const marker = (partial: Partial<LiveArtifactRow> = {}) =>
    live({ source: 'backfill', sourceStepId: PROJECT_STATE_IMPORT_STEP_ID, ...partial });
  const claudeOnly = {
    haiveVersion: '1.4.0',
    agentTargets: [{ dir: '.claude/agents', format: 'markdown' as const, supportsLsp: false }],
    skillDirs: ['.claude/skills'],
  };

  it('reads a bundle item this install does not hold as foreign, not obsolete', () => {
    const row = live({ templateId: 'custom:git@host/a/b:items/x', templateKind: 'custom-agent' });
    expect(classifyEntry({ live: row, current: null, diskHash: 'wh-A' })).toBe('foreign');
  });

  it('reads a claim from a newer release as foreign, not a clean update', () => {
    const moved = current({ templateContentHash: 'hash-B', writtenHash: 'wh-B' });
    const newer = marker({ haiveVersion: '1.5.0' });
    const args = { current: moved, diskHash: 'wh-A', foreignContext: claudeOnly };
    expect(classifyEntry({ live: marker({ haiveVersion: '1.3.0' }), ...args })).toBe(
      'clean_update',
    );
    expect(classifyEntry({ live: newer, ...args })).toBe('foreign');
    expect(
      classifyEntry({
        live: newer,
        ...args,
        foreignContext: { ...claudeOnly, haiveVersion: '0.0.0-dev' },
      }),
    ).toBe('clean_update');
  });

  it('reads a claim at an agent directory this install has no CLI for as foreign, not obsolete', () => {
    const codex = marker({ diskPath: '.codex/agents/x.toml' });
    expect(
      classifyEntry({ live: codex, current: null, diskHash: 'wh-A', foreignContext: claudeOnly }),
    ).toBe('foreign');
    expect(
      classifyEntry({
        live: live({ diskPath: '.codex/agents/x.toml' }),
        current: null,
        diskHash: 'wh-A',
        foreignContext: claudeOnly,
      }),
    ).toBe('obsolete');
  });

  // The region renders from the repository's rules, the same for every install, so an imported
  // baseline is as good a proof of unedited bytes as one this install recorded.
  it('reads an imported cli-rules row whose template moved like a recorded one: a clean update while unedited, a conflict once edited', () => {
    const rules = {
      diskPath: CLI_RULES_DISK_PATH,
      templateId: CLI_RULES_TEMPLATE_ID,
      templateKind: CLI_RULES_TEMPLATE_KIND,
    };
    const moved = current({ ...rules, templateContentHash: 'hash-B', writtenHash: 'wh-B' });
    const args = { current: moved, diskHash: 'wh-A', foreignContext: claudeOnly };
    expect(classifyEntry({ live: live(rules), ...args })).toBe('clean_update');
    expect(classifyEntry({ live: marker(rules), ...args })).toBe('clean_update');
    expect(classifyEntry({ live: marker(rules), ...args, diskHash: 'wh-B' })).toBe('adopt');
    for (const row of [live(rules), marker(rules)]) {
      expect(classifyEntry({ live: row, ...args, diskHash: 'wh-edited' })).toBe('conflict');
    }
    expect(
      classifyEntry({
        live: marker({ ...rules, templateContentHash: 'hash-B', templateSchemaVersion: 1 }),
        current: moved,
        diskHash: 'wh-A',
        foreignContext: claudeOnly,
      }),
    ).toBe('unchanged');
  });

  it('never deletes a foreign row, whichever removal the form sent', () => {
    const row = live({ templateId: 'custom:git@host/a/b:items/x', templateKind: 'custom-agent' });
    const bucket = classifyEntry({ live: row, current: null, diskHash: 'wh-A' });
    const entry = {
      entryId: 'e0',
      bucket,
      templateId: row.templateId,
      templateKind: row.templateKind,
      diskPath: row.diskPath,
      liveArtifactId: row.id,
      currentContent: 'BODY',
      newContent: null,
      baselineContent: 'BODY',
      currentHash: 'wh-A',
      baselineWrittenHash: 'wh-A',
      newContentHash: null,
      baselineTemplateContentHash: 'hash-A',
      currentTemplateContentHash: null,
      templateSchemaVersion: 1,
      delta: null,
    };
    const selections: ApplySelections = {
      selectedUpdates: new Set([entry.entryId]),
      selectedNew: new Set([entry.entryId]),
      selectedReinstate: new Set([entry.entryId]),
      selectedObsoleteRemovals: new Set([entry.entryId]),
      selectedRtkHookStrips: new Set([entry.entryId]),
      selectedObsoleteUntracks: new Set([entry.entryId]),
      conflictChoices: new Map([[entry.entryId, 'apply_theirs']]),
    };
    expect(classifyApplyAction(entry, [entry], selections)).toBe('skip');
  });
});
