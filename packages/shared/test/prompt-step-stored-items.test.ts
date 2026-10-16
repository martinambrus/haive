import { describe, expect, it } from 'vitest';
import {
  validatePromptStep,
  type PromptStepValidationContext,
  type PromptStepValidationInput,
} from '../src/modularity/prompt-steps.js';
import { checkPromptSteps, parsePromptSteps } from '../src/modularity/task-type-draft.js';

// Controls of J6a fix-1 (task #185): [F1] fails before the fix, [F0] is a pin that passes before and after.

const entry = (over: Record<string, unknown> = {}): PromptStepValidationInput =>
  ({
    template: 'Review {{task.title}}',
    capabilities: [],
    timeoutMs: 300_000,
    ...over,
  }) as PromptStepValidationInput;

const ctxOf = (over: Record<string, unknown> = {}): PromptStepValidationContext =>
  ({
    typeSlug: 'audit',
    requiresRepository: true,
    stepIdsBefore: ['01-worktree-setup'],
    ...over,
  }) as PromptStepValidationContext;

const found = (e: PromptStepValidationInput, c = ctxOf()) => validatePromptStep(e, c);
const seen = (e: PromptStepValidationInput, c = ctxOf()) => found(e, c).map((p) => [p.kind, p.raw]);

const req = (id: string, category: string, access: 'read' | 'write' = 'read') => ({
  id,
  category,
  access,
});

const tool = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  description: 'Fetches the status.',
  action: 'http-get',
  url: 'https://api.example.com/v1/status',
  query: [],
  params: [],
  timeoutMs: 10_000,
  maxResponseBytes: 32_768,
  ...over,
});

const FORGE = req('forge', 'forge');
const TRACKER = req('tracker', 'issues', 'write');
const modules = (count: number) =>
  Array.from({ length: count }, (_, i) => req(`r${i}`, `module.demo.c${i}`));
const positions = (count: number) => Array.from({ length: count }, (_, i) => `#${i}`);

const UNREADABLE_REQUIREMENTS: [string, unknown][] = [
  ['null', null],
  ['a number', 7],
  ['an empty object', {}],
  ['an object whose id is no string', { id: 3, category: 'forge', access: 'read' }],
];

const UNTYPED_TOOLS: [string, unknown][] = [
  ['null', null],
  ['an empty object', {}],
  ['a number', 7],
  ['a string', 'repo_status'],
  ['an object whose name is no string', tool('x', { name: 7 })],
];

describe('[F1] a stored requirement the schema cannot read', () => {
  it.each(UNREADABLE_REQUIREMENTS)(
    '[F1] is reported once as no longer valid when it is %s',
    (_label, item) => {
      expect(seen(entry({ integrations: [item] }))).toEqual([
        ['integration-no-longer-valid', '#0'],
      ]);
    },
  );

  it('[F1] is named by its position, beside requirements that read and raise nothing', () => {
    const items = [FORGE, ...UNREADABLE_REQUIREMENTS.map(([, item]) => item), TRACKER];

    expect(seen(entry({ integrations: items }))).toEqual([
      ['integration-no-longer-valid', '#1'],
      ['integration-no-longer-valid', '#2'],
      ['integration-no-longer-valid', '#3'],
      ['integration-no-longer-valid', '#4'],
    ]);
  });

  it('[F1] is named by its id when it has one', () => {
    expect(seen(entry({ integrations: [{ id: 'broken', access: 'read' }] }))).toEqual([
      ['integration-no-longer-valid', 'broken'],
    ]);
  });

  it('[F1] gets none of the field checks', () => {
    const c = ctxOf({ requiresRepository: false, integrationCategoryIds: new Set(['chat']) });
    const upper = { id: 'Bad_ID', category: 'forge', access: 'read' };
    const both = { id: 'both', category: 'forge', provider: 'github', access: 'read' };

    expect(seen(entry({ integrations: [upper] }), c)).toEqual([
      ['integration-no-longer-valid', 'Bad_ID'],
    ]);
    expect(seen(entry({ integrations: [both] }), c)).toEqual([
      ['integration-no-longer-valid', 'both'],
    ]);
  });

  it('[F1] leaves the requirements beside it to the checks they always had', () => {
    const items = [req('first', 'issues'), null, req('second', 'issues')];

    expect(seen(entry({ integrations: items }))).toEqual([
      ['integration-category-duplicate', 'second'],
      ['integration-no-longer-valid', '#1'],
    ]);
  });

  it('[F1] is left out of the count against the limit of eight', () => {
    expect(seen(entry({ integrations: [...modules(8), null] }))).toEqual([
      ['integration-no-longer-valid', '#8'],
    ]);
    expect(seen(entry({ integrations: [...modules(9), null] }))).toEqual([
      ['too-many-integrations', ''],
      ['integration-no-longer-valid', '#9'],
    ]);
  });

  it('[F1] is named, at most eight of them, with the rest counted in one problem', () => {
    const problems = found(entry({ integrations: Array.from({ length: 12 }, () => null) }));

    expect(problems.map((p) => p.raw)).toEqual([...positions(8), '']);
    expect(problems.every((p) => p.kind === 'integration-no-longer-valid')).toBe(true);
    expect(problems[8]!.message).toContain('4 more');
  });

  it('[F1] is worded as a requirement the server could not keep', () => {
    expect(found(entry({ integrations: [null] }))).toEqual(
      found(entry({ invalidIntegrations: ['#0'] })),
    );
  });
});

describe('[F1] a stored tool that is no object with a string name', () => {
  it.each(UNTYPED_TOOLS)(
    '[F1] is reported once as no longer valid when it is %s',
    (_label, item) => {
      expect(seen(entry({ tools: [item] }))).toEqual([['tool-no-longer-valid', '#0']]);
    },
  );

  it('[F1] is named by its position and is no duplicate of another', () => {
    expect(seen(entry({ tools: [{}, {}] }))).toEqual([
      ['tool-no-longer-valid', '#0'],
      ['tool-no-longer-valid', '#1'],
    ]);
    expect(seen(entry({ tools: [{}, null, {}] }))).toEqual([
      ['tool-no-longer-valid', '#0'],
      ['tool-no-longer-valid', '#1'],
      ['tool-no-longer-valid', '#2'],
    ]);
  });

  it('[F1] is left out of the count against the limit of eight', () => {
    const eight = Array.from({ length: 8 }, (_, i) => tool(`tool_${i}`));

    expect(seen(entry({ tools: [...eight, null] }))).toEqual([['tool-no-longer-valid', '#8']]);
  });

  it('[F1] stands beside the problems of the tools that do read', () => {
    const http = tool('repo_status', { url: 'http://api.example.com/v1/status' });

    expect(seen(entry({ tools: [http, null] }))).toEqual([
      ['tool-url-not-https', 'repo_status'],
      ['tool-no-longer-valid', '#1'],
    ]);
  });

  it('[F1] is named, at most eight of them, with the rest counted in one problem', () => {
    const problems = found(entry({ tools: Array.from({ length: 12 }, () => null) }));

    expect(problems.map((p) => p.raw)).toEqual([...positions(8), '']);
    expect(problems.every((p) => p.kind === 'tool-no-longer-valid')).toBe(true);
    expect(problems[8]!.message).toContain('4 more');
  });

  it('[F1] is worded as a tool the server could not keep', () => {
    expect(found(entry({ tools: [null] }))).toEqual(found(entry({ invalidTools: ['#0'] })));
  });
});

describe('[F1] the rest of a step that holds items it cannot type', () => {
  it('[F1] is still checked, and the items come after it', () => {
    const unreadable = {
      template: 'Say {{nope}}',
      timeoutMs: 1,
      tools: [null],
      integrations: [null],
    };

    expect(seen(entry(unreadable))).toEqual([
      ['unknown-token', '{{nope}}'],
      ['timeout-out-of-range', ''],
      ['tool-no-longer-valid', '#0'],
      ['integration-no-longer-valid', '#0'],
    ]);
  });
});

describe('[F1] checkPromptSteps on a stored entry as it was read', () => {
  const STEP = 'custom.audit.check';
  const def = { slug: 'audit', stepIds: ['01-worktree-setup', STEP], requiresRepository: true };
  const catalog = { composable: new Map() };
  const stored = {
    slug: 'check',
    title: 'Check',
    template: 'Say {{nope}}',
    capabilities: [],
    timeoutMs: 300_000,
  };
  const issuesOf = (promptSteps: unknown) =>
    checkPromptSteps(def, promptSteps as never, catalog).map(({ kind, stepId, index, raw }) => [
      kind,
      stepId,
      index,
      raw,
    ]);

  it('[F1] reports each unreadable item once, on the step it sits on', () => {
    const raw = {
      check: {
        ...stored,
        tools: [null, {}],
        integrations: UNREADABLE_REQUIREMENTS.map(([, item]) => item),
      },
    };

    expect(issuesOf(raw)).toEqual([
      ['unknown-token', STEP, 1, '{{nope}}'],
      ['tool-no-longer-valid', STEP, 1, '#0'],
      ['tool-no-longer-valid', STEP, 1, '#1'],
      ['integration-no-longer-valid', STEP, 1, '#0'],
      ['integration-no-longer-valid', STEP, 1, '#1'],
      ['integration-no-longer-valid', STEP, 1, '#2'],
      ['integration-no-longer-valid', STEP, 1, '#3'],
    ]);
  });

  it('[F1] answers what it answers for the same entry after parsePromptSteps read it', () => {
    const raw = {
      check: {
        ...stored,
        tools: [tool('repo_status'), null, {}, 7],
        integrations: [FORGE, null, 7, {}, { id: 3, category: 'forge', access: 'read' }, TRACKER],
      },
    };
    const asRead = issuesOf(parsePromptSteps(raw));

    expect(asRead).toHaveLength(8);
    expect(issuesOf(raw)).toEqual(asRead);
  });

  it('[F0] names what parsePromptSteps set aside, beside the entry it kept', () => {
    const stale = tool('stale', { description: 'd'.repeat(1025) });
    const raw = {
      check: {
        ...stored,
        template: 'Say hi',
        tools: [tool('good'), stale],
        integrations: [FORGE, { id: 'broken', access: 'read' }],
      },
    };

    expect(issuesOf(parsePromptSteps(raw))).toEqual([
      ['tool-no-longer-valid', STEP, 1, 'stale'],
      ['integration-no-longer-valid', STEP, 1, 'broken'],
    ]);
  });
});

describe('[F0] a stored entry the schema can read', () => {
  it('[F0] raises exactly the problems of the requirements it always raised', () => {
    const c = ctxOf({
      requiresRepository: false,
      integrationCategoryIds: new Set(['issues', 'forge', 'chat']),
    });
    const items = [
      { id: 'gh', provider: 'github', access: 'read' },
      req('1st', 'forge'),
      req('dup', 'issues'),
      req('dup', 'chat', 'write'),
      req('third', 'issues'),
      req('talk', 'mail'),
      req('prs', 'forge'),
    ];

    expect(found(entry({ integrations: items }), c)).toEqual([
      {
        kind: 'integration-provider-pinned',
        message:
          'The integration gh pins the provider github; a prompt step names a category and Haive resolves the account.',
        raw: 'gh',
        start: 0,
      },
      {
        kind: 'integration-id-invalid',
        message:
          'The integration id 1st must start with a lowercase letter and use only lowercase letters, digits and hyphens, up to 16 characters.',
        raw: '1st',
        start: 0,
      },
      {
        kind: 'integration-without-repository',
        message:
          'The integration 1st asks for the category forge, which works on a repository, and this task type has none.',
        raw: '1st',
        start: 0,
      },
      {
        kind: 'integration-id-duplicate',
        message: 'Two integrations of this step have the id dup; give each its own id.',
        raw: 'dup',
        start: 0,
      },
      {
        kind: 'integration-category-duplicate',
        message:
          'The integration third asks for the category issues, which another integration of this step already asks for; a step gets one account per category.',
        raw: 'third',
        start: 0,
      },
      {
        kind: 'integration-category-unknown',
        message:
          'The integration talk asks for the category mail, which this install does not have.',
        raw: 'talk',
        start: 0,
      },
      {
        kind: 'integration-category-duplicate',
        message:
          'The integration prs asks for the category forge, which another integration of this step already asks for; a step gets one account per category.',
        raw: 'prs',
        start: 0,
      },
      {
        kind: 'integration-without-repository',
        message:
          'The integration prs asks for the category forge, which works on a repository, and this task type has none.',
        raw: 'prs',
        start: 0,
      },
    ]);
  });

  it('[F0] raises exactly the problems of the tools it always raised', () => {
    const rag = {
      name: 'rag',
      action: 'rag-query',
      description: 'Searches.',
      scope: 'project',
      topK: 99,
      maxResponseBytes: 32_768,
    };
    const tools = [
      tool('good'),
      tool('bad', { url: 'http://api.example.com/v1/status' }),
      tool('rag_search'),
      tool('good'),
      rag,
    ];

    expect(found(entry({ tools }))).toEqual([
      {
        kind: 'tool-name-duplicate',
        message: 'Two tools in this step are named good.',
        raw: 'good',
        start: 0,
      },
      {
        kind: 'tool-url-not-https',
        message: 'The URL must start with https://.',
        raw: 'bad',
        start: 0,
      },
      {
        kind: 'tool-name-reserved',
        message:
          "The tool name rag_search is kept for Haive's own tools (rag_search, ddev_status, ddev_logs, ddev_restart).",
        raw: 'rag_search',
        start: 0,
      },
      {
        kind: 'tool-top-k-out-of-range',
        message: 'topK must be a whole number from 1 to 20.',
        raw: 'rag',
        start: 0,
      },
    ]);
  });

  it('[F0] keeps the detailed checks of a tool that has a name and breaks the schema', () => {
    const blank = tool('', { description: '', url: '' });
    const stale = tool('stale', { description: 'd'.repeat(1025) });

    expect(seen(entry({ tools: [blank] }))).toEqual([
      ['tool-name-invalid', ''],
      ['tool-description-invalid', ''],
      ['tool-url-invalid', ''],
    ]);
    expect(seen(entry({ tools: [stale] }))).toEqual([['tool-description-invalid', 'stale']]);
  });

  it('[F0] names the lists the server set aside, at most eight each, then counts the rest', () => {
    const names = Array.from({ length: 12 }, (_, i) => i);
    const problems = found(
      entry({
        invalidTools: names.map((i) => `tool_${i}`),
        invalidIntegrations: names.map((i) => `req-${i}`),
      }),
    );

    expect(problems.map((p) => [p.kind, p.raw])).toEqual([
      ...names.slice(0, 8).map((i) => ['tool-no-longer-valid', `tool_${i}`]),
      ['tool-no-longer-valid', ''],
      ...names.slice(0, 8).map((i) => ['integration-no-longer-valid', `req-${i}`]),
      ['integration-no-longer-valid', ''],
    ]);
    expect(problems[8]!.message).toBe('4 more tools no longer pass their checks.');
    expect(problems[17]!.message).toBe('4 more integrations no longer pass their checks.');
  });

  it('[F0] raises nothing for a step that declares neither', () => {
    for (const over of [{}, { tools: [], integrations: [] }])
      expect(found(entry(over))).toEqual([]);
  });
});
