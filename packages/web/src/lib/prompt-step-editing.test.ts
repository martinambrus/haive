import { describe, expect, it } from 'vitest';
import type { ComposableStepEntry, CustomTool, PromptStepEntry } from '@haive/shared/modularity';
import { catalogEntries } from './composition-messages';
import { TEST_CATALOG } from './composition-test-catalog';
import {
  DEFAULT_PROMPT_STEP_TIMEOUT_MS,
  listedPromptSteps,
  newPromptStep,
  promptStepIssues,
  promptStepSlugOf,
  renamePromptStepIds,
  renamePromptStepTokens,
  samePromptSteps,
  takenPromptSlugs,
  withPromptStepEntries,
} from './prompt-step-editing';

const entry = (slug: string, over: Partial<PromptStepEntry> = {}): PromptStepEntry => ({
  slug,
  title: `Title ${slug}`,
  template: 'Do the thing',
  capabilities: [],
  tools: [],
  timeoutMs: 300_000,
  ...over,
});

const base = catalogEntries(TEST_CATALOG);
const agentAuthored: ComposableStepEntry = {
  stepId: '05-agent-written',
  label: 'Agent written',
  group: 'spec',
  dispatchesCli: true,
  requires: [],
  provides: [],
  agentAuthoredOutput: true,
};

describe('newPromptStep', () => {
  it('starts empty with the default timeout, no capabilities and no tools', () => {
    expect(newPromptStep([])).toEqual({
      slug: 'prompt-step',
      title: 'Prompt step',
      template: '',
      capabilities: [],
      tools: [],
      timeoutMs: DEFAULT_PROMPT_STEP_TIMEOUT_MS,
    });
    expect(DEFAULT_PROMPT_STEP_TIMEOUT_MS).toBe(300_000);
  });

  it('takes the next free slug', () => {
    expect(newPromptStep(['prompt-step']).slug).toBe('prompt-step-2');
    expect(newPromptStep(['prompt-step', 'prompt-step-2']).slug).toBe('prompt-step-3');
    expect(newPromptStep(['prompt-step-2']).slug).toBe('prompt-step');
  });

  it('counts a custom id in the list as taken, whatever the entries hold', () => {
    const taken = takenPromptSlugs({}, ['custom.t.prompt-step', '04-phase-0b-pre-planning'], 't');
    expect(taken).toEqual(['prompt-step']);
    expect(newPromptStep(taken).slug).toBe('prompt-step-2');
  });
});

describe('promptStepSlugOf', () => {
  it('reads the slug of this type only', () => {
    expect(promptStepSlugOf('custom.t.a-b', 't')).toBe('a-b');
    expect(promptStepSlugOf('custom.other.a', 't')).toBeNull();
    expect(promptStepSlugOf('04-phase-0b-pre-planning', 't')).toBeNull();
  });
});

describe('withPromptStepEntries', () => {
  it('adds each prompt step as a composable agent step labelled by its title', () => {
    const merged = withPromptStepEntries(base, 't', false, { a: entry('a') });
    expect(merged.get('custom.t.a')).toMatchObject({
      stepId: 'custom.t.a',
      label: 'Title a',
      dispatchesCli: true,
      requires: [],
    });
    expect(merged.size).toBe(base.size + 1);
    expect(base.has('custom.t.a')).toBe(false);
  });

  it('needs the repository, or the worktree when it writes files', () => {
    const merged = withPromptStepEntries(base, 't', true, {
      a: entry('a'),
      w: entry('w', { capabilities: ['file_write'] }),
    });
    expect(merged.get('custom.t.a')?.requires.map((r) => r.needs)).toEqual(['repository']);
    expect(merged.get('custom.t.w')?.requires.map((r) => r.needs)).toEqual(['worktree']);
  });
});

describe('promptStepIssues', () => {
  const issues = (
    stepIds: string[],
    promptSteps: Record<string, PromptStepEntry>,
    requiresRepository = true,
    catalog = base,
  ) => promptStepIssues({ typeSlug: 't', stepIds, requiresRepository, promptSteps, catalog });

  it('is empty for a sound step', () => {
    expect(issues(['custom.t.a'], { a: entry('a') })).toEqual([]);
  });

  it('flags an empty template and an empty title on the step row', () => {
    const out = issues(['04-phase-0b-pre-planning', 'custom.t.a'], {
      a: entry('a', { template: '  ', title: '' }),
    });
    expect(out.map((i) => [i.kind, i.index, i.stepId])).toEqual([
      ['title-empty', 1, 'custom.t.a'],
      ['template-empty', 1, 'custom.t.a'],
    ]);
  });

  it('carries the validator problems with their token', () => {
    const out = issues(['custom.t.a'], {
      a: entry('a', { template: 'Hi {{bogus}} and {{field:x}}' }),
    });
    expect(out.map((i) => [i.kind, i.raw])).toEqual([
      ['unknown-token', '{{bogus}}'],
      ['field-not-declared', '{{field:x}}'],
    ]);
  });

  it('allows a step token only for an earlier prompt step or an agent-authored catalog step', () => {
    const withAgent = new Map(base).set(agentAuthored.stepId, agentAuthored);
    const ok = issues(
      ['05-agent-written', 'custom.t.a', 'custom.t.b'],
      {
        a: entry('a', { template: '{{step:05-agent-written}}' }),
        b: entry('b', { template: '{{step:custom.t.a}}' }),
      },
      true,
      withAgent,
    );
    expect(ok).toEqual([]);
    const bad = issues(
      ['04-phase-0b-pre-planning', 'custom.t.a'],
      { a: entry('a', { template: '{{step:04-phase-0b-pre-planning}}' }) },
      true,
      base,
    );
    expect(bad.map((i) => i.kind)).toEqual(['step-token-not-quotable']);
    const later = issues(['custom.t.a', 'custom.t.b'], {
      a: entry('a', { template: '{{step:custom.t.b}}' }),
      b: entry('b'),
    });
    expect(later.map((i) => i.kind)).toEqual(['step-token-not-earlier']);
  });

  it('needs a repository for an agent token and for writing files', () => {
    const out = issues(
      ['custom.t.a'],
      { a: entry('a', { template: '{{agent:reviewer}}', capabilities: ['file_write'] }) },
      false,
    );
    expect(out.map((i) => i.kind).sort()).toEqual([
      'file-write-without-repository',
      'persona-without-repository',
    ]);
  });

  it('flags a timeout outside the bounds', () => {
    expect(issues(['custom.t.a'], { a: entry('a', { timeoutMs: 0 }) }).map((i) => i.kind)).toEqual([
      'timeout-out-of-range',
    ]);
    expect(
      issues(['custom.t.a'], { a: entry('a', { timeoutMs: 31 * 60_000 }) }).map((i) => i.kind),
    ).toEqual(['timeout-out-of-range']);
  });

  it('ignores a custom id with no entry and an entry that is not listed', () => {
    expect(issues(['custom.t.gone'], {})).toEqual([]);
    expect(issues(['04-phase-0b-pre-planning'], { a: entry('a', { template: '' }) })).toEqual([]);
  });

  it('refuses tools for now and names the tool of each tool problem', () => {
    const tool: CustomTool = {
      name: 'repo_status',
      description: 'Fetches the status of one repository.',
      action: 'http-get',
      url: 'http://api.example.com/v1/status',
      query: [],
      params: [],
      timeoutMs: 10_000,
      maxResponseBytes: 32_768,
    };
    const out = issues(['custom.t.a'], { a: entry('a', { tools: [tool] }) });
    expect(out.map((i) => [i.kind, i.raw, i.stepId])).toEqual([
      ['tool-url-not-https', 'repo_status', 'custom.t.a'],
      ['tools-not-supported-yet', '', 'custom.t.a'],
    ]);
  });
});

describe('renamePromptStepTokens', () => {
  const step = (slug: string, template: string) => ({
    slug,
    title: slug,
    template,
    capabilities: [],
    tools: [],
    timeoutMs: 300_000,
  });

  it("follows the type slug in another step's quote of an earlier prompt step", () => {
    const steps = {
      first: step('first', 'Draft it.'),
      second: step('second', 'Review:\n{{step:custom.ab.first}}\n{{step:01-worktree-setup}}'),
    };
    const next = renamePromptStepTokens(steps, 'ab', 'abc');
    expect(next.second!.template).toBe(
      'Review:\n{{step:custom.abc.first}}\n{{step:01-worktree-setup}}',
    );
    expect(next.first).toBe(steps.first);
  });

  it('returns the same record when no template quotes this type', () => {
    const steps = { a: step('a', 'Plain {{task.title}}') };
    expect(renamePromptStepTokens(steps, 'ab', 'abc')).toBe(steps);
    expect(renamePromptStepTokens(steps, 'ab', 'ab')).toBe(steps);
  });
});

describe('renamePromptStepIds', () => {
  it("moves only this type slug's custom ids", () => {
    expect(
      renamePromptStepIds(['custom.ab.x', '01-worktree-setup', 'custom.zz.y'], 'ab', 'abc'),
    ).toEqual(['custom.abc.x', '01-worktree-setup', 'custom.zz.y']);
  });

  it('returns the same list when nothing moves', () => {
    const ids = ['01-worktree-setup'];
    expect(renamePromptStepIds(ids, 'a', 'b')).toBe(ids);
    expect(renamePromptStepIds(ids, 'a', 'a')).toBe(ids);
  });

  it('handles an empty previous slug', () => {
    expect(renamePromptStepIds(['custom..x'], '', 'new')).toEqual(['custom.new.x']);
  });
});

describe('listedPromptSteps and samePromptSteps', () => {
  it('drops the entries whose id is no longer in the list', () => {
    expect(listedPromptSteps({ a: entry('a'), b: entry('b') }, ['custom.t.b'], 't')).toEqual({
      b: entry('b'),
    });
  });

  it('compares entries by content, capabilities in order', () => {
    expect(samePromptSteps({ a: entry('a') }, { a: entry('a') })).toBe(true);
    expect(samePromptSteps({ a: entry('a') }, { a: entry('a', { title: 'x' }) })).toBe(false);
    expect(samePromptSteps({ a: entry('a') }, {})).toBe(false);
    expect(samePromptSteps({}, {})).toBe(true);
  });
});
