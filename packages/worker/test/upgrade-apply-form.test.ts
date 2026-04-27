import { describe, expect, it } from 'vitest';
import type { FormSchema } from '@haive/shared';
import type { StepContext } from '../src/step-engine/step-definition.js';
import { upgradeApplyStep } from '../src/step-engine/steps/onboarding-upgrade/02-upgrade-apply.js';
import type {
  UpgradePlanBucket,
  UpgradePlanEntry,
  UpgradePlanOutput,
} from '../src/step-engine/steps/onboarding-upgrade/01-upgrade-plan.js';

function entry(
  bucket: UpgradePlanBucket,
  diskPath: string,
  partial: Partial<UpgradePlanEntry> = {},
): UpgradePlanEntry {
  return {
    entryId: `e:${diskPath}`,
    bucket,
    templateId: `template.${diskPath}`,
    templateKind: 'agent',
    diskPath,
    liveArtifactId: null,
    currentContent: 'CURRENT_DISK',
    newContent: 'NEW_TEMPLATE',
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

function plan(entries: UpgradePlanEntry[]): UpgradePlanOutput {
  const counts: Record<UpgradePlanBucket, number> = {
    unchanged: 0,
    clean_update: 0,
    conflict: 0,
    new_artifact: 0,
    user_deleted: 0,
    obsolete: 0,
  };
  for (const e of entries) counts[e.bucket] += 1;
  return {
    repositoryId: 'repo-1',
    ranBackfill: false,
    entries,
    counts,
    installedTemplateSetHash: null,
    currentTemplateSetHash: 'current-hash',
    renderCtxSnapshot: {},
    backfilledRows: 0,
  };
}

function callForm(detected: UpgradePlanOutput): FormSchema {
  // form() signature is (ctx, detected) but the upgrade-apply form does not
  // touch ctx — pass a stub. Using `unknown as` keeps the test free of the
  // full StepContext surface (db, logger, AbortSignal, etc.).
  const schema = upgradeApplyStep.form?.({} as unknown as StepContext, detected);
  if (!schema) throw new Error('form returned null');
  return schema;
}

describe('upgradeApplyStep.form() — diff details on options', () => {
  it('clean_update options carry diff details with baseline=currentContent', () => {
    const schema = callForm(
      plan([
        entry('clean_update', '.claude/agents/code-reviewer.md', {
          currentContent: 'OLD_BODY',
          newContent: 'NEW_BODY',
        }),
      ]),
    );
    const field = schema.fields.find((f) => 'id' in f && f.id === 'selectedUpdates');
    expect(field).toBeDefined();
    if (!field || field.type !== 'multi-select') throw new Error('not a multi-select');
    expect(field.options).toHaveLength(1);
    const opt = field.options[0];
    expect(opt.details).toEqual({
      kind: 'diff',
      baseline: 'OLD_BODY',
      current: 'NEW_BODY',
      editable: false,
    });
  });

  it('new_artifact options carry diff details with baseline=null (currentContent is null)', () => {
    const schema = callForm(
      plan([
        entry('new_artifact', '.claude/agents/new-thing.md', {
          currentContent: null,
          newContent: 'BRAND_NEW',
        }),
      ]),
    );
    const field = schema.fields.find((f) => 'id' in f && f.id === 'selectedNew');
    if (!field || field.type !== 'multi-select') throw new Error('not a multi-select');
    expect(field.options[0].details).toEqual({
      kind: 'diff',
      baseline: null,
      current: 'BRAND_NEW',
      editable: false,
    });
  });

  it('user_deleted options carry diff details (renderer treats as fully-added)', () => {
    const schema = callForm(
      plan([
        entry('user_deleted', '.claude/agents/gone.md', {
          currentContent: null,
          newContent: 'WOULD_REINSTATE',
        }),
      ]),
    );
    const field = schema.fields.find((f) => 'id' in f && f.id === 'selectedReinstate');
    if (!field || field.type !== 'multi-select') throw new Error('not a multi-select');
    expect(field.options[0].details?.baseline).toBeNull();
    expect(field.options[0].details?.current).toBe('WOULD_REINSTATE');
  });

  it('obsolete options omit details (no newContent → no diff to show)', () => {
    const schema = callForm(
      plan([
        entry('obsolete', '.claude/plugins/disabled-lsp.json', {
          currentContent: 'STALE',
          newContent: null,
        }),
      ]),
    );
    const field = schema.fields.find((f) => 'id' in f && f.id === 'selectedObsoleteRemovals');
    if (!field || field.type !== 'multi-select') throw new Error('not a multi-select');
    expect(field.options[0].details).toBeUndefined();
  });

  it('options always carry editable=false for the read-only upgrade form', () => {
    const schema = callForm(
      plan([
        entry('clean_update', 'a.md', { currentContent: 'a', newContent: 'b' }),
        entry('new_artifact', 'b.md', { currentContent: null, newContent: 'b' }),
      ]),
    );
    for (const field of schema.fields) {
      if (field.type !== 'multi-select') continue;
      for (const opt of field.options) {
        if (opt.details) expect(opt.details.editable).toBe(false);
      }
    }
  });
});

describe('upgradeApplyStep.form() — diff details on conflict radio fields', () => {
  it('conflict radio gets field-level diff details with baseline=currentContent', () => {
    const schema = callForm(
      plan([
        entry('conflict', '.claude/agents/touched.md', {
          currentContent: 'USER_EDITED',
          newContent: 'NEW_TEMPLATE_BODY',
        }),
      ]),
    );
    const radio = schema.fields.find((f) => f.type === 'radio' && f.label.startsWith('Conflict:'));
    if (!radio || radio.type !== 'radio') throw new Error('no conflict radio');
    expect(radio.details).toEqual({
      kind: 'diff',
      baseline: 'USER_EDITED',
      current: 'NEW_TEMPLATE_BODY',
      editable: false,
    });
  });

  it('conflict radio with no newContent omits details (defensive — should not happen in practice)', () => {
    const schema = callForm(
      plan([
        entry('conflict', '.claude/agents/weird.md', {
          currentContent: 'something',
          newContent: null,
        }),
      ]),
    );
    const radio = schema.fields.find((f) => f.type === 'radio' && f.label.startsWith('Conflict:'));
    if (!radio || radio.type !== 'radio') throw new Error('no conflict radio');
    expect(radio.details).toBeUndefined();
  });
});

describe('upgradeApplyStep.form() — empty plan returns null', () => {
  it('no entries → no form fields → null (lets state machine skip the step)', () => {
    const result = upgradeApplyStep.form?.({} as unknown as StepContext, plan([]));
    expect(result).toBeNull();
  });

  it('only unchanged entries → null (nothing actionable)', () => {
    const result = upgradeApplyStep.form?.(
      {} as unknown as StepContext,
      plan([entry('unchanged', '.claude/agents/same.md')]),
    );
    expect(result).toBeNull();
  });
});
