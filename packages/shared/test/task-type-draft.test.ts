import { describe, expect, it } from 'vitest';
import {
  PROMPT_STEP_DRAFTABLE_KEYS,
  PROMPT_STEP_PROBLEM_KINDS,
  checkPromptSteps,
  mergePromptStepCatalog,
  parsePromptSteps,
  pickTaskTypeDraft,
  promptStepEntrySchema,
  validateTaskTypeDraft,
  type ComposableStepEntry,
  type CompositionIssue,
  type PromptStepIssueKind,
  type TaskTypeDefaultsIssue,
  type TaskTypeDraftIssue,
} from '../src/modularity/index.js';

const entry = (stepId: string, over: Partial<ComposableStepEntry> = {}): ComposableStepEntry => ({
  stepId,
  label: stepId,
  group: 'build',
  dispatchesCli: false,
  requires: [],
  provides: [],
  ...over,
});

const catalogOf = (...entries: ComposableStepEntry[]) => ({
  stepIds: new Set(entries.map((e) => e.stepId)),
  dispatchesCli: new Set(entries.filter((e) => e.dispatchesCli).map((e) => e.stepId)),
  composable: new Map(entries.map((e) => [e.stepId, e])),
});

const catalog = catalogOf(
  entry('ta-a', { provides: ['x'], agentAuthoredOutput: true }),
  entry('ta-b', {
    requires: [{ needs: 'x', reason: 'needs x' }],
    provides: ['y'],
    loopBudgetEditable: true,
  }),
  entry('ta-c', { requires: [{ needs: 'zzz', reason: 'needs zzz' }] }),
  entry('ta-repo', { requires: [{ needs: 'repository', reason: 'needs the repository' }] }),
  entry('ta-early', { precedes: ['x'] }),
  entry('ta-entails', { entails: ['never'] }),
  entry('ta-loops', { loopTargetStepId: 'ta-a' }),
  entry('ta-closes', { closes: true }),
);

const TYPE = 'tt-draft';
const CUSTOM_ID = `custom.${TYPE}.review`;

const step = (slug: string, over: Record<string, unknown> = {}) => ({
  slug,
  title: `Step ${slug}`,
  template: 'Review {{task.title}}',
  capabilities: [],
  timeoutMs: 300_000,
  ...over,
});

const draftOf = (over: Record<string, unknown> = {}) => ({
  slug: TYPE,
  displayName: 'Draft type',
  requiresRepository: true,
  stepIds: ['ta-a', 'ta-b', CUSTOM_ID],
  promptSteps: { review: step('review') },
  ...over,
});

const withStep = (over: Record<string, unknown>, draft: Record<string, unknown> = {}) =>
  draftOf({ promptSteps: { review: step('review', over) }, ...draft });

const noRepo = { requiresRepository: false };

const kindsOf = (issues: readonly TaskTypeDraftIssue[]): string[] =>
  issues.map((i) => ('kind' in i ? i.kind : `schema:${i.path}`));

const httpTool = {
  name: 'repo_status',
  description: 'Fetches the status of the repository.',
  action: 'http-get',
  url: 'https://api.example.com/v1/status',
};
const ragTool = {
  name: 'house_rules',
  description: 'Searches the house rules.',
  action: 'rag-query',
  scope: 'global',
};
const param = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  description: `The ${name}.`,
  type: 'string',
  ...over,
});
const withTools = (tools: unknown[], draft: Record<string, unknown> = {}) =>
  withStep({ tools }, draft);
const withHttp = (over: Record<string, unknown>, draft: Record<string, unknown> = {}) =>
  withTools([{ ...httpTool, ...over }], draft);

type KindOf = PromptStepIssueKind | CompositionIssue['kind'] | TaskTypeDefaultsIssue['kind'];
type Reach = { reaches: () => unknown } | { schemaPath: string; refuses: () => unknown };

// Every kind the save path can answer is a key here: a kind added later without a row fails to compile.
const KINDS: Record<KindOf, Reach> = {
  'prompt-step-missing': { reaches: () => draftOf({ promptSteps: {} }) },
  'prompt-step-orphan': { reaches: () => draftOf({ stepIds: ['ta-a', 'ta-b'] }) },
  'unknown-token': { reaches: () => withStep({ template: 'Say {{nope}}' }) },
  'field-not-declared': { reaches: () => withStep({ template: 'Say {{field:topic}}' }) },
  'persona-id-invalid': { reaches: () => withStep({ template: 'Be {{agent:Bad_Id}}' }) },
  'reserved-marker-in-template': { reaches: () => withStep({ template: 'Say [[HAIVE_X]]' }) },
  'integration-token': { reaches: () => withStep({ template: 'Say {{integration:x}}' }) },
  'persona-without-repository': {
    reaches: () => withStep({ template: 'Be {{agent:reviewer}}' }, noRepo),
  },
  'file-write-without-repository': {
    reaches: () => withStep({ capabilities: ['file_write'] }, noRepo),
  },
  'step-id-too-long': {
    reaches: () => {
      const [typeSlug, stepSlug] = ['a'.repeat(64), 's'.repeat(60)];
      return draftOf({
        slug: typeSlug,
        stepIds: [`custom.${typeSlug}.${stepSlug}`],
        promptSteps: { [stepSlug]: step(stepSlug) },
      });
    },
  },
  'step-token-not-earlier': { reaches: () => withStep({ template: 'Use\n{{step:ta-nope}}\n' }) },
  'step-token-not-quotable': { reaches: () => withStep({ template: 'Use\n{{step:ta-b}}\n' }) },
  'step-token-not-own-line': { reaches: () => withStep({ template: 'Use {{step:ta-a}} now' }) },
  'tools-not-supported-yet': { reaches: () => withTools([httpTool]) },
  'tool-name-reserved': { reaches: () => withHttp({ name: 'rag_search' }) },
  'tool-name-duplicate': { reaches: () => withTools([httpTool, httpTool]) },
  'tool-url-invalid': { reaches: () => withHttp({ url: 'https://api.example.com/a b' }) },
  'tool-url-not-https': { reaches: () => withHttp({ url: 'http://api.example.com/v1' }) },
  'tool-url-userinfo': { reaches: () => withHttp({ url: 'https://me@api.example.com/v1' }) },
  'tool-url-fragment': { reaches: () => withHttp({ url: 'https://api.example.com/v1#top' }) },
  'tool-host-ip-literal': { reaches: () => withHttp({ url: 'https://127.0.0.1/v1' }) },
  'tool-host-not-public': { reaches: () => withHttp({ url: 'https://localhost/v1' }) },
  'tool-placeholder-outside-path': {
    reaches: () => withHttp({ url: 'https://api.example.com/v1?q={q}', params: [param('q')] }),
  },
  'tool-param-undeclared': { reaches: () => withHttp({ url: 'https://api.example.com/v1/{id}' }) },
  'tool-param-unused': { reaches: () => withHttp({ params: [param('id')] }) },
  'tool-param-reused': {
    reaches: () => withHttp({ url: 'https://api.example.com/{id}/{id}', params: [param('id')] }),
  },
  'tool-param-duplicate': {
    reaches: () =>
      withHttp({ url: 'https://api.example.com/{id}', params: [param('id'), param('id')] }),
  },
  'tool-param-invalid': {
    reaches: () =>
      withHttp({
        url: 'https://api.example.com/{n}',
        params: [param('n', { type: 'integer', min: 5, max: 1 })],
      }),
  },
  'tool-scope-needs-repository': {
    reaches: () => withTools([{ ...ragTool, scope: 'project' }], noRepo),
  },
  'unknown-step': { reaches: () => draftOf({ stepIds: ['ta-nope', CUSTOM_ID] }) },
  'unmet-need': { reaches: () => draftOf({ stepIds: ['ta-c', CUSTOM_ID] }) },
  'too-late': { reaches: () => draftOf({ stepIds: ['ta-a', 'ta-early', CUSTOM_ID] }) },
  unfulfilled: { reaches: () => draftOf({ stepIds: ['ta-entails', CUSTOM_ID] }) },
  'missing-loop-target': { reaches: () => draftOf({ stepIds: ['ta-loops', CUSTOM_ID] }) },
  'duplicate-step': { reaches: () => draftOf({ stepIds: ['ta-a', 'ta-a', CUSTOM_ID] }) },
  'loop-after-closing': {
    reaches: () => draftOf({ stepIds: ['ta-a', 'ta-closes', 'ta-loops', CUSTOM_ID] }),
  },
  'default-key-not-in-steps': {
    reaches: () => draftOf({ stepLoopLimitDefaults: { 'ta-c': 3 } }),
  },
  'loop-limit-not-editable': { reaches: () => draftOf({ stepLoopLimitDefaults: { 'ta-a': 3 } }) },
  // The schema refuses these first, on the save path as here, so no kind ever names them.
  empty: { schemaPath: 'stepIds', refuses: () => draftOf({ stepIds: [] }) },
  'template-too-large': {
    schemaPath: 'promptSteps.review.template',
    refuses: () => withStep({ template: 'x'.repeat(16 * 1024 + 1) }),
  },
  'timeout-out-of-range': {
    schemaPath: 'promptSteps.review.timeoutMs',
    refuses: () => withStep({ timeoutMs: 5 }),
  },
  'capability-not-allowed': {
    schemaPath: 'promptSteps.review.capabilities.0',
    refuses: () => withStep({ capabilities: ['subagents'] }),
  },
  'too-many-tools': {
    schemaPath: 'promptSteps.review.tools',
    refuses: () => withTools(Array.from({ length: 9 }, () => httpTool)),
  },
  'tool-name-invalid': {
    schemaPath: 'promptSteps.review.tools.0.name',
    refuses: () => withHttp({ name: 'Bad-Name' }),
  },
  'tool-description-invalid': {
    schemaPath: 'promptSteps.review.tools.0.description',
    refuses: () => withHttp({ description: '' }),
  },
  'tool-too-many-params': {
    schemaPath: 'promptSteps.review.tools.0.params',
    refuses: () =>
      withHttp({
        params: Array.from({ length: 11 }, (_, i) => param(`p${String.fromCharCode(97 + i)}`)),
      }),
  },
  'tool-timeout-out-of-range': {
    schemaPath: 'promptSteps.review.tools.0.timeoutMs',
    refuses: () => withHttp({ timeoutMs: 5 }),
  },
  'tool-response-cap-out-of-range': {
    schemaPath: 'promptSteps.review.tools.0.maxResponseBytes',
    refuses: () => withHttp({ maxResponseBytes: 10 }),
  },
  'tool-top-k-out-of-range': {
    schemaPath: 'promptSteps.review.tools.0.topK',
    refuses: () => withTools([{ ...ragTool, topK: 99 }]),
  },
};

describe('PROMPT_STEP_DRAFTABLE_KEYS', () => {
  it('lists exactly the keys the prompt-step editor can show', () => {
    expect([...PROMPT_STEP_DRAFTABLE_KEYS]).toEqual([
      'slug',
      'title',
      'template',
      'capabilities',
      'timeoutMs',
    ]);
  });

  it('names the schema keys a draft cannot carry, so a new key is not draftable by default', () => {
    const excluded = Object.keys(promptStepEntrySchema.shape).filter(
      (key) => !(PROMPT_STEP_DRAFTABLE_KEYS as readonly string[]).includes(key),
    );
    expect(excluded.sort()).toEqual(['agentPool', 'description', 'paramFormSchema', 'tools']);
  });
});

describe('pickTaskTypeDraft', () => {
  it('keeps a full draft whole and drops nothing', () => {
    const full = draftOf({
      description: 'What it does',
      stepLoopLimitDefaults: { 'ta-b': 3 },
    });
    expect(pickTaskTypeDraft(full)).toEqual({ draft: full, dropped: [] });
  });

  it.each([
    'enabled',
    'selectable',
    'sortOrder',
    'preAnswerDefaults',
    'fixLoop',
    'tools',
    'agentPool',
    'paramFormSchema',
    'integrations',
    'surprise',
  ])('drops the draft key %s and names it', (key) => {
    const picked = pickTaskTypeDraft({ ...draftOf(), [key]: { anything: 1 } });
    expect(picked.dropped).toEqual([key]);
    expect(picked.draft).toEqual(draftOf());
    expect(key in picked.draft).toBe(false);
  });

  it.each(['description', 'paramFormSchema', 'tools', 'agentPool', 'integrations', 'surprise'])(
    'drops the prompt-step key %s and names its path',
    (key) => {
      const picked = pickTaskTypeDraft(withStep({ [key]: 'value' }));
      expect(picked.dropped).toEqual([`promptSteps.review.${key}`]);
      expect(picked.draft).toEqual(draftOf());
    },
  );

  it('lists every dropped path in the order it meets them, with the entry it belongs to', () => {
    const picked = pickTaskTypeDraft({
      ...draftOf({
        promptSteps: {
          review: step('review', { tools: [httpTool], agentPool: '*' }),
          second: step('second', { description: 'd', paramFormSchema: { fields: [] } }),
        },
      }),
      enabled: false,
      fixLoop: {},
    });
    expect(picked.dropped).toEqual([
      'promptSteps.review.tools',
      'promptSteps.review.agentPool',
      'promptSteps.second.description',
      'promptSteps.second.paramFormSchema',
      'enabled',
      'fixLoop',
    ]);
    expect(Object.keys(picked.draft)).not.toContain('enabled');
  });

  it('keeps the keys it does not judge, so the validator reports their bad shape', () => {
    expect(pickTaskTypeDraft({ promptSteps: [1], stepIds: 'x' })).toEqual({
      draft: { promptSteps: [1], stepIds: 'x' },
      dropped: [],
    });
    expect(pickTaskTypeDraft({ promptSteps: { review: 'text', other: null } })).toEqual({
      draft: { promptSteps: { review: 'text', other: null } },
      dropped: [],
    });
  });

  it.each([null, undefined, 'text', 7, ['slug']])('reads %j as an empty draft', (raw) => {
    expect(pickTaskTypeDraft(raw)).toEqual({ draft: {}, dropped: [] });
  });

  it('leaves its input untouched', () => {
    const raw = { ...draftOf(), enabled: true, tools: [httpTool] };
    const before = structuredClone(raw);
    pickTaskTypeDraft(raw);
    expect(raw).toEqual(before);
  });

  it('treats a key named __proto__ as data, never as a prototype', () => {
    const raw = JSON.parse(
      '{"__proto__":{"polluted":true},"promptSteps":{"__proto__":{"slug":"x"},"review":{"slug":"review","__proto__":{"y":1}}}}',
    ) as unknown;
    const picked = pickTaskTypeDraft(raw);
    expect(picked.dropped).toEqual(['__proto__', 'promptSteps.review.__proto__']);
    expect(Object.getPrototypeOf(picked.draft)).toBe(Object.prototype);
    const steps = picked.draft.promptSteps as Record<string, unknown>;
    expect(Object.getPrototypeOf(steps)).toBe(Object.prototype);
    expect(Object.keys(steps)).toEqual(['__proto__', 'review']);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('hands the validator a draft the save path would take', () => {
    const junk = {
      ...withStep({ tools: [httpTool], agentPool: '*', description: 'd' }),
      enabled: false,
      preAnswerDefaults: { 'ta-a': {} },
    };
    expect(validateTaskTypeDraft(junk, catalog).issues.length).toBeGreaterThan(0);
    const picked = pickTaskTypeDraft(junk);
    expect(picked.dropped).toHaveLength(5);
    expect(validateTaskTypeDraft(picked.draft, catalog)).toEqual({ issues: [], warnings: [] });
  });
});

describe('validateTaskTypeDraft', () => {
  it('accepts a draft the save path accepts', () => {
    expect(validateTaskTypeDraft(draftOf(), catalog)).toEqual({ issues: [], warnings: [] });
    const plain = draftOf({ stepIds: ['ta-a', 'ta-b'], promptSteps: undefined });
    expect(validateTaskTypeDraft(plain, catalog)).toEqual({ issues: [], warnings: [] });
  });

  it('has a row for every kind the save path answers', () => {
    const universe = [
      ...PROMPT_STEP_PROBLEM_KINDS,
      'prompt-step-missing',
      'prompt-step-orphan',
      'empty',
      'unknown-step',
      'unmet-need',
      'too-late',
      'unfulfilled',
      'missing-loop-target',
      'duplicate-step',
      'loop-after-closing',
      'default-key-not-in-steps',
      'loop-limit-not-editable',
    ];
    expect(Object.keys(KINDS).sort()).toEqual([...universe].sort());
  });

  describe.each(Object.entries(KINDS))('the kind %s', (kind, how) => {
    if ('reaches' in how) {
      it('is reachable through a draft', () => {
        const result = validateTaskTypeDraft(how.reaches(), catalog);
        expect(kindsOf(result.issues)).toContain(kind);
        expect(result.warnings).toEqual([]);
      });
    } else {
      it('is refused by the schema first, as on the save path', () => {
        const result = validateTaskTypeDraft(how.refuses(), catalog);
        expect(result.issues.length).toBeGreaterThan(0);
        expect(result.issues.every((i) => !('kind' in i))).toBe(true);
        expect(result.issues.map((i) => ('path' in i ? i.path : ''))).toContain(how.schemaPath);
      });
    }
  });

  it('reaches the defaults kind through both of its fields', () => {
    const fields = (draft: unknown) =>
      validateTaskTypeDraft(draft, catalog).issues.flatMap((i) =>
        'field' in i ? [`${i.kind}:${i.field}:${i.stepId}`] : [],
      );
    expect(fields(draftOf({ stepLoopLimitDefaults: { 'ta-c': 3 } }))).toEqual([
      'default-key-not-in-steps:stepLoopLimitDefaults:ta-c',
    ]);
    expect(fields(draftOf({ preAnswerDefaults: { 'ta-c': { a: 1 } } }))).toEqual([
      'default-key-not-in-steps:preAnswerDefaults:ta-c',
    ]);
  });

  it('judges the composition by the repository flag of the draft', () => {
    const needy = { stepIds: ['ta-repo', CUSTOM_ID] };
    expect(validateTaskTypeDraft(draftOf(needy), catalog).issues).toEqual([]);
    expect(validateTaskTypeDraft(draftOf({ ...needy, ...noRepo }), catalog).issues).toEqual([
      expect.objectContaining({ kind: 'unmet-need', stepId: 'ta-repo', needs: 'repository' }),
    ]);
  });

  it('accepts a draft with no repository when none of its steps needs one', () => {
    const result = validateTaskTypeDraft(
      draftOf({ ...noRepo, stepIds: ['ta-a', CUSTOM_ID] }),
      catalog,
    );
    expect(result).toEqual({ issues: [], warnings: [] });
  });

  it('returns the issue objects the save path returns', () => {
    const [missing] = validateTaskTypeDraft(draftOf({ promptSteps: {} }), catalog).issues;
    expect(missing).toEqual({
      kind: 'prompt-step-missing',
      stepId: CUSTOM_ID,
      index: 2,
      message: `${CUSTOM_ID} has no prompt step on this task type.`,
    });
    const [token] = validateTaskTypeDraft(withStep({ template: 'a {{nope}}' }), catalog).issues;
    expect(token).toMatchObject({
      kind: 'unknown-token',
      stepId: CUSTOM_ID,
      index: 2,
      raw: '{{nope}}',
      start: 2,
    });
    const [composition] = validateTaskTypeDraft(
      draftOf({ stepIds: ['ta-c', CUSTOM_ID] }),
      catalog,
    ).issues;
    expect(composition).toEqual({
      kind: 'unmet-need',
      index: 0,
      stepId: 'ta-c',
      needs: 'zzz',
      reason: 'needs zzz',
    });
    const [schema] = validateTaskTypeDraft(draftOf({ displayName: '' }), catalog).issues;
    expect(schema).toEqual({ path: 'displayName', message: expect.any(String) });
  });

  it('refuses a key the schema does not know, as a save does', () => {
    const { issues } = validateTaskTypeDraft({ ...draftOf(), fixLoop: {} }, catalog);
    expect(issues).toEqual([{ path: '', message: expect.stringContaining('fixLoop') }]);
  });

  it('stops at the first stage that finds a problem, in the order the save path runs them', () => {
    const everything = (over: Record<string, unknown>) =>
      kindsOf(validateTaskTypeDraft(over, catalog).issues);
    const schemaAndMore = withStep(
      { template: 'Say {{nope}}' },
      {
        displayName: '',
        stepIds: ['ta-c', CUSTOM_ID],
      },
    );
    expect(everything(schemaAndMore)).toEqual(['schema:displayName']);
    const promptAndMore = withStep(
      { template: 'Say {{nope}}' },
      {
        stepIds: ['ta-c', CUSTOM_ID],
        stepLoopLimitDefaults: { 'ta-a': 3 },
      },
    );
    expect(everything(promptAndMore)).toEqual(['unknown-token']);
    const compositionAndDefaults = draftOf({
      stepIds: ['ta-c', 'ta-a', CUSTOM_ID],
      stepLoopLimitDefaults: { 'ta-a': 3 },
    });
    expect(everything(compositionAndDefaults)).toEqual(['unmet-need']);
  });

  describe('personas', () => {
    const ghost = withStep({ template: 'Be {{agent:ghost}} and {{agent:reviewer}}' });

    it('warns about a persona outside the catalog and never refuses for it', () => {
      const result = validateTaskTypeDraft(ghost, catalog, ['reviewer']);
      expect(result.issues).toEqual([]);
      expect(result.warnings).toEqual([
        {
          kind: 'persona-not-in-catalog',
          stepId: CUSTOM_ID,
          raw: '{{agent:ghost}}',
          start: 3,
          message: expect.stringContaining('{{agent:ghost}}'),
        },
      ]);
    });

    it('takes the persona ids as a list or a set', () => {
      expect(validateTaskTypeDraft(ghost, catalog, new Set(['ghost', 'reviewer']))).toEqual({
        issues: [],
        warnings: [],
      });
      expect(validateTaskTypeDraft(ghost, catalog, []).warnings).toHaveLength(2);
    });

    it('checks nothing when it is given no persona ids', () => {
      expect(validateTaskTypeDraft(ghost, catalog)).toEqual({ issues: [], warnings: [] });
    });

    it('keeps the warning beside an issue of a later stage', () => {
      const both = withStep({ template: 'Be {{agent:ghost}}' }, { stepIds: ['ta-c', CUSTOM_ID] });
      const result = validateTaskTypeDraft(both, catalog, ['reviewer']);
      expect(kindsOf(result.issues)).toEqual(['unmet-need']);
      expect(result.warnings).toHaveLength(1);
    });

    it('does not turn the persona rules the save path has into warnings', () => {
      const result = validateTaskTypeDraft(
        withStep({ template: 'Be {{agent:reviewer}}' }, noRepo),
        catalog,
        ['reviewer'],
      );
      expect(kindsOf(result.issues)).toEqual(['persona-without-repository']);
      expect(result.warnings).toEqual([]);
    });
  });
});

describe('the pieces the save path and the draft check share', () => {
  const entries = {
    review: promptStepEntrySchema.parse(step('review')),
    second: promptStepEntrySchema.parse(step('second', { title: 'Second' })),
  };

  it('parsePromptSteps leaves out an entry that does not parse and reads a non-object as none', () => {
    expect(
      parsePromptSteps({ review: step('review'), broken: { slug: 'broken' }, text: 'x' }),
    ).toEqual({ review: entries.review });
    for (const raw of [null, undefined, 'x', 3]) expect(parsePromptSteps(raw)).toEqual({});
  });

  it('mergePromptStepCatalog adds the steps of an admin type and keeps the input', () => {
    const merged = mergePromptStepCatalog(catalog, {
      slug: TYPE,
      source: 'admin',
      requiresRepository: true,
      promptSteps: entries,
    });
    expect([...merged.composable.keys()].filter((id) => id.startsWith('custom.'))).toEqual([
      CUSTOM_ID,
      `custom.${TYPE}.second`,
    ]);
    expect(merged.composable.get(CUSTOM_ID)).toMatchObject({
      label: 'Step review',
      group: 'build',
      dispatchesCli: true,
      requires: [{ needs: 'repository', reason: 'Reads the repository.' }],
    });
    expect(merged.stepIds.has(CUSTOM_ID)).toBe(true);
    expect(merged.dispatchesCli.has(CUSTOM_ID)).toBe(true);
    expect(catalog.composable.has(CUSTOM_ID)).toBe(false);
    expect(catalog.stepIds.has(CUSTOM_ID)).toBe(false);
  });

  it('mergePromptStepCatalog returns the catalog itself when nothing is to add', () => {
    const def = { slug: TYPE, requiresRepository: true, promptSteps: entries };
    expect(mergePromptStepCatalog(catalog, { ...def, source: 'builtin' })).toBe(catalog);
    expect(mergePromptStepCatalog(catalog, { ...def, source: 'module:acme' })).toBe(catalog);
    expect(mergePromptStepCatalog(catalog, { ...def, source: 'admin', promptSteps: {} })).toBe(
      catalog,
    );
  });

  it('checkPromptSteps answers a missing id, an unused entry, and a step that does not fit', () => {
    const def = { slug: TYPE, stepIds: ['ta-a', CUSTOM_ID], requiresRepository: true };
    expect(checkPromptSteps(def, { review: entries.review }, catalog)).toEqual([]);
    expect(checkPromptSteps(def, {}, catalog).map((i) => i.kind)).toEqual(['prompt-step-missing']);
    expect(checkPromptSteps(def, entries, catalog).map((i) => [i.kind, i.stepId])).toEqual([
      ['prompt-step-orphan', `custom.${TYPE}.second`],
    ]);
    const late = promptStepEntrySchema.parse(step('review', { template: 'Use\n{{step:ta-b}}\n' }));
    expect(checkPromptSteps(def, { review: late }, catalog)).toEqual([
      expect.objectContaining({ kind: 'step-token-not-earlier', stepId: CUSTOM_ID, index: 1 }),
    ]);
  });
});
