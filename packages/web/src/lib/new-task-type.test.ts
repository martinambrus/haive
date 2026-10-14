import { describe, expect, it } from 'vitest';
import type { PublicTaskType } from '@haive/shared/modularity';
import { SUMMARY_CLI_OFF } from './last-cli-choice';
import {
  buildNewTaskBody,
  buildNewTaskTypeOptions,
  cliMemoryRepositoryId,
  newTaskFields,
  type NewTaskBodyInput,
} from './new-task-type';

function row(over: Partial<PublicTaskType> & { slug: string }): PublicTaskType {
  return {
    displayName: over.slug,
    description: null,
    requiresRepository: true,
    sortOrder: 100,
    restoresDatabase: false,
    dispatchesCli: false,
    available: true,
    ...over,
  };
}

const BUILTIN_ROWS = ['onboarding', 'workflow', 'onboarding_upgrade', 'run_app'].map((slug, i) =>
  row({ slug, sortOrder: i }),
);

describe('buildNewTaskTypeOptions', () => {
  it('puts Workflow and Run the app first and never lists the built-in slugs', () => {
    const options = buildNewTaskTypeOptions([...BUILTIN_ROWS, row({ slug: 'spec-check' })]);
    expect(options.map((o) => o.value)).toEqual(['workflow', 'run_app', 'spec-check']);
    expect(options.map((o) => o.kind)).toEqual(['workflow', 'run_app', 'custom']);
    expect(options.slice(0, 2).map((o) => o.label)).toEqual(['Workflow', 'Run the app']);
  });

  it('offers only the two fixed choices when no custom type exists', () => {
    expect(buildNewTaskTypeOptions([]).map((o) => o.value)).toEqual(['workflow', 'run_app']);
    expect(buildNewTaskTypeOptions(BUILTIN_ROWS).map((o) => o.value)).toEqual([
      'workflow',
      'run_app',
    ]);
  });

  it('disables Run the app, with the reason, once a loaded list lacks it', () => {
    const loaded = BUILTIN_ROWS.filter((r) => r.slug !== 'run_app');
    const [workflow, runApp] = buildNewTaskTypeOptions(loaded);
    expect(workflow).toMatchObject({ value: 'workflow', disabled: false, reason: null });
    expect(runApp).toMatchObject({ value: 'run_app', disabled: true });
    expect(runApp!.reason).toMatch(/turned off/i);
    expect(buildNewTaskTypeOptions(BUILTIN_ROWS)[1]).toMatchObject({ disabled: false });
    expect(buildNewTaskTypeOptions([])[1]).toMatchObject({ disabled: false });
  });

  it('sorts custom types by sortOrder, then slug', () => {
    const options = buildNewTaskTypeOptions([
      row({ slug: 'zeta', sortOrder: 1 }),
      row({ slug: 'beta', sortOrder: 5 }),
      row({ slug: 'alpha', sortOrder: 5 }),
    ]);
    expect(options.slice(2).map((o) => o.value)).toEqual(['zeta', 'alpha', 'beta']);
  });

  it('keeps an unavailable type, disabled, with its reason in words', () => {
    const [, , off, ok] = buildNewTaskTypeOptions([
      row({ slug: 'a-off', available: false, reason: 'custom-types-off', sortOrder: 1 }),
      row({ slug: 'b-ok', sortOrder: 2 }),
    ]);
    expect(off).toMatchObject({ value: 'a-off', disabled: true });
    expect(off!.reason).toMatch(/custom task types are turned off/i);
    expect(ok).toMatchObject({ value: 'b-ok', disabled: false, reason: null });
  });

  it('blames a deactivated module when that is why a type is unavailable', () => {
    const [, , option] = buildNewTaskTypeOptions([
      row({ slug: 'uses-alpha', available: false, reason: 'module-deactivated' }),
    ]);
    expect(option).toMatchObject({ value: 'uses-alpha', disabled: true });
    expect(option!.reason).toMatch(/module.*deactivated/i);
  });

  it('explains every unavailable reason', () => {
    for (const reason of [
      'disabled',
      'not-selectable',
      'custom-types-off',
      'module-types-off',
      'module-deactivated',
      'missing-step',
      'invalid-composition',
    ] as const) {
      const [, , option] = buildNewTaskTypeOptions([row({ slug: 'x', available: false, reason })]);
      expect(option!.disabled).toBe(true);
      expect(option!.reason, reason).toMatch(/\w+ \w+/);
    }
  });

  it('carries the traits the form needs', () => {
    const [, , option] = buildNewTaskTypeOptions([
      row({
        slug: 'db-check',
        displayName: 'DB check',
        requiresRepository: false,
        restoresDatabase: true,
        dispatchesCli: true,
      }),
    ]);
    expect(option).toMatchObject({
      label: 'DB check',
      requiresRepository: false,
      restoresDatabase: true,
      dispatchesCli: true,
    });
  });
});

function custom(over: Partial<PublicTaskType> = {}) {
  return buildNewTaskTypeOptions([row({ slug: 'custom-one', ...over })])[2]!;
}
const [WORKFLOW, RUN_APP] = buildNewTaskTypeOptions([]) as [
  ReturnType<typeof custom>,
  ReturnType<typeof custom>,
];

describe('newTaskFields', () => {
  it('Workflow keeps every field it has today, gated on the inferred type', () => {
    expect(newTaskFields(WORKFLOW, 'workflow')).toEqual({
      repository: 'required',
      onboardingStatus: true,
      onboardingGate: true,
      planNodeLink: true,
      workflowFields: true,
      dumpUpload: true,
      cliPickers: true,
    });
    expect(newTaskFields(WORKFLOW, 'onboarding')).toMatchObject({
      workflowFields: false,
      dumpUpload: false,
      onboardingGate: true,
    });
    expect(newTaskFields(WORKFLOW, null)).toMatchObject({ workflowFields: false });
  });

  it('Run the app has no gate and no workflow fields, and takes a dump', () => {
    expect(newTaskFields(RUN_APP, 'run_app')).toEqual({
      repository: 'required',
      onboardingStatus: true,
      onboardingGate: false,
      planNodeLink: true,
      workflowFields: false,
      dumpUpload: true,
      cliPickers: true,
    });
  });

  it('a repo-less custom type makes the repository optional and hides every built-in extra', () => {
    expect(newTaskFields(custom({ requiresRepository: false }), null)).toEqual({
      repository: 'optional',
      onboardingStatus: false,
      onboardingGate: false,
      planNodeLink: false,
      workflowFields: false,
      dumpUpload: false,
      cliPickers: false,
    });
  });

  it('a repo-requiring custom type keeps the repository required', () => {
    expect(newTaskFields(custom({ requiresRepository: true }), null).repository).toBe('required');
  });

  it('shows the dump picker only for a custom type that restores a database', () => {
    expect(newTaskFields(custom({ restoresDatabase: true }), null).dumpUpload).toBe(true);
    expect(newTaskFields(custom({ restoresDatabase: false }), null).dumpUpload).toBe(false);
  });

  it('shows the CLI pickers only for a custom type that dispatches a CLI', () => {
    expect(newTaskFields(custom({ dispatchesCli: true }), null).cliPickers).toBe(true);
    expect(newTaskFields(custom({ dispatchesCli: false }), null).cliPickers).toBe(false);
  });
});

describe('cliMemoryRepositoryId', () => {
  it('asks for a repository memory only with pickers and a repository', () => {
    const pickers = newTaskFields(WORKFLOW, 'workflow');
    expect(cliMemoryRepositoryId(pickers, 'repo-1')).toBe('repo-1');
    expect(cliMemoryRepositoryId(pickers, '')).toBeNull();
    expect(cliMemoryRepositoryId(newTaskFields(custom(), null), 'repo-1')).toBeNull();
  });
});

const BASE: Omit<NewTaskBodyInput, 'type' | 'fields' | 'title'> = {
  repositoryId: 'repo-1',
  description: '',
  estimatedTime: '',
  cliProviderId: '',
  ignoreSavedStepClis: false,
  summaryCliProviderId: '',
  planNodeIds: [],
  planNodeRole: 'implements',
  overrideBlocked: false,
  fromPlanChat: false,
  isBugFix: false,
  feature: '',
  affectedClients: '',
  parentTaskId: '',
};

// Captured from the body construction in tasks/new/page.tsx before it was extracted
// (evidence/today-bodies.txt); the strings pin key order as well as content.
describe('buildNewTaskBody keeps the built-in request bodies', () => {
  const workflow = (inferred: 'workflow' | 'onboarding') => newTaskFields(WORKFLOW, inferred);
  const runApp = newTaskFields(RUN_APP, 'run_app');

  it('workflow, minimal', () => {
    const body = buildNewTaskBody({
      ...BASE,
      type: 'workflow',
      fields: workflow('workflow'),
      title: 'Add a thing',
    });
    expect(JSON.stringify(body)).toBe(
      '{"type":"workflow","title":"Add a thing","repositoryId":"repo-1","cliProviderId":null,"summaryLlmEnabled":true,"summaryCliProviderId":null,"isBugFix":false}',
    );
  });

  it('workflow, every field', () => {
    const body = buildNewTaskBody({
      ...BASE,
      type: 'workflow',
      fields: workflow('workflow'),
      title: 'Fix a thing',
      description: '  Fix it.  ',
      estimatedTime: 1.5,
      cliProviderId: 'cli-1',
      ignoreSavedStepClis: true,
      summaryCliProviderId: 'cli-2',
      planNodeIds: ['n1', 'n2'],
      planNodeRole: 'touched',
      overrideBlocked: true,
      fromPlanChat: true,
      isBugFix: true,
      feature: ' checkout ',
      affectedClients: 'acme, globex,, ',
      parentTaskId: 'parent-1',
    });
    expect(JSON.stringify(body)).toBe(
      '{"type":"workflow","title":"Fix a thing","repositoryId":"repo-1","description":"Fix it.","estimatedTimeHours":1.5,"cliProviderId":"cli-1","ignoreSavedStepClis":true,"summaryLlmEnabled":true,"summaryCliProviderId":"cli-2","planNodeIds":["n1","n2"],"planNodeRole":"touched","overrideBlocked":true,"fromPlanChat":true,"isBugFix":true,"feature":"checkout","affectedClients":["acme","globex"],"parentTaskId":"parent-1"}',
    );
  });

  it('workflow, summary off', () => {
    const body = buildNewTaskBody({
      ...BASE,
      type: 'workflow',
      fields: workflow('workflow'),
      title: 'T',
      summaryCliProviderId: SUMMARY_CLI_OFF,
      planNodeIds: ['n1'],
    });
    expect(JSON.stringify(body)).toBe(
      '{"type":"workflow","title":"T","repositoryId":"repo-1","cliProviderId":null,"summaryLlmEnabled":false,"summaryCliProviderId":null,"planNodeIds":["n1"],"planNodeRole":"implements","isBugFix":false}',
    );
  });

  it('onboarding', () => {
    const body = buildNewTaskBody({
      ...BASE,
      type: 'onboarding',
      fields: workflow('onboarding'),
      title: 'Onboard repo',
      description: 'x',
    });
    expect(JSON.stringify(body)).toBe(
      '{"type":"onboarding","title":"Onboard repo","repositoryId":"repo-1","description":"x","cliProviderId":null,"summaryLlmEnabled":true,"summaryCliProviderId":null}',
    );
  });

  it('run_app, minimal', () => {
    const body = buildNewTaskBody({
      ...BASE,
      type: 'run_app',
      fields: runApp,
      title: 'run demo app',
    });
    expect(JSON.stringify(body)).toBe(
      '{"type":"run_app","title":"run demo app","repositoryId":"repo-1","cliProviderId":null,"summaryLlmEnabled":true,"summaryCliProviderId":null}',
    );
  });

  it('run_app, every field', () => {
    const body = buildNewTaskBody({
      ...BASE,
      type: 'run_app',
      fields: runApp,
      title: 'run demo app',
      description: 'd',
      cliProviderId: 'cli-1',
      ignoreSavedStepClis: true,
      summaryCliProviderId: SUMMARY_CLI_OFF,
      planNodeIds: ['n1'],
      overrideBlocked: true,
      isBugFix: true,
      feature: 'ignored',
      parentTaskId: 'ignored',
    });
    expect(JSON.stringify(body)).toBe(
      '{"type":"run_app","title":"run demo app","repositoryId":"repo-1","description":"d","cliProviderId":"cli-1","ignoreSavedStepClis":true,"summaryLlmEnabled":false,"summaryCliProviderId":null,"planNodeIds":["n1"],"planNodeRole":"implements","overrideBlocked":true}',
    );
  });
});

describe('buildNewTaskBody for a custom type', () => {
  it('a repo-less type sends the slug, title and description only', () => {
    const fields = newTaskFields(custom({ requiresRepository: false }), null);
    const body = buildNewTaskBody({
      ...BASE,
      type: 'custom-one',
      fields,
      title: 'Check the spec',
      repositoryId: '',
      description: ' why ',
      planNodeIds: ['n1'],
      fromPlanChat: true,
      isBugFix: true,
      feature: 'f',
      cliProviderId: 'cli-1',
    });
    expect(JSON.stringify(body)).toBe(
      '{"type":"custom-one","title":"Check the spec","description":"why"}',
    );
  });

  it('a chosen repository is sent even when the type does not need one', () => {
    const fields = newTaskFields(custom({ requiresRepository: false }), null);
    const body = buildNewTaskBody({ ...BASE, type: 'custom-one', fields, title: 'T' });
    expect(body).toEqual({ type: 'custom-one', title: 'T', repositoryId: 'repo-1' });
  });

  it('CLI choices travel only for a type that dispatches a CLI', () => {
    const fields = newTaskFields(custom({ dispatchesCli: true }), null);
    const body = buildNewTaskBody({
      ...BASE,
      type: 'custom-one',
      fields,
      title: 'T',
      cliProviderId: 'cli-1',
      ignoreSavedStepClis: true,
      summaryCliProviderId: SUMMARY_CLI_OFF,
    });
    expect(body).toEqual({
      type: 'custom-one',
      title: 'T',
      repositoryId: 'repo-1',
      cliProviderId: 'cli-1',
      ignoreSavedStepClis: true,
      summaryLlmEnabled: false,
      summaryCliProviderId: null,
    });
  });

  it('an estimate is sent', () => {
    const fields = newTaskFields(custom(), null);
    expect(
      buildNewTaskBody({ ...BASE, type: 'custom-one', fields, title: 'T', estimatedTime: 2 }),
    ).toMatchObject({ estimatedTimeHours: 2 });
  });
});
