import { describe, expect, it } from 'vitest';
import { composableStepEntrySchema } from '../src/modularity/contracts.js';
import { CUSTOM_TOOL_PROBLEM_KINDS } from '../src/modularity/custom-tools.js';
import {
  PROMPT_STEP_PROBLEM_KINDS,
  derivePromptStepComposable,
  parsePinnedCustomSteps,
  parsePromptStepEntry,
  promptStepEntrySchema,
  validatePromptStep,
  type PromptStepValidationContext,
  type PromptStepValidationInput,
} from '../src/modularity/prompt-steps.js';
import {
  mergePromptStepCatalog,
  parsePromptSteps,
  pickTaskTypeDraft,
} from '../src/modularity/task-type-draft.js';

// Controls of J6a (task #185): a prompt step declares the integrations it needs. Tags: [C1] is inside the
// brief, [C1+] is a pin the brief does not state (listed in the harness README), [C0] passes before and after.

type Requirement = {
  id: string;
  category?: string;
  provider?: string;
  access: 'read' | 'write';
  optional?: boolean;
};
type Parsed = { integrations?: Requirement[]; invalidIntegrations?: string[] } | undefined;

const view = (value: unknown): Parsed => (value ?? undefined) as Parsed;

const CORE_CATEGORIES = [
  'rich-documents',
  'spreadsheets',
  'file-storage',
  'mail',
  'chat',
  'issues',
  'wiki',
  'forge',
];

// Every kind a prompt step could raise before J6a: the 14 of the first release, the custom-tool kinds, and the stored-tool kind.
const KINDS_BEFORE_J6A: ReadonlySet<string> = new Set([
  'unknown-token',
  'field-not-declared',
  'persona-id-invalid',
  'reserved-marker-in-template',
  'integration-token',
  'template-too-large',
  'timeout-out-of-range',
  'capability-not-allowed',
  'persona-without-repository',
  'file-write-without-repository',
  'step-id-too-long',
  'step-token-not-earlier',
  'step-token-not-quotable',
  'step-token-not-own-line',
  ...CUSTOM_TOOL_PROBLEM_KINDS,
  'tool-no-longer-valid',
]);

const req = (
  id: string,
  category: string,
  access: 'read' | 'write' = 'read',
  optional?: boolean,
): Requirement => ({ id, category, access, ...(optional === undefined ? {} : { optional }) });

const FORGE = req('forge', 'forge');
const TRACKER = req('tracker', 'issues', 'write', true);
const EIGHT = CORE_CATEGORIES.map((category, i) => req(`r${i}`, category));
const NINE = [...EIGHT, req('r8', 'module.demo.extra')];

const STORED = { slug: 'check', title: 'Check', template: 'Do {{task.title}}', timeoutMs: 120_000 };

const entry = (
  integrations: unknown[] | undefined,
  over: Record<string, unknown> = {},
): PromptStepValidationInput =>
  ({
    template: 'Review {{task.title}}',
    capabilities: [],
    timeoutMs: 300_000,
    ...(integrations === undefined ? {} : { integrations }),
    ...over,
  }) as PromptStepValidationInput;

const ctxOf = (over: Record<string, unknown> = {}): PromptStepValidationContext =>
  ({
    typeSlug: 'audit',
    requiresRepository: true,
    stepIdsBefore: ['01-worktree-setup'],
    ...over,
  }) as PromptStepValidationContext;

const problemsOf = (e: PromptStepValidationInput, c = ctxOf()) => validatePromptStep(e, c);
const kindsOf = (e: PromptStepValidationInput, c = ctxOf()): string[] =>
  problemsOf(e, c).map((p) => p.kind as string);

/** The entry as a task reads it back from custom_steps: it must carry the declaration, or nothing after it can judge it. */
function readBack(requirements: unknown[]): PromptStepValidationInput {
  const read = parsePinnedCustomSteps({
    'custom.audit.check': { ...STORED, integrations: requirements },
  })['custom.audit.check'];
  expect(view(read)?.integrations, 'the stored declaration survives a read').toEqual(requirements);
  return read as unknown as PromptStepValidationInput;
}

describe('[C1] a stored prompt step is read one requirement at a time', () => {
  describe.each([
    ['parsePromptStepEntry', (raw: unknown) => view(parsePromptStepEntry(raw))],
    ['parsePromptSteps', (raw: unknown) => view(parsePromptSteps({ check: raw }).check)],
    [
      'parsePinnedCustomSteps',
      (raw: unknown) =>
        view(parsePinnedCustomSteps({ 'custom.demo.check': raw })['custom.demo.check']),
    ],
  ])('%s', (_name, parse) => {
    const BAD_SHAPES: [string, unknown, string][] = [
      ['neither a category nor a provider', { id: 'broken', access: 'read' }, 'broken'],
      [
        'both a category and a provider',
        { id: 'broken', category: 'forge', provider: 'github', access: 'read' },
        'broken',
      ],
      [
        'an access that is neither read nor write',
        { id: 'broken', category: 'forge', access: 'admin' },
        'broken',
      ],
      [
        'an id with an uppercase letter',
        { id: 'Broken', category: 'forge', access: 'read' },
        'Broken',
      ],
      [
        'a category that is no category id',
        { id: 'broken', category: 'Not A Category', access: 'read' },
        'broken',
      ],
    ];

    it.each(BAD_SHAPES)(
      '[C1] keeps the step and its valid requirement, and names the one with %s',
      (_label, bad, id) => {
        for (const stored of [
          [FORGE, bad],
          [bad, FORGE],
        ]) {
          const parsed = parse({ ...STORED, integrations: stored });

          expect(parsed, 'the step is dropped').toBeDefined();
          expect(parsed?.integrations, 'integrations kept by the read').toEqual([FORGE]);
          expect(parsed?.invalidIntegrations, 'invalidIntegrations of the read').toHaveLength(1);
          expect(parsed?.invalidIntegrations?.[0]).toContain(id);
        }
      },
    );

    it('[C1] keeps every valid requirement in order, flags and all', () => {
      const parsed = parse({ ...STORED, integrations: [FORGE, { nope: 1 }, TRACKER] });

      expect(parsed?.integrations, 'integrations kept by the read').toEqual([FORGE, TRACKER]);
      expect(parsed?.invalidIntegrations, 'invalidIntegrations of the read').toHaveLength(1);
    });

    it('[C1+] names a requirement with no id, or none that is an object, by its position', () => {
      const parsed = parse({
        ...STORED,
        integrations: [FORGE, { category: 'issues', access: 'read' }, null, 'forge', 7],
      });

      expect(parsed?.integrations, 'integrations kept by the read').toEqual([FORGE]);
      expect(parsed?.invalidIntegrations, 'invalidIntegrations of the read').toEqual([
        '#1',
        '#2',
        '#3',
        '#4',
      ]);
    });

    it('[C1+] lists every invalid requirement, in order, and keeps a step left with none valid', () => {
      const parsed = parse({
        ...STORED,
        integrations: [
          { id: 'a', access: 'read' },
          { id: 'b', access: 'read' },
          { id: 'a', access: 'read' },
        ],
      });

      expect(parsed, 'the step is dropped').toBeDefined();
      expect(parsed?.integrations, 'integrations kept by the read').toEqual([]);
      expect(parsed?.invalidIntegrations, 'invalidIntegrations of the read').toEqual([
        'a',
        'b',
        'a',
      ]);
    });

    it('[C1+] never loses a requirement: every one of nine is kept or named', () => {
      const nine = NINE.map((requirement) => ({ ...requirement }));

      const parsed = parse({ ...STORED, integrations: nine });

      expect(parsed, 'the step is dropped').toBeDefined();
      const kept = parsed?.integrations ?? [];
      const named = parsed?.invalidIntegrations ?? [];
      expect(kept.length + named.length, 'requirements kept or named of the nine').toBe(9);
      expect(kept.slice(0, 8), 'the first eight kept').toEqual(nine.slice(0, 8));
    });

    it('[C1+] drops the step when what it declares is no list', () => {
      for (const integrations of ['forge', null, {}, 3]) {
        expect(parse({ ...STORED, integrations }), JSON.stringify(integrations)).toBeUndefined();
      }
    });

    it('[C1+] adds no invalidIntegrations key when every requirement is valid, and reads what the schema reads', () => {
      for (const input of [
        { ...STORED, integrations: [FORGE] },
        { ...STORED, integrations: [FORGE, TRACKER] },
      ]) {
        const parsed = parse(input);

        expect(parsed?.integrations, 'integrations kept by the read').toEqual(input.integrations);
        expect(parsed).toEqual(promptStepEntrySchema.parse(input));
        expect(parsed).not.toHaveProperty('invalidIntegrations');
      }
    });

    it('[C1+] derives invalidIntegrations from the list and takes none from the input', () => {
      expect(
        parse({ ...STORED, integrations: [FORGE], invalidIntegrations: ['forged'] }),
      ).not.toHaveProperty('invalidIntegrations');
      expect(
        parse({
          ...STORED,
          integrations: [{ id: 'bad', access: 'read' }],
          invalidIntegrations: ['forged'],
        })?.invalidIntegrations,
        'invalidIntegrations of the read',
      ).toEqual(['bad']);
    });

    it('[C0] reads a step that declares none as it always did, with no key for them', () => {
      for (const input of [STORED, { ...STORED, integrations: [] }]) {
        const parsed = parse(input);

        expect(parsed, 'the step is dropped').toBeDefined();
        expect(parsed?.integrations ?? []).toEqual([]);
        expect(parsed).not.toHaveProperty('invalidIntegrations');
      }
    });

    it('[C0] still drops the step when a field other than its requirements fails', () => {
      for (const over of [
        { template: '' },
        { title: '' },
        { timeoutMs: 5 },
        { slug: 'Bad Slug' },
      ]) {
        expect(
          parse({ ...STORED, ...over, integrations: [FORGE] }),
          JSON.stringify(over),
        ).toBeUndefined();
        expect(
          parse({ ...STORED, ...over, integrations: [{ nope: 1 }] }),
          JSON.stringify(over),
        ).toBeUndefined();
      }
    });
  });
});

describe('[C1] what the save validator refuses', () => {
  const REFUSALS: {
    name: string;
    e: PromptStepValidationInput;
    c: PromptStepValidationContext;
    names: string[];
  }[] = [
    {
      name: 'more than eight requirements',
      e: entry(NINE),
      c: ctxOf(),
      names: [],
    },
    {
      name: 'a requirement that pins a provider',
      e: entry([{ id: 'gh', provider: 'github', access: 'read' }]),
      c: ctxOf(),
      names: ['gh', 'github'],
    },
    {
      name: 'two requirements of one category',
      e: entry([req('first', 'issues'), req('second', 'issues', 'write')]),
      c: ctxOf(),
      names: ['issues', 'second'],
    },
    {
      name: 'an id that breaks the grammar',
      e: entry([req('1st', 'forge')]),
      c: ctxOf(),
      names: ['1st'],
    },
    {
      name: 'a category the context does not list',
      e: entry([req('talk', 'chat')]),
      c: ctxOf({ integrationCategoryIds: new Set(['forge', 'issues']) }),
      names: ['talk', 'chat'],
    },
    {
      name: 'forge on a type with no repository',
      e: entry([req('prs', 'forge')]),
      c: ctxOf({ requiresRepository: false }),
      names: ['prs', 'forge'],
    },
  ];

  it.each(REFUSALS)('[C1] refuses $name with a kind of its own', ({ e, c }) => {
    const raised = [...new Set(kindsOf(e, c))];

    expect(raised, 'the kinds raised').toHaveLength(1);
    expect(KINDS_BEFORE_J6A.has(raised[0]!), `${raised[0]} is a kind that already existed`).toBe(
      false,
    );
    expect(PROMPT_STEP_PROBLEM_KINDS as readonly string[]).toContain(raised[0]);
  });

  it('[C1] gives the six refusals six different kinds', () => {
    const raised = REFUSALS.map(({ e, c }) => [...new Set(kindsOf(e, c))].join('|'));

    expect(
      raised.every((kind) => kind !== ''),
      'a refusal raised no problem',
    ).toBe(true);
    expect(new Set(raised).size, 'different kinds among the six refusals').toBe(6);
  });

  it.each(REFUSALS.filter(({ names }) => names.length > 0))(
    '[C1+] names what the refusal of $name is about',
    ({ e, c, names }) => {
      const found = problemsOf(e, c);

      expect(found.length, 'problems the validator raised').toBeGreaterThan(0);
      const text = found.map((p) => `${p.raw} ${p.message}`).join('\n');
      expect(
        names.some((name) => text.includes(name)),
        `none of ${names} in: ${text}`,
      ).toBe(true);
    },
  );

  it.each([
    ['a digit first', '1st'],
    ['a hyphen first', '-lead'],
    ['seventeen characters', 'a'.repeat(17)],
  ])('[C1] refuses an id with %s, in the one kind of its grammar', (_label, id) => {
    const expected = [...new Set(kindsOf(entry([req('1st', 'forge')])))];

    expect(expected).toHaveLength(1);
    expect([...new Set(kindsOf(entry([req(id, 'forge')])))]).toEqual(expected);
  });

  it('[C1] refuses nine and accepts eight, so the limit is eight', () => {
    expect(kindsOf(readBack(EIGHT))).toEqual([]);
    expect(kindsOf(entry(NINE)).length).toBeGreaterThan(0);
  });

  it('[C1] accepts a valid declaration', () => {
    expect(problemsOf(readBack([FORGE, TRACKER]))).toEqual([]);
  });

  it('[C1] accepts an id of one character and an id of sixteen', () => {
    expect(problemsOf(readBack([req('a', 'forge'), req('a'.repeat(16), 'issues')]))).toEqual([]);
    expect(problemsOf(readBack([req('a-1-b', 'forge')]))).toEqual([]);
  });

  it('[C1] takes any category of the right grammar while the context lists none', () => {
    const declared = readBack([req('x', 'module.demo.extra')]);

    expect(problemsOf(declared, ctxOf())).toEqual([]);
    expect(
      kindsOf(declared, ctxOf({ integrationCategoryIds: new Set(['forge']) })),
      'problems for a category the context does not list',
    ).toHaveLength(1);
    expect(
      problemsOf(declared, ctxOf({ integrationCategoryIds: new Set(['module.demo.extra']) })),
    ).toEqual([]);
  });

  it('[C1] takes a listed category, and every category it lists', () => {
    const ids = new Set(CORE_CATEGORIES);

    expect(problemsOf(readBack(EIGHT), ctxOf({ integrationCategoryIds: ids }))).toEqual([]);
    expect(
      problemsOf(
        readBack([req('prs', 'forge')]),
        ctxOf({ integrationCategoryIds: new Set(['forge']) }),
      ),
    ).toEqual([]);
  });

  it('[C1] takes forge on a type with a repository, and every other category on a type without', () => {
    expect(problemsOf(readBack([FORGE]), ctxOf({ requiresRepository: true }))).toEqual([]);
    const others = CORE_CATEGORIES.filter((category) => category !== 'forge').map((category, i) =>
      req(`o${i}`, category),
    );
    expect(problemsOf(readBack(others), ctxOf({ requiresRepository: false }))).toEqual([]);
  });

  it('[C1+] judges the requirements next to the template, neither hiding the other', () => {
    const found = new Set(
      kindsOf(entry([req('first', 'issues'), req('second', 'issues')], { template: '{{nope}}' })),
    );

    expect(found.has('unknown-token')).toBe(true);
    expect([...found].filter((kind) => !KINDS_BEFORE_J6A.has(kind))).toHaveLength(1);
  });

  it('[C1+] raises one problem for each requirement a stored step could not keep, naming it', () => {
    const found = problemsOf(entry(undefined, { invalidIntegrations: ['broken'] }));

    expect(found).toHaveLength(1);
    expect(KINDS_BEFORE_J6A.has(found[0]!.kind), 'a kind that already existed').toBe(false);
    expect(PROMPT_STEP_PROBLEM_KINDS as readonly string[]).toContain(found[0]!.kind);
    expect(`${found[0]!.raw} ${found[0]!.message}`).toContain('broken');
    expect(problemsOf(entry(undefined, { invalidIntegrations: [] }))).toEqual([]);
  });

  it('[C1+] a declaration it accepts derives a composable entry that carries it and is itself valid', () => {
    const duplicateId = [req('x', 'forge'), req('x', 'issues')];
    const declarations = [[FORGE, TRACKER], EIGHT, duplicateId];

    for (const requirements of declarations) {
      const accepted = kindsOf(entry(requirements)).length === 0;
      const derived = derivePromptStepComposable(
        { slug: 'check', title: 'Check', capabilities: [], integrations: requirements } as never,
        'audit',
        true,
      ) as { integrations?: Requirement[] };
      const ids = JSON.stringify(requirements.map((r) => r.id));

      if (accepted) {
        expect(derived.integrations, `the entry derived from ${ids} lost them`).toEqual(
          requirements,
        );
        expect(
          composableStepEntrySchema.safeParse(derived).success,
          `the validator accepted ${ids} and the entry derived from it breaks the composable schema`,
        ).toBe(true);
      }
    }
  });
});

describe('[C1] a draft', () => {
  it('[C0] still cannot carry integrations: the key is dropped like the other keys the editor cannot show', () => {
    const draft = {
      slug: 'audit',
      displayName: 'Audit',
      requiresRepository: true,
      stepIds: ['custom.audit.check'],
      promptSteps: { check: { ...STORED, capabilities: [], integrations: [FORGE] } },
    };

    const { draft: kept, dropped } = pickTaskTypeDraft(draft);

    expect(dropped).toContain('promptSteps.check.integrations');
    expect(JSON.stringify(kept)).not.toContain('integrations');
  });
});

describe('[C1] the composable entry derived from a prompt step', () => {
  const declared = {
    slug: 'check',
    title: 'Check',
    capabilities: [] as string[],
    integrations: [FORGE, TRACKER],
  };

  it('[C1] carries the declared integrations, in order, and is a valid composable entry', () => {
    const derived = derivePromptStepComposable(declared as never, 'audit', true) as {
      integrations?: Requirement[];
    };

    expect(derived.integrations).toEqual([FORGE, TRACKER]);
    expect(composableStepEntrySchema.safeParse(derived).success).toBe(true);
  });

  it('[C1] carries them whatever else the step does', () => {
    const writing = derivePromptStepComposable(
      { ...declared, capabilities: ['file_write', 'tool_use'] } as never,
      'audit',
      true,
    ) as { integrations?: Requirement[] };

    expect(writing.integrations).toEqual([FORGE, TRACKER]);
  });

  it('[C1+] reaches the catalog a type is composed and created from', () => {
    const catalog = {
      stepIds: new Set<string>(),
      dispatchesCli: new Set<string>(),
      composable: new Map(),
    };

    const merged = mergePromptStepCatalog(catalog, {
      slug: 'audit',
      source: 'admin',
      requiresRepository: true,
      promptSteps: { check: { ...STORED, integrations: [FORGE, TRACKER] } },
    });

    const derived = merged.composable.get('custom.audit.check') as
      { integrations?: Requirement[] } | undefined;
    expect(derived?.integrations).toEqual([FORGE, TRACKER]);
  });

  it('[C0] declares none for a step that declares none', () => {
    const derived = derivePromptStepComposable(
      { slug: 'check', title: 'Check', capabilities: [] },
      'audit',
      true,
    ) as { integrations?: Requirement[] };

    expect(derived.integrations ?? []).toEqual([]);
  });
});
