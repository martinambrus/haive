import { describe, expect, it } from 'vitest';
import type { CompositionIssue } from '@haive/shared/modularity';
import {
  CUSTOM_TOOL_PROBLEM_KINDS,
  PROMPT_STEP_PROBLEM_KINDS,
  validateComposition,
} from '@haive/shared/modularity';
import {
  catalogEntries,
  compositionProblems,
  describeAvailability,
  describeDefaultsIssue,
  describeIssue,
  describePromptStepIssue,
  describeStepWithoutEntry,
  issuesByRow,
  promptStepIssuesOf,
  providersOf,
  splitServerIssues,
} from './composition-messages';
import { TEST_CATALOG } from './composition-test-catalog';

const catalog = catalogEntries(TEST_CATALOG);
const ctx = (stepIds: string[], requiresRepository = true) => ({
  stepIds,
  catalog,
  requiresRepository,
});

describe('providersOf', () => {
  it('lists the catalog steps that provide a token, in catalog order', () => {
    expect(providersOf('spec', catalog).map((s) => s.stepId)).toEqual([
      '04-phase-0b-pre-planning',
      '05-phase-0b5-spec-quality',
    ]);
  });

  it('leaves out the step asking', () => {
    expect(providersOf('spec', catalog, '05-phase-0b5-spec-quality').map((s) => s.label)).toEqual([
      'Phase 0b: Pre-planning',
    ]);
  });

  it('is empty for a token nothing provides', () => {
    expect(providersOf('repository', catalog)).toEqual([]);
  });
});

describe('describeIssue', () => {
  it('empty', () => {
    expect(describeIssue({ kind: 'empty' }, ctx([])).message).toBe('Add at least one step.');
  });

  it('unknown-step names the id', () => {
    const view = describeIssue(
      { kind: 'unknown-step', index: 0, stepId: 'zz-gone' },
      ctx(['zz-gone']),
    );
    expect(view.message).toBe('zz-gone is not in the step catalog (removed or its module is off).');
  });

  it('duplicate-step points at the first occurrence', () => {
    const ids = ['03-phase-0a-discovery', '03-phase-0a-discovery'];
    const view = describeIssue({ kind: 'duplicate-step', index: 1, stepId: ids[1]! }, ctx(ids));
    expect(view.message).toBe('Phase 0a: Knowledge discovery is already step 1.');
  });

  it('unmet-need carries the reason and who provides the token', () => {
    const view = describeIssue(
      {
        kind: 'unmet-need',
        index: 0,
        stepId: '05-phase-0b5-spec-quality',
        needs: 'spec',
        reason: 'Reviews the pre-planning spec',
      },
      ctx(['05-phase-0b5-spec-quality']),
    );
    expect(view.message).toBe('Needs spec first: Reviews the pre-planning spec.');
    expect(view.providedBy.map((s) => s.stepId)).toEqual(['04-phase-0b-pre-planning']);
  });

  it('unmet-need for the repository token names the switch', () => {
    const view = describeIssue(
      {
        kind: 'unmet-need',
        index: 0,
        stepId: '01-worktree-setup',
        needs: 'repository',
        reason: 'Cuts the worktree.',
      },
      ctx(['01-worktree-setup'], false),
    );
    expect(view.message).toBe(
      "Requires a repository: turn on 'Requires a repository' or remove this step.",
    );
    expect(view.providedBy).toEqual([]);
  });

  it('too-late names the earlier step that already provides the token', () => {
    const ids = ['05-phase-0b5-spec-quality', '03-phase-0a-discovery'];
    const view = describeIssue(
      { kind: 'too-late', index: 1, stepId: ids[1]!, token: 'spec' },
      ctx(ids),
    );
    expect(view.message).toBe(
      'Must run before any step that provides spec; currently after Phase 0b.5: Spec quality review.',
    );
  });

  it('too-late without a findable earlier step still reads', () => {
    const view = describeIssue(
      { kind: 'too-late', index: 0, stepId: '03-phase-0a-discovery', token: 'spec' },
      ctx(['03-phase-0a-discovery']),
    );
    expect(view.message).toBe('Must run before any step that provides spec.');
  });

  it('unfulfilled lists the steps to add after it', () => {
    const view = describeIssue(
      { kind: 'unfulfilled', index: 0, stepId: '09-finish', token: 'finished' },
      ctx(['09-finish']),
    );
    expect(view.message).toBe(
      'Starts something that finished must finish later: add a step that provides finished after it.',
    );
    const withProvider = describeIssue(
      { kind: 'unfulfilled', index: 0, stepId: '01-worktree-setup', token: 'spec' },
      ctx(['01-worktree-setup']),
    );
    expect(withProvider.message).toBe(
      'Starts something that spec must finish later: add Phase 0b: Pre-planning or Phase 0b.5: Spec quality review after it.',
    );
    expect(withProvider.providedBy).toHaveLength(2);
  });

  it('missing-loop-target names the target by label', () => {
    const view = describeIssue(
      {
        kind: 'missing-loop-target',
        index: 0,
        stepId: '07b-phase-4-validate',
        target: '07-phase-2-implement',
      },
      ctx(['07b-phase-4-validate']),
    );
    expect(view.message).toBe('Loops back to Phase 2: Implement, which must come earlier.');
    expect(view.providedBy.map((s) => s.stepId)).toEqual(['07-phase-2-implement']);
  });

  it('loop-after-closing names the closing step', () => {
    const view = describeIssue(
      {
        kind: 'loop-after-closing',
        index: 2,
        stepId: '07b-phase-4-validate',
        closingStepId: '09-finish',
      },
      ctx([]),
    );
    expect(view.message).toBe(
      'Its fix loop would return past Finish, which closes the run; move it before that step.',
    );
  });

  it('every kind validateComposition can emit has a message that is not the raw kind', () => {
    const samples: CompositionIssue[] = [
      ...validateComposition([], catalog),
      ...validateComposition(['nope'], catalog),
      ...validateComposition(['05-phase-0b5-spec-quality', '05-phase-0b5-spec-quality'], catalog),
      ...validateComposition(['05-phase-0b5-spec-quality', '03-phase-0a-discovery'], catalog),
      ...validateComposition(['09-finish'], catalog),
      ...validateComposition(['01-worktree-setup', '07b-phase-4-validate'], catalog),
      ...validateComposition(
        ['01-worktree-setup', '07-phase-2-implement', '09-finish', '07b-phase-4-validate'],
        catalog,
      ),
    ];
    expect(new Set(samples.map((i) => i.kind))).toEqual(
      new Set([
        'empty',
        'unknown-step',
        'duplicate-step',
        'unmet-need',
        'too-late',
        'unfulfilled',
        'missing-loop-target',
        'loop-after-closing',
      ]),
    );
    for (const issue of samples) {
      const { message } = describeIssue(issue, ctx(['x']));
      expect(message.length).toBeGreaterThan(10);
      expect(message).not.toContain('undefined');
      expect(message).not.toContain(issue.kind);
    }
  });
});

describe('describeDefaultsIssue', () => {
  it('names the step', () => {
    expect(
      describeDefaultsIssue(
        { kind: 'loop-limit-not-editable', stepId: '01-worktree-setup' },
        catalog,
      ),
    ).toBe('Worktree setup has no loop limit to set.');
    expect(
      describeDefaultsIssue(
        { kind: 'default-key-not-in-steps', field: 'stepLoopLimitDefaults', stepId: 'gone' },
        catalog,
      ),
    ).toBe('A loop limit is set for gone, which is not in the list.');
  });
});

describe('issuesByRow', () => {
  it('groups by index and leaves the row-less issue out', () => {
    const rows = issuesByRow([
      { kind: 'empty' },
      { kind: 'unknown-step', index: 2, stepId: 'a' },
      { kind: 'duplicate-step', index: 2, stepId: 'a' },
    ]);
    expect([...rows.keys()]).toEqual([2]);
    expect(rows.get(2)).toHaveLength(2);
  });
});

describe('compositionProblems', () => {
  it('agrees with validateComposition and flags a loop limit on a step that has none', () => {
    const stepIds = ['05-phase-0b5-spec-quality', '04-phase-0b-pre-planning'];
    const out = compositionProblems({
      stepIds,
      loopLimits: { '04-phase-0b-pre-planning': 3 },
      catalog,
      requiresRepository: false,
    });
    expect(out.composition).toEqual(
      validateComposition(stepIds, catalog, { requiresRepository: false }),
    );
    expect(out.defaults).toEqual([
      { kind: 'loop-limit-not-editable', stepId: '04-phase-0b-pre-planning' },
    ]);
  });
});

describe('splitServerIssues', () => {
  it('separates composition, defaults and validation issues by shape', () => {
    const out = splitServerIssues([
      { kind: 'unknown-step', index: 0, stepId: 'a' },
      { kind: 'loop-limit-not-editable', stepId: 'b' },
      { path: 'slug', message: 'Invalid' },
      { nonsense: true },
    ]);
    expect(out.composition).toEqual([{ kind: 'unknown-step', index: 0, stepId: 'a' }]);
    expect(out.defaults).toEqual([{ kind: 'loop-limit-not-editable', stepId: 'b' }]);
    expect(out.fields).toEqual([{ path: 'slug', message: 'Invalid' }]);
  });

  it('tolerates a body with no issues', () => {
    expect(splitServerIssues(undefined)).toEqual({ composition: [], defaults: [], fields: [] });
  });
});

describe('describeAvailability', () => {
  it('says why a type cannot be used, in words', () => {
    expect(describeAvailability({ available: true })).toBe('Available');
    expect(describeAvailability({ available: false, reason: 'custom-types-off' })).toBe(
      'Unavailable: custom task types are switched off',
    );
    expect(
      describeAvailability({ available: false, reason: 'missing-step', stepIds: ['a', 'b'] }),
    ).toBe('Unavailable: missing steps a, b');
    expect(
      describeAvailability({
        available: false,
        reason: 'invalid-composition',
        issues: [{ kind: 'empty' }],
      }),
    ).toBe('Unavailable: the step list has 1 problem');
    expect(describeAvailability({ available: false, reason: 'disabled' })).toBe(
      'Unavailable: disabled',
    );
  });

  it('names the module a type needs when it is not installed', () => {
    expect(
      describeAvailability({
        available: false,
        reason: 'module-missing',
        modules: [{ id: 'fx', name: 'Fx Reports' }],
      }),
    ).toBe('Unavailable: needs the module Fx Reports, which is not installed');
  });

  it('names a module with no row by its id, and each of several modules', () => {
    expect(
      describeAvailability({
        available: false,
        reason: 'module-missing',
        modules: [{ id: 'fx', name: null }],
      }),
    ).toBe('Unavailable: needs the module fx, which is not installed');
    expect(
      describeAvailability({
        available: false,
        reason: 'module-missing',
        modules: [
          { id: 'fx', name: 'Fx Reports' },
          { id: 'gx', name: null },
        ],
      }),
    ).toBe('Unavailable: needs the modules Fx Reports and gx, which are not installed');
  });

  it('names the deactivated modules a type uses', () => {
    expect(
      describeAvailability({
        available: false,
        reason: 'module-deactivated',
        modules: [
          { id: 'alpha', name: 'Alpha' },
          { id: 'beta', name: 'Beta' },
        ],
      }),
    ).toBe('Unavailable: needs the modules Alpha and Beta, which an administrator turned off');
  });
});

describe('describeStepWithoutEntry', () => {
  const modules = [
    { id: 'fx', name: 'Fx Reports', state: 'missing' },
    { id: 'hx', name: 'Hx Tools', state: 'deactivated' },
    { id: 'ix', name: 'Ix Loaded', state: 'loaded' },
  ] as const;
  const registeredStepIds = ['01-internal', 'module.ix.internal', 'module.fx.run', 'module.hx.run'];
  const note = (stepId: string, readOnly: boolean) =>
    describeStepWithoutEntry(stepId, {
      readOnly,
      catalog: { modules: [...modules], registeredStepIds },
    });

  it('says a step of a module that is not installed comes from that module', () => {
    for (const readOnly of [true, false]) {
      expect(note('module.fx.run', readOnly)).toEqual({
        text: 'Provided by module Fx Reports, which is not installed',
        warning: true,
      });
    }
  });

  it('names a module with no row by its id', () => {
    expect(note('module.gx.run', true)).toEqual({
      text: 'Provided by module gx, which is not installed',
      warning: true,
    });
  });

  it('says a step of a deactivated module comes from a module an administrator turned off', () => {
    for (const readOnly of [true, false]) {
      expect(note('module.hx.run', readOnly)).toEqual({
        text: 'Provided by module Hx Tools, which an administrator turned off',
        warning: true,
      });
    }
  });

  it('calls a registered internal step of a module that is there a module step, not a built-in one', () => {
    expect(note('module.ix.internal', true)).toEqual({
      text: 'Module Ix Loaded step, not composable',
      warning: false,
    });
    expect(note('module.ix.internal', false).text).toBe('Not in the step catalog');
  });

  it('says a step the install does not register is not registered, module step or not', () => {
    for (const stepId of ['module.ix.gone', '99-gone']) {
      for (const readOnly of [true, false]) {
        expect(note(stepId, readOnly), `${stepId} ${readOnly}`).toEqual({
          text: 'Not registered on this install',
          warning: true,
        });
      }
    }
  });

  it('keeps the old words for a registered core step and for an id the registry does not own', () => {
    expect(note('01-internal', true)).toEqual({
      text: 'Built-in step, not composable',
      warning: false,
    });
    expect(note('01-internal', false).text).toBe('Not in the step catalog');
    for (const stepId of ['custom.t.ask', 'Not A Step']) {
      expect(note(stepId, true).text).toBe('Built-in step, not composable');
      expect(note(stepId, false).text).toBe('Not in the step catalog');
    }
  });
});

describe('describePromptStepIssue', () => {
  it('has plain words for every problem kind the validator can raise', () => {
    const texts = PROMPT_STEP_PROBLEM_KINDS.map((kind) =>
      describePromptStepIssue({ kind, stepId: 'custom.t.a', raw: '{{x:y}}' }),
    );
    for (const text of texts) {
      expect(text).toMatch(/\S/);
      expect(text).not.toBe('undefined');
    }
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('names the token it is about, in a code span', () => {
    expect(
      describePromptStepIssue({ kind: 'unknown-token', stepId: 's', raw: '{{bogus}}' }),
    ).toContain('`{{bogus}}` is not a template token');
    expect(
      describePromptStepIssue({ kind: 'step-token-not-own-line', stepId: 's', raw: '{{step:a}}' }),
    ).toBe('`{{step:a}}` must be alone on its line.');
    expect(
      describePromptStepIssue({ kind: 'unknown-token', stepId: 's', raw: '{{a``b}}' }),
    ).toContain('``` {{a``b}} ``` is not a template token');
  });

  it('keeps a backtick in the token from closing the code span', () => {
    expect(
      describePromptStepIssue({ kind: 'integration-token', stepId: 's', raw: '{{a`b}}' }),
    ).toBe('`` {{a`b}} `` is not supported yet.');
  });

  it('says what the client-only and set-level problems mean', () => {
    expect(describePromptStepIssue({ kind: 'template-empty', stepId: 's' })).toContain('empty');
    expect(describePromptStepIssue({ kind: 'title-empty', stepId: 's' })).toContain('title');
    expect(describePromptStepIssue({ kind: 'prompt-step-orphan', stepId: 'custom.t.a' })).toContain(
      'custom.t.a is defined but is not in the step list',
    );
    expect(
      describePromptStepIssue({ kind: 'prompt-step-missing', stepId: 'custom.t.a' }),
    ).toContain('custom.t.a is in the step list but has no prompt step');
  });

  it('puts the limits of the api in the words of its refusals', () => {
    expect(describePromptStepIssue({ kind: 'timeout-out-of-range', stepId: 's' })).toContain(
      '1 and 30 minutes',
    );
    expect(describePromptStepIssue({ kind: 'template-too-large', stepId: 's' })).toContain(
      '16 KiB',
    );
  });

  describe('tools', () => {
    const text = (kind: Parameters<typeof describePromptStepIssue>[0]['kind'], raw?: string) =>
      describePromptStepIssue({ kind, stepId: 's', ...(raw === undefined ? {} : { raw }) });

    it('says tools are not supported yet and what to do', () => {
      expect(text('tools-not-supported-yet')).toContain('not supported yet');
      expect(text('tools-not-supported-yet')).toContain('Remove');
    });

    it('names the tool in a code span for every problem that is about one tool', () => {
      const aboutOneTool = CUSTOM_TOOL_PROBLEM_KINDS.filter((kind) => kind !== 'too-many-tools');
      expect(aboutOneTool.length).toBe(CUSTOM_TOOL_PROBLEM_KINDS.length - 1);
      for (const kind of aboutOneTool) {
        expect(text(kind, 'repo_status'), kind).toContain('`repo_status`');
        expect(text(kind), kind).not.toContain('undefined');
        expect(text(kind), kind).toMatch(/tool/i);
      }
    });

    it('keeps a backtick in the tool name from closing the code span', () => {
      expect(text('tool-url-not-https', 'a`b')).toContain('`` a`b ``');
    });

    it('puts the limits of a tool in the words of its refusals', () => {
      expect(text('too-many-tools')).toContain('8 tools');
      expect(text('tool-too-many-params', 't')).toContain('10 parameters');
      expect(text('tool-timeout-out-of-range', 't')).toContain('1 and 30 seconds');
      expect(text('tool-response-cap-out-of-range', 't')).toContain('1 and 64 KiB');
      expect(text('tool-top-k-out-of-range', 't')).toContain('1 and 20');
      expect(text('tool-description-invalid', 't')).toContain('1024');
      expect(text('tool-name-invalid', 't')).toContain('40');
    });

    it('names what is wrong with a url in plain words', () => {
      expect(text('tool-url-not-https', 't')).toContain('https://');
      expect(text('tool-url-userinfo', 't')).toContain('password');
      expect(text('tool-url-fragment', 't')).toContain('#');
      expect(text('tool-host-ip-literal', 't')).toContain('IP address');
      expect(text('tool-host-not-public', 't')).toContain('.internal');
      expect(text('tool-placeholder-outside-path', 't')).toContain('path');
    });

    it('lists the names a tool may not take', () => {
      const reserved = text('tool-name-reserved', 't');
      for (const name of ['rag_search', 'ddev_status', 'ddev_logs', 'ddev_restart']) {
        expect(reserved).toContain(name);
      }
    });

    it('tells a type with no repository how to keep a project search', () => {
      expect(text('tool-scope-needs-repository', 't')).toContain("'Requires a repository'");
    });
  });
});

describe('promptStepIssuesOf', () => {
  it('keeps the prompt-step kinds that name a step and drops the rest', () => {
    const out = promptStepIssuesOf([
      {
        kind: 'unknown-token',
        stepId: 'custom.t.a',
        index: 2,
        raw: '{{x}}',
        start: 0,
        message: 'm',
      },
      { kind: 'prompt-step-orphan', stepId: 'custom.t.b', message: 'm' },
      { kind: 'unknown-step', index: 0, stepId: 'a' },
      { kind: 'unknown-token' },
      { path: 'slug', message: 'Invalid' },
      null,
    ]);
    expect(out.map((i) => [i.kind, i.stepId, i.index])).toEqual([
      ['unknown-token', 'custom.t.a', 2],
      ['prompt-step-orphan', 'custom.t.b', undefined],
    ]);
  });

  it('tolerates a body with no issues', () => {
    expect(promptStepIssuesOf(undefined)).toEqual([]);
  });

  it('keeps the tool kinds an api save answers with', () => {
    const out = promptStepIssuesOf([
      { kind: 'tools-not-supported-yet', stepId: 'custom.t.a', index: 0, raw: '', start: 0 },
      { kind: 'tool-url-not-https', stepId: 'custom.t.a', index: 0, raw: 'repo_status', start: 0 },
      { kind: 'too-many-tools', stepId: 'custom.t.a', index: 0, raw: '', start: 0 },
    ]);
    expect(out.map((i) => [i.kind, i.raw])).toEqual([
      ['tools-not-supported-yet', ''],
      ['tool-url-not-https', 'repo_status'],
      ['too-many-tools', ''],
    ]);
  });
});
