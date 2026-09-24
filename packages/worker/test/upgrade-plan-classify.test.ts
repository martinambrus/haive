import { describe, expect, it } from 'vitest';
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
import {
  classifyEntry,
  type LiveArtifactRow,
} from '../src/step-engine/steps/onboarding-upgrade/01-upgrade-plan.js';
import { cliRulesRegionRecord } from '../src/step-engine/steps/onboarding/_rules-files.js';
import type { ExpandedRendering } from '../src/step-engine/template-manifest.js';

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
    sourceStepId: '12-post-onboarding',
    bundleItemId: null,
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
    expect(classifyEntry({ live: live(), current: null, diskContent: 'x', diskHash: 'wh-A' })).toBe(
      'obsolete',
    );
  });

  it('current without live → new_artifact', () => {
    expect(
      classifyEntry({ live: null, current: current(), diskContent: null, diskHash: null }),
    ).toBe('new_artifact');
  });

  it('both present + missing on disk → user_deleted', () => {
    expect(
      classifyEntry({
        live: live(),
        current: current(),
        diskContent: null,
        diskHash: null,
      }),
    ).toBe('user_deleted');
  });

  it('matching content hash and matching templateId → unchanged', () => {
    expect(
      classifyEntry({
        live: live({ templateContentHash: 'h', templateId: 'agent.x' }),
        current: current({ templateContentHash: 'h', templateId: 'agent.x' }),
        diskContent: 'BODY',
        diskHash: 'wh-A',
      }),
    ).toBe('unchanged');
  });

  it('schema-version change refreshes an unmodified artifact even when its canonical hash matches', () => {
    expect(
      classifyEntry({
        live: live({ templateSchemaVersion: 1, templateContentHash: 'h' }),
        current: current({ templateSchemaVersion: 2, templateContentHash: 'h' }),
        diskContent: 'BODY',
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
        diskContent: 'BODY',
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
        diskContent: 'BODY',
        diskHash: 'wh-A',
      }),
    ).toBe('unchanged');
  });

  it('different template hash + disk matches baseline → clean_update', () => {
    expect(
      classifyEntry({
        live: live({ templateContentHash: 'old', writtenHash: 'wh-A' }),
        current: current({ templateContentHash: 'new' }),
        diskContent: 'OLD_BODY',
        diskHash: 'wh-A',
      }),
    ).toBe('clean_update');
  });

  it('different template hash + disk diverged from baseline → conflict', () => {
    expect(
      classifyEntry({
        live: live({ templateContentHash: 'old', writtenHash: 'wh-A' }),
        current: current({ templateContentHash: 'new' }),
        diskContent: 'USER_EDITED',
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
      diskContent,
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
});
