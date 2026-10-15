import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MODULE_ID_MAX_LENGTH,
  CORE_INTEGRATION_CATEGORIES,
  PERSONA_ID_PATTERN_SOURCE,
  composableStepEntrySchema,
  integrationRequirementSchema,
  isCategoryId,
  isCoreStepId,
  isCustomStepId,
  isModuleStepId,
  isPersonaId,
  isProviderId,
  modulePackageId,
  parseCategoryId,
  parseProviderId,
  parseStepId,
  taskTypeDefinitionSeedSchema,
} from '../src/modularity/index.js';

const CORE_STEP_IDS = [
  '00-bundle-resync',
  '00-model-health-onboarding',
  '00-model-health-workflow',
  '00-plan-inputs',
  '00-plan-sequence',
  '00-triage',
  '00a-sync-base',
  '00b-estimate',
  '00b-plan-clarify',
  '01-advisory-research',
  '01-debug-mode',
  '01-declare-deps',
  '01-env-detect',
  '01-kb-enrich',
  '01-plan-build',
  '01-plan-chat',
  '01-plan-merge',
  '01-upgrade-plan',
  '01-worktree-setup',
  '01_5-ripgrep-config',
  '01a-app-boot',
  '01b-install-plugins',
  '01c-ddev-env',
  '01c1-restore-database',
  '01d-browser-access',
  '01e-external-kb-sync',
  '01f-external-plan-sync',
  '01g-rag-source-selection',
  '02-advisory-decision',
  '02-detection-confirmation',
  '02-generate-dockerfile',
  '02-plan-coverage',
  '02-pre-rag-sync',
  '02-upgrade-apply',
  '03-build-image',
  '03-phase-0a-discovery',
  '03-plan-sequence',
  '03-upgrade-commit',
  '03b-business-requirements',
  '03b2-humanize-requirements',
  '03c-business-requirements-review',
  '04-phase-0b-pre-planning',
  '04-tooling-infrastructure',
  '04-upgrade-rollback',
  '04-verify-environment',
  '04_5-global-kb',
  '04a-spec-audit',
  '05-phase-0b5-spec-quality',
  '05a-resolve-spec-warnings',
  '06-gate-1-spec-approval',
  '06-run-config',
  '06_3-custom-bundles',
  '06_5-agent-discovery',
  '06_7-scope-selection',
  '06a-db-migrate',
  '06b-sprint-planning',
  '06c-dag-execute',
  '07-generate-files',
  '07-phase-2-implement',
  '07_5-verify-files',
  '07_7-secret-sweep',
  '07a-code-simplify',
  '07b-phase-4-validate',
  '07c-ddev-reconcile',
  '08-knowledge-acquisition',
  '08-phase-5-verify',
  '08a-browser-setup',
  '08a-browser-verify',
  '08b-test-management',
  '08c-code-review',
  '08c2-code-audit',
  '08d-adversarial-qa',
  '08d2-adversarial-qa-review',
  '08e-insights-triage',
  '09-gate-2-verify-approval',
  '09-qa',
  '09_1-qa-suggestions',
  '09_2-qa-resolve',
  '09_3-qa-review',
  '09_5-skill-generation',
  '09_5b-skill-repair',
  '09_6-skill-verification',
  '09_6_4-global-kb-merge',
  '09_6_5-global-kb-review',
  '09_7-rag-source-selection',
  '10-gate-3-commit',
  '10-rag-populate',
  '10_8-plan-build',
  '11-final-review',
  '11-phase-8-learning',
  '11a-gate-4-push',
  '11b-kb-commit',
  '11b1-rag-source-selection',
  '11c-rag-reindex',
  '11d-skill-sync',
  '11e-prompt-guidance',
  '11f-plan-reconcile',
  '11g-save-database',
  '12-post-onboarding',
  '12-worktree-cleanup',
  '13-onboarding-push',
  '13-pr-wait',
  '98-choose-view',
  '99-run-app-ready',
];

describe('step id grammar', () => {
  it('has the full core fixture', () => {
    expect(CORE_STEP_IDS).toHaveLength(104);
    expect(new Set(CORE_STEP_IDS).size).toBe(104);
  });

  it.each(CORE_STEP_IDS)('parses core id %s', (id) => {
    expect(isCoreStepId(id)).toBe(true);
    expect(parseStepId(id)).toEqual({ kind: 'core' });
  });

  it('parses module and custom ids', () => {
    expect(parseStepId('module.google-drive.fetch_file')).toEqual({
      kind: 'module',
      moduleId: 'google-drive',
      localId: 'fetch_file',
    });
    expect(parseStepId('custom.my-def.step-1')).toEqual({
      kind: 'custom',
      defSlug: 'my-def',
      stepSlug: 'step-1',
    });
    expect(isModuleStepId('module.a.b')).toBe(true);
    expect(isCustomStepId('custom.a.b')).toBe(true);
  });

  it.each([
    '',
    'Upper',
    '07.phase',
    'module.x',
    'module..x',
    'module.x.',
    'module.X.y',
    'module.x.y.z',
    'module._x.y',
    'module.x_y.z',
    'custom.a',
    'custom.a.b.c',
    'custom.a_b.c',
    'custom.a.b_c',
    'custom..b',
    'other.a.b',
    'has space',
  ])('rejects %j', (id) => {
    expect(parseStepId(id)).toBeNull();
  });

  it('rejects a dot in the core position', () => {
    expect(isCoreStepId('a.b')).toBe(false);
  });
});

describe('provider and category id grammar', () => {
  it.each([
    ['openai', { kind: 'core' }],
    ['a_b-c', { kind: 'core' }],
    ['module.google.drive', { kind: 'module', moduleId: 'google', id: 'drive' }],
  ])('parses provider %s', (id, expected) => {
    expect(isProviderId(id)).toBe(true);
    expect(parseProviderId(id)).toEqual(expected);
  });

  it.each([
    '',
    'Upper',
    '-lead',
    '_lead',
    'a.b',
    'module.x',
    'module.x.',
    'module..y',
    'module.X.y',
    'module.x.y.z',
    'module.x.-y',
  ])('rejects provider %j', (id) => {
    expect(isProviderId(id)).toBe(false);
    expect(parseProviderId(id)).toBeNull();
  });

  it.each([
    ['mail', { kind: 'core' }],
    ['module.acme.crm', { kind: 'module', moduleId: 'acme', id: 'crm' }],
  ])('parses category %s', (id, expected) => {
    expect(isCategoryId(id)).toBe(true);
    expect(parseCategoryId(id)).toEqual(expected);
  });

  it.each(['', 'Mail', 'module.x', 'module.x.y.z', 'a.b'])('rejects category %j', (id) => {
    expect(isCategoryId(id)).toBe(false);
    expect(parseCategoryId(id)).toBeNull();
  });

  it('lists the core categories', () => {
    expect(CORE_INTEGRATION_CATEGORIES).toEqual([
      'rich-documents',
      'spreadsheets',
      'file-storage',
      'mail',
      'chat',
      'issues',
      'wiki',
      'forge',
    ]);
    for (const c of CORE_INTEGRATION_CATEGORIES) expect(isCategoryId(c)).toBe(true);
  });
});

describe('persona id', () => {
  it('uses the worker grammar', () => {
    expect(PERSONA_ID_PATTERN_SOURCE).toBe('[a-z0-9-]+');
    expect(isPersonaId('code-reviewer')).toBe(true);
    expect(isPersonaId('a1')).toBe(true);
    expect(isPersonaId('')).toBe(false);
    expect(isPersonaId('A')).toBe(false);
    expect(isPersonaId('a_b')).toBe(false);
    expect(isPersonaId('a b')).toBe(false);
  });
});

describe('module package names', () => {
  const NAMES: [string, string | null][] = [
    ['@haive/module-statistics', 'statistics'],
    ['@haive-module/deep-analysis', 'deep-analysis'],
    ['@haive/module-a', 'a'],
    ['@haive-module/9x', '9x'],
    ['@haive/module-a--b', 'a--b'],
    ['@haive/module-', null],
    ['@haive-module/', null],
    ['@haive/module--x', null],
    ['@haive-module/-x', null],
    ['@haive/module-Foo', null],
    ['@haive-module/Foo', null],
    ['@haive/module-foo_bar', null],
    ['@haive-module/foo/bar', null],
    [`@haive-module/${'a'.repeat(23)}`, 'a'.repeat(23)],
    [`@haive/module-${'a'.repeat(24)}`, null],
    [`@haive-module/${'a'.repeat(24)}`, null],
    ['@haive/module-foo/web', null],
    ['@haive/statistics', null],
    ['@haive/shared', null],
    ['@haive-modules/foo', null],
    ['@haive-module/foo\n', null],
    [' @haive-module/foo', null],
    ['haive-module/foo', null],
    ['@other/module-foo', null],
    ['@other/foo', null],
    ['module-foo', null],
    ['', null],
  ];

  it.each(NAMES)('reads %j as the module id %j', (name, id) => {
    expect(modulePackageId(name)).toBe(id);
  });

  it("accepts an id exactly as long as a manifest's, and no longer", () => {
    expect(modulePackageId(`@haive-module/${'a'.repeat(MODULE_ID_MAX_LENGTH)}`)).not.toBeNull();
    expect(modulePackageId(`@haive-module/${'a'.repeat(MODULE_ID_MAX_LENGTH + 1)}`)).toBeNull();
  });

  it('is the rule scripts/gen-modules.mjs applies, name for name', () => {
    const script = readFileSync(
      new URL('../../../scripts/gen-modules.mjs', import.meta.url),
      'utf8',
    );
    const literal = /^const MODULE_PACKAGE = \/(.+)\/;$/m.exec(script)?.[1];
    expect(literal).toBeDefined();
    const copy = new RegExp(literal!);
    for (const [name] of NAMES) expect(copy.exec(name)?.[1] ?? null).toBe(modulePackageId(name));
  });
});

describe('integrationRequirementSchema', () => {
  const ok = { id: 'docs', access: 'read' } as const;

  it('accepts exactly one of category or provider', () => {
    expect(integrationRequirementSchema.safeParse({ ...ok, category: 'mail' }).success).toBe(true);
    expect(
      integrationRequirementSchema.safeParse({
        ...ok,
        provider: 'module.google.drive',
        optional: true,
      }).success,
    ).toBe(true);
  });

  it('rejects both or neither', () => {
    expect(integrationRequirementSchema.safeParse(ok).success).toBe(false);
    expect(
      integrationRequirementSchema.safeParse({ ...ok, category: 'mail', provider: 'openai' })
        .success,
    ).toBe(false);
  });

  it('rejects bad ids and access', () => {
    expect(
      integrationRequirementSchema.safeParse({ ...ok, id: 'A', category: 'mail' }).success,
    ).toBe(false);
    expect(
      integrationRequirementSchema.safeParse({ ...ok, category: 'module.x', access: 'read' })
        .success,
    ).toBe(false);
    expect(
      integrationRequirementSchema.safeParse({ id: 'a', category: 'mail', access: 'admin' })
        .success,
    ).toBe(false);
  });
});

describe('composableStepEntrySchema', () => {
  const entry = {
    stepId: '07-phase-2-implement',
    label: 'Implement',
    group: 'build',
    dispatchesCli: true,
    requires: [{ needs: 'plan', reason: 'needs a plan' }],
    provides: ['code'],
  };

  it('accepts a minimal entry and all step id kinds', () => {
    expect(composableStepEntrySchema.safeParse(entry).success).toBe(true);
    expect(composableStepEntrySchema.safeParse({ ...entry, stepId: 'module.a.b_c' }).success).toBe(
      true,
    );
    expect(composableStepEntrySchema.safeParse({ ...entry, stepId: 'custom.a.b' }).success).toBe(
      true,
    );
  });

  it('rejects a bad step id', () => {
    expect(composableStepEntrySchema.safeParse({ ...entry, stepId: 'a.b' }).success).toBe(false);
  });

  it('rejects duplicate requirement ids', () => {
    const integrations = [
      { id: 'docs', category: 'mail', access: 'read' },
      { id: 'docs', provider: 'openai', access: 'write' },
    ];
    expect(composableStepEntrySchema.safeParse({ ...entry, integrations }).success).toBe(false);
    expect(
      composableStepEntrySchema.safeParse({
        ...entry,
        integrations: [integrations[0], { ...integrations[1], id: 'other' }],
      }).success,
    ).toBe(true);
  });

  it('accepts a param form schema', () => {
    const r = composableStepEntrySchema.safeParse({
      ...entry,
      paramFormSchema: { title: 't', fields: [] },
      loopBudgetEditable: true,
      loopTargetStepId: '07-phase-2-implement',
    });
    expect(r.success).toBe(true);
  });
});

describe('taskTypeDefinitionSeedSchema', () => {
  const base = {
    slug: 'my-type',
    displayName: 'My type',
    runListStrategy: 'static',
    stepIds: ['01-env-detect'],
    selectable: true,
    requiresRepository: false,
  };

  it('accepts a static seed with steps', () => {
    expect(taskTypeDefinitionSeedSchema.safeParse(base).success).toBe(true);
    expect(taskTypeDefinitionSeedSchema.safeParse({ ...base, slug: 'new' }).success).toBe(false);
    expect(taskTypeDefinitionSeedSchema.safeParse({ ...base, slug: 'catalog' }).success).toBe(
      false,
    );
  });

  it('rejects static without steps', () => {
    expect(taskTypeDefinitionSeedSchema.safeParse({ ...base, stepIds: null }).success).toBe(false);
    expect(taskTypeDefinitionSeedSchema.safeParse({ ...base, stepIds: [] }).success).toBe(false);
  });

  it('rejects dynamic with steps and accepts dynamic with null', () => {
    for (const runListStrategy of ['workflow_paths', 'run_app_modes']) {
      expect(taskTypeDefinitionSeedSchema.safeParse({ ...base, runListStrategy }).success).toBe(
        false,
      );
      expect(
        taskTypeDefinitionSeedSchema.safeParse({ ...base, runListStrategy, stepIds: null }).success,
      ).toBe(true);
    }
  });

  it('rejects a bad slug', () => {
    expect(taskTypeDefinitionSeedSchema.safeParse({ ...base, slug: '-x' }).success).toBe(false);
    expect(taskTypeDefinitionSeedSchema.safeParse({ ...base, slug: 'X' }).success).toBe(false);
  });
});

describe('package export', () => {
  it('maps ./modularity to dist', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      exports: Record<string, { types: string; import: string }>;
    };
    expect(pkg.exports['./modularity']).toEqual({
      types: './dist/modularity/index.d.ts',
      import: './dist/modularity/index.js',
    });
  });
});
