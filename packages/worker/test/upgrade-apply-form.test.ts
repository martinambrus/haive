import { describe, expect, it } from 'vitest';
import { normalizeContent, sha256Hex, type FormSchema } from '@haive/shared';
import type { StepContext } from '../src/step-engine/step-definition.js';
import { upgradeApplyStep } from '../src/step-engine/steps/onboarding-upgrade/02-upgrade-apply.js';
import { buildClaudeSettingsJson } from '../src/step-engine/steps/onboarding/_rtk-templates.js';
import type {
  UpgradePlanBucket,
  UpgradePlanEntry,
  UpgradePlanOutput,
} from '../src/step-engine/steps/onboarding-upgrade/01-upgrade-plan.js';

const hashOf = (text: string) => sha256Hex(normalizeContent(text));

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
    adopt: 0,
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

function callFormOrNull(detected: UpgradePlanOutput): FormSchema | null {
  return upgradeApplyStep.form?.({} as unknown as StepContext, detected) ?? null;
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
    expect(opt?.details).toEqual({
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
    expect(field.options[0]?.details).toEqual({
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
    expect(field.options[0]?.details?.baseline).toBeNull();
    expect(field.options[0]?.details?.current).toBe('WOULD_REINSTATE');
  });

  it('obsolete options omit details (no newContent → no diff to show)', () => {
    const schema = callForm(
      plan([
        entry('obsolete', '.claude/plugins/disabled-lsp.json', {
          currentContent: 'STALE',
          newContent: null,
          currentHash: hashOf('STALE'),
          baselineWrittenHash: hashOf('STALE'),
        }),
      ]),
    );
    const field = schema.fields.find((f) => 'id' in f && f.id === 'selectedObsoleteRemovals');
    if (!field || field.type !== 'multi-select') throw new Error('not a multi-select');
    expect(field.options[0]?.details).toBeUndefined();
  });

  it('offers an edited RTK settings file for its hook to come out, instead of for deletion', () => {
    const edited = buildClaudeSettingsJson().replace('{\n', '{\n  "model": "ours",\n');
    const unedited = buildClaudeSettingsJson();
    const rtk = (diskPath: string, templateId: string, currentContent: string) =>
      entry('obsolete', diskPath, {
        templateId,
        templateKind: 'rtk-config',
        currentContent,
        newContent: null,
        currentHash: hashOf(currentContent),
        baselineWrittenHash: hashOf(unedited),
      });
    const schema = callForm(
      plan([
        rtk('.claude/settings.json', 'rtk.claude-settings', edited),
        rtk('.gemini/settings.json', 'rtk.gemini-settings', unedited),
      ]),
    );
    const strip = schema.fields.find((f) => 'id' in f && f.id === 'selectedRtkHookStrips');
    if (!strip || strip.type !== 'multi-select') throw new Error('not a multi-select');
    expect(strip.defaults).toEqual([]);
    expect(strip.options.map((o) => o.value)).toEqual(['e:.claude/settings.json']);
    expect(strip.options[0]?.details).toEqual({
      kind: 'diff',
      baseline: edited,
      current: '{\n  "model": "ours"\n}\n',
      editable: false,
    });
    const removals = schema.fields.find((f) => 'id' in f && f.id === 'selectedObsoleteRemovals');
    if (!removals || removals.type !== 'multi-select') throw new Error('not a multi-select');
    expect(removals.options.map((o) => o.value)).toEqual(['e:.gemini/settings.json']);
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

// 02 deletes an obsolete file only while it holds the bytes its row records, so the form offers
// deletion for those and for a file already gone, and nothing it would keep.
describe('upgradeApplyStep.form() — obsolete files', () => {
  const WROTE = 'as Haive wrote it\n';
  /** An obsolete entry the way 01 describes one: the file's bytes (null: gone) against its row's. */
  const obsolete = (diskPath: string, held: string | null, over: Partial<UpgradePlanEntry> = {}) =>
    entry('obsolete', diskPath, {
      liveArtifactId: `row:${diskPath}`,
      currentContent: held,
      newContent: null,
      currentHash: held === null ? null : hashOf(held),
      baselineWrittenHash: hashOf(WROTE),
      ...over,
    });
  const multi = (schema: FormSchema | null, id: string) => {
    const field = schema?.fields.find((f) => 'id' in f && f.id === id);
    if (field && field.type !== 'multi-select') throw new Error(`${id} is not a multi-select`);
    return field ?? null;
  };
  const values = (schema: FormSchema | null, id: string) =>
    multi(schema, id)?.options.map((o) => o.value) ?? null;

  it('offers deletion for a file that holds what Haive wrote, and for one that is gone', () => {
    const schema = callFormOrNull(
      plan([
        obsolete('.claude/agents/same.md', WROTE),
        obsolete('.claude/agents/gone.md', null),
        obsolete('.claude/agents/edited.md', 'a person changed this\n'),
      ]),
    );
    expect(values(schema, 'selectedObsoleteRemovals')).toEqual([
      'e:.claude/agents/same.md',
      'e:.claude/agents/gone.md',
    ]);
  });

  it('offers an edited file only in the keep choice, and says why', () => {
    const schema = callFormOrNull(
      plan([
        obsolete('.claude/agents/same.md', WROTE),
        obsolete('.claude/agents/edited.md', 'a person changed this\n'),
      ]),
    );
    const keep = multi(schema, 'selectedObsoleteUntracks');
    expect(keep?.options.map((o) => o.value)).toEqual([
      'e:.claude/agents/same.md',
      'e:.claude/agents/edited.md',
    ]);
    expect(keep?.options[0]?.description).toBeUndefined();
    expect(keep?.options[1]?.description).toMatch(/does not hold what Haive wrote/);
    expect(values(schema, 'selectedObsoleteRemovals')).toEqual(['e:.claude/agents/same.md']);
  });

  it('has no deletion field when every obsolete file was edited', () => {
    const schema = callFormOrNull(
      plan([obsolete('.claude/agents/edited.md', 'a person changed this\n')]),
    );
    expect(multi(schema, 'selectedObsoleteRemovals')).toBeNull();
    expect(values(schema, 'selectedObsoleteUntracks')).toEqual(['e:.claude/agents/edited.md']);
  });

  it('offers an edited bundle item nowhere: 02 untracks it unasked', () => {
    const schema = callFormOrNull(
      plan([
        obsolete('.claude/agents/same.md', WROTE),
        obsolete('.claude/agents/mine.md', 'a person changed this\n', {
          templateId: 'custom.bundle-1.item-1',
          templateKind: 'custom-agent',
        }),
      ]),
    );
    expect(values(schema, 'selectedObsoleteRemovals')).toEqual(['e:.claude/agents/same.md']);
    expect(values(schema, 'selectedObsoleteUntracks')).toEqual(['e:.claude/agents/same.md']);
  });

  it('judges the rules region, not the file around it', () => {
    const region = '<!-- region -->\nrules\n';
    const schema = callFormOrNull(
      plan([
        obsolete('AGENTS.md', region, {
          templateId: 'cli-rules',
          templateKind: 'cli-rules-block',
          baselineWrittenHash: hashOf(region),
        }),
      ]),
    );
    expect(values(schema, 'selectedObsoleteRemovals')).toEqual(['e:AGENTS.md']);
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

describe('upgradeApplyStep.form() — files already holding the new render', () => {
  it('asks nothing when there is nothing else to ask', () => {
    expect(callFormOrNull(plan([entry('adopt', '.claude/agents/current.md')]))).toBeNull();
  });

  it('names them in a note beside the questions it does ask', () => {
    const schema = callForm(
      plan([
        entry('adopt', '.claude/agents/current.md'),
        entry('clean_update', '.claude/agents/old.md'),
      ]),
    );
    const note = schema.fields.find((f) => f.id === 'adoptedNote');
    expect(note).toMatchObject({ type: 'note' });
    expect((note as { body: string }).body).toContain('`.claude/agents/current.md`');
    expect(
      schema.fields.some((f) => 'options' in f && JSON.stringify(f).includes('current.md')),
    ).toBe(false);
  });
});

describe('upgradeApplyStep.form() — a path the plan did not read', () => {
  it('offers no choice on it and names it, with why, in one note', () => {
    const schema = callForm(
      plan([
        entry('conflict', '.claude/agents/big.md', { unread: 'oversized' }),
        entry('obsolete', '.claude/settings.json', {
          unread: 'unreadable',
          templateKind: 'rtk-config',
          newContent: null,
        }),
        entry('conflict', '.claude/agents/mine.md'),
      ]),
    );
    const labels = schema.fields.map((f) => ('label' in f ? f.label : ''));
    expect(labels).toContain('Conflict: .claude/agents/mine.md');
    expect(labels).not.toContain('Conflict: .claude/agents/big.md');
    expect(schema.fields.some((f) => 'id' in f && f.id === 'selectedObsoleteRemovals')).toBe(false);
    const note = schema.fields.find((f) => 'id' in f && f.id === 'unreadNote');
    expect(note && 'body' in note ? note.body : '').toMatch(
      /`\.claude\/agents\/big\.md`: it is larger than \d+ bytes\n- `\.claude\/settings\.json`: it is not a regular file/,
    );
  });

  it('adds no note for an unread path whose template is unchanged', () => {
    expect(callFormOrNull(plan([entry('unchanged', 'a.md', { unread: 'oversized' })]))).toBeNull();
  });
});

describe('upgradeApplyStep.form() — rules import note', () => {
  it('names each rules file whose @AGENTS.md import the apply will restore', () => {
    const schema = callForm({ ...plan([]), missingRulesImports: ['CLAUDE.md', 'GEMINI.md'] });
    const note = schema.fields.find((f) => f.id === 'rulesImportNote');
    expect(note).toMatchObject({ type: 'note' });
    const body = (note as { body: string }).body;
    expect(body).toContain('`CLAUDE.md`');
    expect(body).toContain('`GEMINI.md`');
  });

  it('adds nothing when every import is in place, or for a plan persisted before the field', () => {
    const form = (detected: UpgradePlanOutput) =>
      upgradeApplyStep.form?.({} as unknown as StepContext, detected);
    expect(form({ ...plan([]), missingRulesImports: [] })).toBeNull();
    expect(form(plan([]))).toBeNull();
  });
});
