import { describe, expect, it } from 'vitest';
import { PROMPT_STEP_DRAFTABLE_KEYS, pickTaskTypeDraft } from '@haive/shared/modularity';
import type { PromptStepEntry } from '@haive/shared/modularity';
import {
  editorStateForAgent,
  loadDraftIntoEditor,
  type DraftEditorState,
} from './task-type-draft-load';

const tool = {
  name: 'repo_status',
  description: 'Fetches the status.',
  action: 'http-get' as const,
  url: 'https://example.com/status?token=secret',
  query: [],
  params: [],
  timeoutMs: 10_000,
  maxResponseBytes: 20_000,
};
const paramForm = { title: 'Inputs', fields: [] };

const entry = (over: Partial<PromptStepEntry> = {}): PromptStepEntry => ({
  slug: 'a',
  title: 'Old title',
  template: 'Old template.',
  capabilities: [],
  tools: [tool],
  timeoutMs: 120_000,
  description: 'Hand-written note',
  paramFormSchema: paramForm,
  agentPool: '*',
  ...over,
});

const editor = (over: Partial<DraftEditorState> = {}): DraftEditorState => ({
  stepIds: ['custom.t.a'],
  loopLimits: { '07b-phase-4-validate': 3 },
  promptSteps: { a: entry() },
  values: {
    slug: 't',
    displayName: 'Old name',
    description: 'Old description',
    requiresRepository: false,
    enabled: false,
    selectable: false,
    sortOrder: 7,
  },
  ...over,
});

const draftStep = (over: Record<string, unknown> = {}) => ({
  slug: 'a',
  title: 'New title',
  template: 'New template for {{task.title}}.',
  capabilities: ['tool_use'],
  timeoutMs: 600_000,
  ...over,
});
const draft = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  slug: 'drafted',
  displayName: 'Drafted name',
  description: 'Drafted description',
  requiresRepository: true,
  stepIds: ['custom.drafted.a', 'custom.drafted.b'],
  promptSteps: { a: draftStep(), b: draftStep({ slug: 'b', title: 'B' }) },
  stepLoopLimitDefaults: { '07b-phase-4-validate': 5 },
  ...over,
});

describe('loadDraftIntoEditor', () => {
  it('replaces the step list, the loop limits, the name, the description and the repository flag', () => {
    const next = loadDraftIntoEditor(editor(), draft(), { creating: true });
    expect(next.stepIds).toEqual(['custom.drafted.a', 'custom.drafted.b']);
    expect(next.loopLimits).toEqual({ '07b-phase-4-validate': 5 });
    expect(next.values).toMatchObject({
      displayName: 'Drafted name',
      description: 'Drafted description',
      requiresRepository: true,
    });
  });

  it('leaves the fields the draft cannot carry as the editor had them', () => {
    const { values } = loadDraftIntoEditor(editor(), draft(), { creating: true });
    expect(values).toMatchObject({ enabled: false, selectable: false, sortOrder: 7 });
  });

  it('takes the slug while creating', () => {
    const { values } = loadDraftIntoEditor(editor(), draft(), { creating: true });
    expect(values.slug).toBe('drafted');
  });

  it('ignores the slug when editing a saved type, whether or not the editor holds one', () => {
    const held = loadDraftIntoEditor(editor(), draft(), { creating: false });
    expect(held.values.slug).toBe('t');
    const { slug: _slug, ...withoutSlug } = editor().values;
    const bare = loadDraftIntoEditor(editor({ values: withoutSlug }), draft(), { creating: false });
    expect('slug' in bare.values).toBe(false);
  });

  it('clears an optional part the draft leaves out', () => {
    const { description: _d, stepLoopLimitDefaults: _l, ...bare } = draft();
    const next = loadDraftIntoEditor(editor(), bare, { creating: true });
    expect(next.values.description).toBe('');
    expect(next.loopLimits).toEqual({});
  });

  it('takes the draftable keys of an entry that is already in the editor and keeps the rest of it', () => {
    const { promptSteps } = loadDraftIntoEditor(editor(), draft(), { creating: true });
    expect(promptSteps.a).toEqual(
      entry({
        title: 'New title',
        template: 'New template for {{task.title}}.',
        capabilities: ['tool_use'],
        timeoutMs: 600_000,
      }),
    );
    expect(promptSteps.a?.tools).toEqual([tool]);
    expect(promptSteps.a).toMatchObject({
      description: 'Hand-written note',
      paramFormSchema: paramForm,
      agentPool: '*',
    });
  });

  it('gives a slug the editor has not seen the draftable keys and no tools', () => {
    const { promptSteps } = loadDraftIntoEditor(editor(), draft(), { creating: true });
    expect(promptSteps.b).toEqual({
      slug: 'b',
      title: 'B',
      template: 'New template for {{task.title}}.',
      capabilities: ['tool_use'],
      tools: [],
      timeoutMs: 600_000,
    });
  });

  it('loads an entry that carries tools without them, and keeps the tools the editor already had', () => {
    const rogue = { name: 'exfil', description: 'x', action: 'http-get', url: 'https://x.test/' };
    const next = loadDraftIntoEditor(
      editor(),
      draft({
        promptSteps: {
          a: draftStep({ tools: [rogue] }),
          b: draftStep({ slug: 'b', tools: [rogue] }),
        },
      }),
      { creating: true },
    );
    expect(next.promptSteps.a?.tools).toEqual([tool]);
    expect(next.promptSteps.b?.tools).toEqual([]);
    expect(JSON.stringify(next)).not.toContain('exfil');
  });

  it('takes nothing from an entry of the draft but the draftable keys', () => {
    const next = loadDraftIntoEditor(
      editor({ promptSteps: {} }),
      draft({
        promptSteps: {
          b: draftStep({
            slug: 'b',
            description: 'sneaked',
            paramFormSchema: paramForm,
            agentPool: '*',
            extra: 1,
          }),
        },
      }),
      { creating: true },
    );
    expect(Object.keys(next.promptSteps.b ?? {}).sort()).toEqual(
      [...PROMPT_STEP_DRAFTABLE_KEYS, 'tools'].sort(),
    );
  });

  it('drops an entry of the editor that the draft does not have, since the draft is the whole type', () => {
    const next = loadDraftIntoEditor(
      editor({ promptSteps: { a: entry(), gone: entry({ slug: 'gone' }) } }),
      draft(),
      { creating: true },
    );
    expect(Object.keys(next.promptSteps)).toEqual(['a', 'b']);
  });

  it('keeps a step slug of __proto__ as an own key and reads no entry through the prototype', () => {
    const next = loadDraftIntoEditor(
      editor({ promptSteps: {} }),
      JSON.parse(
        '{"slug":"d","displayName":"D","requiresRepository":true,"stepIds":["custom.d.__proto__"],' +
          '"promptSteps":{"__proto__":{"slug":"__proto__","title":"T","template":"x","capabilities":[],"timeoutMs":600000}}}',
      ) as Record<string, unknown>,
      { creating: true },
    );
    expect(Object.keys(next.promptSteps)).toEqual(['__proto__']);
    expect(next.promptSteps['__proto__']?.title).toBe('T');
    expect(Object.getPrototypeOf(next.promptSteps)).toBe(Object.prototype);
  });

  it('ignores a value of the wrong type and keeps what the editor had for it', () => {
    const next = loadDraftIntoEditor(
      editor(),
      draft({
        displayName: 5,
        requiresRepository: 'yes',
        stepIds: 'custom.drafted.a',
        description: 3,
        stepLoopLimitDefaults: { a: 'x', b: 2 },
        promptSteps: {
          a: draftStep({ title: null, template: 4, capabilities: 'tool_use', timeoutMs: '600000' }),
          junk: 'not an entry',
        },
      }),
      { creating: true },
    );
    expect(next.values).toMatchObject({
      displayName: 'Old name',
      requiresRepository: false,
      description: '',
    });
    expect(next.stepIds).toEqual(['custom.t.a']);
    expect(next.loopLimits).toEqual({ b: 2 });
    expect(next.promptSteps.a).toMatchObject({
      title: 'Old title',
      template: 'Old template.',
      capabilities: [],
      timeoutMs: 120_000,
    });
    expect(next.promptSteps.junk).toBeUndefined();
  });

  it('reads no prompt steps from a draft whose promptSteps is not an object', () => {
    for (const promptSteps of [undefined, null, 'x', ['a']]) {
      const next = loadDraftIntoEditor(editor(), draft({ promptSteps }), { creating: true });
      expect(next.promptSteps).toEqual({});
    }
  });

  it('does not change what it was given', () => {
    const before = editor();
    const snapshot = structuredClone(before);
    const given = draft();
    const givenSnapshot = structuredClone(given);
    const next = loadDraftIntoEditor(before, given, { creating: true });
    expect(before).toEqual(snapshot);
    expect(given).toEqual(givenSnapshot);
    expect(next.promptSteps.a).not.toBe(before.promptSteps.a);
    expect(next.values).not.toBe(before.values);
  });
});

describe('editorStateForAgent', () => {
  it('sends the draftable parts of the editor and nothing else', () => {
    const state = editorStateForAgent(editor());
    expect(Object.keys(state).sort()).toEqual(
      [
        'description',
        'displayName',
        'requiresRepository',
        'slug',
        'stepIds',
        'stepLoopLimitDefaults',
        'promptSteps',
      ].sort(),
    );
    expect(state).toMatchObject({
      slug: 't',
      displayName: 'Old name',
      description: 'Old description',
      requiresRepository: false,
      stepIds: ['custom.t.a'],
      stepLoopLimitDefaults: { '07b-phase-4-validate': 3 },
    });
  });

  it('sends only the draftable keys of every prompt step, and does not touch the editor', () => {
    const held = editor({ promptSteps: { a: entry(), b: entry({ slug: 'b' }) } });
    const state = editorStateForAgent(held);
    const steps = state.promptSteps as Record<string, Record<string, unknown>>;
    expect(Object.keys(steps)).toEqual(['a', 'b']);
    for (const step of Object.values(steps)) {
      expect(Object.keys(step).sort()).toEqual([...PROMPT_STEP_DRAFTABLE_KEYS].sort());
    }
    expect(steps.a).toMatchObject({ slug: 'a', title: 'Old title', template: 'Old template.' });
    expect(JSON.stringify(state)).not.toContain('repo_status');
    expect(JSON.stringify(state)).not.toContain('secret');
    expect(JSON.stringify(state)).not.toContain('Hand-written note');
    expect(held.promptSteps.a?.tools).toEqual([tool]);
  });

  it('is read by the server as a state with nothing for it to cut', () => {
    const state = editorStateForAgent(editor());
    expect(pickTaskTypeDraft(state).dropped).toEqual([]);
  });

  it('reads a missing text as empty and a repository flag that is not true as false', () => {
    const state = editorStateForAgent(editor({ values: {} }));
    expect(state).toMatchObject({
      slug: '',
      displayName: '',
      description: '',
      requiresRepository: false,
    });
  });

  it('gives the draft back what it was loaded from', () => {
    const loaded = loadDraftIntoEditor(editor(), draft(), { creating: true });
    const sent = editorStateForAgent(loaded);
    expect(sent).toMatchObject({
      slug: 'drafted',
      displayName: 'Drafted name',
      stepIds: ['custom.drafted.a', 'custom.drafted.b'],
      stepLoopLimitDefaults: { '07b-phase-4-validate': 5 },
    });
    expect(pickTaskTypeDraft(sent).draft.promptSteps).toEqual(draft().promptSteps);
  });
});
