import { describe, expect, it } from 'vitest';
import {
  classifyEntry,
  type LiveArtifactRow,
} from '../src/step-engine/steps/onboarding-upgrade/01-upgrade-plan.js';
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
