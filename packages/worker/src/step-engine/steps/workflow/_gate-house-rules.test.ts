import { describe, expect, it } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { houseRuleShortIds, type HouseRulesStamp } from '@haive/shared/global-kb';
import {
  givenRuleIds,
  houseRulesHoldApprove,
  houseRulesRow,
  loadGateHouseRules,
  loadInvocationStamp,
  normalizeRuleRef,
  parseRuleConflicts,
  parseRuleRef,
  raiseRuleViolations,
  type GateHouseRules,
} from './_gate-house-rules.js';

const TASK = 'aaaaaaaa-0000-4000-8000-000000000001';
const VALIDATOR = 'bbbbbbbb-0000-4000-8000-000000000001';
const OTHER = 'bbbbbbbb-0000-4000-8000-000000000002';
const HASH = `hr1:${'a'.repeat(64)}`;
const RULE_A = '42ac658a-3c1d-4e5f-8a9b-0c1d2e3f4a5b';
const RULE_B = '9d1f0b7c-5e6f-4a7b-9c8d-1e2f3a4b5c6d';
const RULE_C = '7be19d02-1a2b-4c3d-8e4f-5a6b7c8d9e0f';
const TWIN_1 = '77aa11bb-1111-4111-8111-111111111111';
const TWIN_2 = '77aa11bb-2222-4222-8222-222222222222';

const entry = (id: string, title: string, why: HouseRulesStamp['entries'][number]['why']) => ({
  id,
  hash: HASH,
  title,
  why,
});
const ALWAYS = { scope: 'always' } as const;
const omittedRule = (id: string, title: string, why: 'budget' | 'refused') => ({
  id,
  hash: HASH,
  title,
  why,
});
const stamp = (over: Partial<HouseRulesStamp> = {}): HouseRulesStamp => ({
  mode: 'review',
  entries: [],
  omitted: [],
  ...over,
});

describe('normalizeRuleRef', () => {
  it('trims, lowercases and drops a leading "rule "', () => {
    expect(normalizeRuleRef('42ac658a')).toBe('42ac658a');
    expect(normalizeRuleRef('  42AC658A\n')).toBe('42ac658a');
    expect(normalizeRuleRef('Rule 42AC658A')).toBe('42ac658a');
    expect(normalizeRuleRef('  RULE 42ac658a ')).toBe('42ac658a');
  });

  it('leaves a "rule" that is not a leading word followed by a space', () => {
    expect(normalizeRuleRef('rule')).toBe('rule');
    expect(normalizeRuleRef('ruler 42ac658a')).toBe('ruler 42ac658a');
    expect(normalizeRuleRef('see rule 42ac658a')).toBe('see rule 42ac658a');
    expect(normalizeRuleRef('rule rule 42ac658a')).toBe('rule 42ac658a');
  });
});

describe('parseRuleRef', () => {
  it('keeps a string trimmed and at most 64 characters', () => {
    expect(parseRuleRef('42ac658a')).toBe('42ac658a');
    expect(parseRuleRef('  42ac658a \n')).toBe('42ac658a');
    expect(parseRuleRef('x'.repeat(64))).toBe('x'.repeat(64));
    expect(parseRuleRef('x'.repeat(65))).toBe('x'.repeat(64));
  });

  it('cuts between characters, never through one', () => {
    const smile = String.fromCodePoint(0x1f600);
    const cut = parseRuleRef(`${'x'.repeat(63)}${smile}y`);
    expect(cut).toBe(`${'x'.repeat(63)}${smile}`);
    expect(cut!.isWellFormed()).toBe(true);
  });

  it.each([
    [7],
    [null],
    [undefined],
    [true],
    [{ id: '42ac658a' }],
    [['42ac658a']],
    [''],
    ['  \n '],
  ])('drops %j', (value) => {
    expect(parseRuleRef(value)).toBeUndefined();
  });
});

describe('parseRuleConflicts', () => {
  const conflict = { rule: '42ac658a', file: 'src/a.php:7', reason: 'the spec requires it' };

  it('keeps well-formed items as {rule, file, reason}', () => {
    expect(parseRuleConflicts([conflict, { rule: 'rule b', reason: 'no file here' }])).toEqual([
      conflict,
      { rule: 'rule b', reason: 'no file here' },
    ]);
  });

  it.each([
    ['a string', 'none'],
    ['an object', conflict],
    [null, null],
    [undefined, undefined],
    [7, 7],
  ])('reads %s as no conflicts', (_name, value) => {
    expect(parseRuleConflicts(value)).toEqual([]);
  });

  it('drops an item without a non-empty rule and reason, and keeps the rest', () => {
    expect(
      parseRuleConflicts([
        { rule: '42ac658a' },
        { reason: 'no rule' },
        { rule: '', reason: 'empty rule' },
        { rule: '42ac658a', reason: '   ' },
        { rule: 7, reason: 'numeric rule' },
        { rule: '42ac658a', reason: 7 },
        7,
        null,
        'text',
        conflict,
      ]),
    ).toEqual([conflict]);
  });

  it('reads the location from path when the item has no file, and stores it as file', () => {
    expect(
      parseRuleConflicts([
        { rule: '42ac658a', path: 'src/a.php:7', reason: 'the spec requires it' },
        { rule: '42ac658a', file: 'src/b.php:1', path: 'src/c.php:2', reason: 'file wins' },
        { rule: '42ac658a', file: 7, path: 'src/d.php:3\nsrc/e.php:4', reason: 'path on one line' },
        { rule: '42ac658a', file: '  ', path: 7, reason: 'neither is usable' },
      ]),
    ).toEqual([
      { rule: '42ac658a', file: 'src/a.php:7', reason: 'the spec requires it' },
      { rule: '42ac658a', file: 'src/b.php:1', reason: 'file wins' },
      { rule: '42ac658a', file: 'src/d.php:3 src/e.php:4', reason: 'path on one line' },
      { rule: '42ac658a', reason: 'neither is usable' },
    ]);
  });

  it('drops a file that is not a string, and keeps the item', () => {
    expect(
      parseRuleConflicts([
        { ...conflict, file: 7 },
        { ...conflict, file: '  ' },
      ]),
    ).toEqual([
      { rule: conflict.rule, reason: conflict.reason },
      { rule: conflict.rule, reason: conflict.reason },
    ]);
  });

  it('collapses the reason to one line of at most 500 characters', () => {
    const [kept] = parseRuleConflicts([
      { ...conflict, reason: `first\nsecond\u2028third ${'y'.repeat(600)}` },
    ]);
    expect(kept!.reason).not.toMatch(/[\n\u2028]/);
    expect(kept!.reason.startsWith('first second third y')).toBe(true);
    expect(kept!.reason).toHaveLength(500);
  });

  it('keeps the rule trimmed and at most 64 characters, and the file on one line', () => {
    const [kept] = parseRuleConflicts([
      { rule: `  ${'r'.repeat(80)}  `, file: 'src/a.php:1\nsrc/b.php:2', reason: 'x' },
    ]);
    expect(kept!.rule).toBe('r'.repeat(64));
    expect(kept!.file).toBe('src/a.php:1 src/b.php:2');
  });

  it('keeps the first 20 well-formed items, however many follow and wherever the bad ones sit', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ rule: `r${i}`, reason: `why ${i}` }));
    const kept = parseRuleConflicts([{ rule: 'bad' }, ...many]);
    expect(kept).toHaveLength(20);
    expect(kept[0]!.rule).toBe('r0');
    expect(kept[19]!.rule).toBe('r19');
  });
});

/** Seeds the two tables the loader reads, through a db that evaluates `where`. */
function world() {
  const fake = createFakeDb({
    taskSteps: schema.taskSteps,
    cliInvocations: schema.cliInvocations,
  });
  const db = fake.db as unknown as Database;
  const step07b = (output: unknown, round = 0) =>
    fake.insert(schema.taskSteps, { taskId: TASK, stepId: '07b-phase-4-validate', round, output });
  const step08c = (output: unknown, round = 0) =>
    fake.insert(schema.taskSteps, { taskId: TASK, stepId: '08c-code-review', round, output });
  const invocation = (
    id: string,
    houseRules: unknown,
    over: Record<string, unknown> = {},
  ): void => {
    fake.insert(schema.cliInvocations, { id, taskId: TASK, houseRules, ...over });
  };
  return { fake, db, step07b, step08c, invocation };
}

const validatorOutput = (over: Record<string, unknown> = {}) => ({
  verdict: 'ISSUES_FOUND',
  issues: [],
  ruleConflicts: [],
  validatorInvocationId: VALIDATOR,
  ...over,
});

const violation = (rule: unknown, over: Record<string, unknown> = {}) => ({
  severity: 'high',
  file: 'templates/node.tpl.php:12',
  description: 'inline svg in a template',
  rule,
  ...over,
});

describe('loadInvocationStamp', () => {
  it('reads the stamp of the one invocation it is asked for', async () => {
    const w = world();
    w.invocation(OTHER, stamp({ entries: [entry(RULE_B, 'Other', ALWAYS)] }));
    w.invocation(VALIDATOR, stamp({ entries: [entry(RULE_A, 'Mine', ALWAYS)] }));
    expect((await loadInvocationStamp(w.db, VALIDATOR))?.entries.map((e) => e.id)).toEqual([
      RULE_A,
    ]);
  });

  it.each([
    ['an invocation that does not exist', 'cccccccc-0000-4000-8000-000000000009', undefined],
    ['a NULL stamp', VALIDATOR, null],
    ['a stamp that is not one', VALIDATOR, { mode: 'bogus', entries: 'x' }],
  ])('answers null for %s', async (_name, id, stored) => {
    const w = world();
    if (stored !== undefined) w.invocation(VALIDATOR, stored);
    expect(await loadInvocationStamp(w.db, id)).toBeNull();
  });
});

describe('loadGateHouseRules', () => {
  const entries = [
    entry(RULE_A, 'No inline SVGs', ALWAYS),
    entry(RULE_B, 'Templates stay thin', { scope: 'files', glob: '**/*.tpl.php' }),
  ];
  const shortA = houseRuleShortIds([RULE_A, RULE_B]).get(RULE_A)!;
  const shortB = houseRuleShortIds([RULE_A, RULE_B]).get(RULE_B)!;

  it('answers null when 07b has no output', async () => {
    const w = world();
    expect(await loadGateHouseRules(w.db, TASK)).toBeNull();
    w.step07b(null);
    expect(await loadGateHouseRules(w.db, TASK)).toBeNull();
  });

  const oldOutput = (): Record<string, unknown> => {
    const { validatorInvocationId: _id, ...old } = validatorOutput({ issues: [violation(shortA)] });
    return old;
  };

  it.each([
    ['carries no validatorInvocationId (an output written before it existed)', oldOutput()],
    [
      'names no invocation',
      validatorOutput({ validatorInvocationId: null, issues: [violation(shortA)] }),
    ],
    [
      'names an invocation that does not exist',
      validatorOutput({ validatorInvocationId: OTHER, issues: [violation(shortA)] }),
    ],
  ])('answers null when 07b %s, whatever else sits on the step', async (_name, output) => {
    const w = world();
    w.step07b(output);
    w.invocation(VALIDATOR, stamp({ entries }));
    expect(await loadGateHouseRules(w.db, TASK)).toBeNull();
  });

  it.each([
    ['a NULL stamp', null],
    ['a stamp that does not parse', { mode: 'bogus', entries: 'x' }],
  ])('answers null for %s', async (_name, stored) => {
    const w = world();
    w.step07b(validatorOutput());
    w.invocation(VALIDATOR, stored);
    expect(await loadGateHouseRules(w.db, TASK)).toBeNull();
  });

  it('carries the stamp as it was, with a short id and the title for each entry', async () => {
    const w = world();
    w.step07b(validatorOutput());
    w.invocation(
      VALIDATOR,
      stamp({
        entries: [...entries, entry(RULE_C, 'Unmeasured', { scope: 'files', glob: null })],
        omitted: [
          omittedRule(TWIN_1, 'Did not fit', 'budget'),
          omittedRule(TWIN_2, 'Refused text', 'refused'),
        ],
        reason: 'unavailable',
        errorClass: 'timeout',
      }),
    );
    const shorts = houseRuleShortIds([RULE_A, RULE_B, RULE_C]);
    expect(await loadGateHouseRules(w.db, TASK)).toEqual({
      mode: 'review',
      reason: 'unavailable',
      errorClass: 'timeout',
      entries: [
        { shortId: shorts.get(RULE_A), title: 'No inline SVGs', why: ALWAYS },
        {
          shortId: shorts.get(RULE_B),
          title: 'Templates stay thin',
          why: { scope: 'files', glob: '**/*.tpl.php' },
        },
        {
          shortId: shorts.get(RULE_C),
          title: 'Unmeasured',
          why: { scope: 'files', glob: null },
        },
      ],
      omitted: [
        { title: 'Did not fit', why: 'budget' },
        { title: 'Refused text', why: 'refused' },
      ],
      violations: [],
      conflicts: [],
    });
  });

  it('leaves out a reason and an error class the stamp does not have', async () => {
    const w = world();
    w.step07b(validatorOutput());
    w.invocation(VALIDATOR, stamp({ entries }));
    const loaded = await loadGateHouseRules(w.db, TASK);
    expect(loaded).not.toBeNull();
    expect('reason' in loaded!).toBe(false);
    expect('errorClass' in loaded!).toBe(false);
  });

  it('lists the issues whose rule names an entry, however the model wrote the reference', async () => {
    const w = world();
    w.step07b(
      validatorOutput({
        issues: [
          violation(shortA),
          violation(`  RULE ${shortB.toUpperCase()} `, {
            file: 'src/b.php:3',
            description: 'logic',
          }),
          violation('deadbeef', { file: 'src/c.php:1' }),
          violation(undefined, { file: 'src/d.php:1' }),
          violation(7, { file: 'src/e.php:1' }),
        ],
      }),
    );
    w.invocation(VALIDATOR, stamp({ entries }));
    expect((await loadGateHouseRules(w.db, TASK))!.violations).toEqual([
      {
        shortId: shortA,
        title: 'No inline SVGs',
        file: 'templates/node.tpl.php:12',
        description: 'inline svg in a template',
      },
      { shortId: shortB, title: 'Templates stay thin', file: 'src/b.php:3', description: 'logic' },
    ]);
  });

  it('names an entry by the short id houseRuleShortIds gives, not by the 8 digits ids share', async () => {
    const w = world();
    const shorts = houseRuleShortIds([TWIN_1, TWIN_2]);
    expect(shorts.get(TWIN_1)!.length).toBeGreaterThan(8);
    w.step07b(
      validatorOutput({
        issues: [
          violation('77aa11bb', { file: 'src/prefix.php:1' }),
          violation(shorts.get(TWIN_1), { file: 'src/twin.php:1' }),
        ],
      }),
    );
    w.invocation(
      VALIDATOR,
      stamp({ entries: [entry(TWIN_1, 'Twin one', ALWAYS), entry(TWIN_2, 'Twin two', ALWAYS)] }),
    );
    const loaded = await loadGateHouseRules(w.db, TASK);
    expect(loaded!.violations.map((v) => [v.shortId, v.file])).toEqual([
      [shorts.get(TWIN_1), 'src/twin.php:1'],
    ]);
  });

  it('does not count a rule the stamp lists as omitted', async () => {
    const w = world();
    w.step07b(validatorOutput({ issues: [violation('9d1f0b7c')] }));
    w.invocation(
      VALIDATOR,
      stamp({
        entries: [entries[0]!],
        omitted: [omittedRule(RULE_B, 'Templates stay thin', 'budget')],
      }),
    );
    expect((await loadGateHouseRules(w.db, TASK))!.violations).toEqual([]);
  });

  it('carries the conflicts 07b stored, re-read as bounded one-line text', async () => {
    const w = world();
    w.step07b(
      validatorOutput({
        ruleConflicts: [
          { rule: shortA, file: 'src/a.php:7', reason: 'line one\nline two' },
          { rule: shortA },
          'junk',
        ],
      }),
    );
    w.invocation(VALIDATOR, stamp({ entries }));
    expect((await loadGateHouseRules(w.db, TASK))!.conflicts).toEqual([
      { rule: shortA, file: 'src/a.php:7', reason: 'line one line two' },
    ]);
  });

  it('carries the count of changed files the validator was given, as 07b stored it', async () => {
    const w = world();
    w.step07b(validatorOutput({ changedFilesCoverage: { listed: 100, total: 150 } }));
    w.invocation(VALIDATOR, stamp({ entries }));
    expect((await loadGateHouseRules(w.db, TASK))!.changedFilesCoverage).toEqual({
      listed: 100,
      total: 150,
    });
  });

  it('leaves the coverage out for an output written before 07b recorded it', async () => {
    const w = world();
    w.step07b(validatorOutput());
    w.invocation(VALIDATOR, stamp({ entries }));
    const loaded = await loadGateHouseRules(w.db, TASK);
    expect(loaded).not.toBeNull();
    expect('changedFilesCoverage' in loaded!).toBe(false);
  });

  it.each([
    ['a string', 'all of them'],
    ['an array', [100, 150]],
    ['no total', { listed: 100 }],
    ['no listed', { total: 150 }],
    ['counts written as text', { listed: '100', total: '150' }],
    ['null', null],
  ])('reads %s as no coverage and keeps the rest of the stamp', async (_name, stored) => {
    const w = world();
    w.step07b(validatorOutput({ changedFilesCoverage: stored }));
    w.invocation(VALIDATOR, stamp({ entries }));
    const loaded = await loadGateHouseRules(w.db, TASK);
    expect(loaded!.entries).toHaveLength(2);
    expect('changedFilesCoverage' in loaded!).toBe(false);
  });

  it('keeps a violation on one bounded line', async () => {
    const w = world();
    w.step07b(
      validatorOutput({
        issues: [
          violation(shortA, {
            file: 'a.php:1\n## injected',
            description: `one\ntwo ${'d'.repeat(700)}`,
          }),
        ],
      }),
    );
    w.invocation(VALIDATOR, stamp({ entries }));
    const [v] = (await loadGateHouseRules(w.db, TASK))!.violations;
    expect(v!.file).toBe('a.php:1 ## injected');
    expect(v!.description).not.toContain('\n');
    expect(v!.description).toHaveLength(500);
  });

  it('finds the invocation by the id 07b names and by nothing else', async () => {
    const w = world();
    w.step07b(validatorOutput());
    w.invocation(VALIDATOR, stamp({ entries }), {
      agentTitle: 'Validator',
      statusMessage: 'Validator',
    });
    const before = await loadGateHouseRules(w.db, TASK);
    expect(before!.entries).toHaveLength(2);

    w.fake.patch(schema.cliInvocations, VALIDATOR, {
      agentTitle: 'Fixer',
      statusMessage: 'queued: waiting for a free runtime slot',
    });
    expect(await loadGateHouseRules(w.db, TASK)).toEqual(before);

    w.invocation(OTHER, stamp({ reason: 'unavailable', errorClass: 'timeout' }), {
      agentTitle: 'Validator',
      statusMessage: 'Validator',
    });
    w.invocation('bbbbbbbb-0000-4000-8000-000000000003', stamp({ mode: 'write', entries }), {
      agentTitle: 'Fixer',
    });
    expect(await loadGateHouseRules(w.db, TASK)).toEqual(before);
  });

  it('reads the latest round of 07b', async () => {
    const w = world();
    w.step07b(validatorOutput({ validatorInvocationId: OTHER }), 0);
    w.step07b(validatorOutput({ validatorInvocationId: VALIDATOR }), 1);
    w.invocation(VALIDATOR, stamp({ entries: [entries[0]!] }));
    w.invocation(OTHER, stamp({ entries, omitted: [omittedRule(RULE_C, 'Late', 'budget')] }));
    expect((await loadGateHouseRules(w.db, TASK))!.entries).toHaveLength(1);
  });
});

describe('loadGateHouseRules: the code review as the later check', () => {
  const PEER = 'cccccccc-0000-4000-8000-000000000001';
  const entryA = entry(RULE_A, 'No inline SVGs', ALWAYS);
  const entryB = entry(RULE_B, 'Templates stay thin', { scope: 'files', glob: '**/*.tpl.php' });
  const entryC = entry(RULE_C, 'Stylesheets stay in files', ALWAYS);
  const shortA = houseRuleShortIds([RULE_A]).get(RULE_A)!;
  const shortC = houseRuleShortIds([RULE_C]).get(RULE_C)!;
  const withCodeReview = { withCodeReview: true };

  const reviewOutput = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    reviewed: true,
    peer: { verdict: 'REQUEST_CHANGES', findings: [], positives: [] },
    coverage: { listed: 2, total: 2, truncated: false },
    ruleConflicts: [],
    peerInvocationId: PEER,
    ...over,
  });
  const peerFinding = (rule: unknown, over: Record<string, unknown> = {}) => ({
    severity: 'high',
    path: 'src/a.php',
    lines: '3-3',
    issue: 'logic in a template',
    rule,
    ...over,
  });
  const peerWith = (...findings: unknown[]) => ({
    verdict: 'REQUEST_CHANGES',
    findings,
    positives: [],
  });

  /** 07b checked rules A and B; the code review checked C. */
  function seeded(
    over: { validator?: Record<string, unknown>; review?: Record<string, unknown> | null } = {},
  ) {
    const w = world();
    w.step07b(validatorOutput(over.validator));
    w.invocation(VALIDATOR, stamp({ entries: [entryA, entryB] }));
    if (over.review !== null) w.step08c(reviewOutput(over.review));
    w.invocation(PEER, stamp({ entries: [entryC] }));
    return w;
  }

  it('is the 07b row when no code review output exists, with or without asking for it', async () => {
    const w = seeded({ review: null });
    const alone = await loadGateHouseRules(w.db, TASK);
    expect(alone!.entries).toHaveLength(2);
    expect(await loadGateHouseRules(w.db, TASK, withCodeReview)).toEqual(alone);
  });

  it.each([
    [
      'carries no peerInvocationId (an output written before it existed)',
      { peerInvocationId: undefined },
    ],
    ['names no invocation', { peerInvocationId: null }],
    ['names an empty id', { peerInvocationId: '' }],
    ['names an id that is not text', { peerInvocationId: 7 }],
    ['names an invocation that does not exist', { peerInvocationId: OTHER }],
  ])('is the 07b row when the code review output %s', async (_name, over) => {
    const w = seeded({
      validator: { issues: [violation(shortA)] },
      review: { peer: peerWith(peerFinding(shortC)), ...over },
    });
    const alone = await loadGateHouseRules(w.db, TASK);
    expect(await loadGateHouseRules(w.db, TASK, withCodeReview)).toEqual(alone);
  });

  it.each([
    ['a NULL stamp', null],
    ['a stamp that does not parse', { mode: 'bogus', entries: 'x' }],
  ])('is the 07b row when the peer invocation holds %s', async (_name, stored) => {
    const w = world();
    w.step07b(validatorOutput({ issues: [violation(shortA)] }));
    w.invocation(VALIDATOR, stamp({ entries: [entryA, entryB] }));
    w.step08c(reviewOutput({ peer: peerWith(peerFinding(shortC)) }));
    w.invocation(PEER, stored);
    const alone = await loadGateHouseRules(w.db, TASK);
    expect(await loadGateHouseRules(w.db, TASK, withCodeReview)).toEqual(alone);
  });

  it('leaves gate 3 on 07b alone: the default reads no code review output', async () => {
    const w = seeded({
      review: {
        peer: peerWith(peerFinding(shortC)),
        ruleConflicts: [{ rule: shortC, reason: 'a person asked for it' }],
      },
    });
    const loaded = await loadGateHouseRules(w.db, TASK);
    expect(loaded!.entries.map((e) => e.title)).toEqual(['No inline SVGs', 'Templates stay thin']);
    expect(loaded!.violations).toEqual([]);
    expect(loaded!.conflicts).toEqual([]);
  });

  it('takes mode, reason, entries and omitted from the code review, the later check', async () => {
    const w = world();
    w.step07b(validatorOutput());
    w.invocation(
      VALIDATOR,
      stamp({ entries: [entryA, entryB], omitted: [omittedRule(RULE_C, 'Early', 'budget')] }),
    );
    w.step08c(reviewOutput());
    w.invocation(
      PEER,
      stamp({
        entries: [entryC],
        omitted: [omittedRule(TWIN_1, 'Late', 'refused')],
        reason: 'unavailable',
        errorClass: 'timeout',
      }),
    );
    expect(await loadGateHouseRules(w.db, TASK, withCodeReview)).toEqual({
      mode: 'review',
      reason: 'unavailable',
      errorClass: 'timeout',
      entries: [{ shortId: shortC, title: 'Stylesheets stay in files', why: ALWAYS }],
      omitted: [{ title: 'Late', why: 'refused' }],
      violations: [],
      conflicts: [],
      changedFilesCoverage: { listed: 2, total: 2 },
    });
  });

  it('leaves a reason and an error class the code review stamp does not have out, whatever 07b had', async () => {
    const w = world();
    w.step07b(validatorOutput());
    w.invocation(VALIDATOR, stamp({ reason: 'unavailable', errorClass: 'timeout' }));
    w.step08c(reviewOutput());
    w.invocation(PEER, stamp({ entries: [entryC] }));
    const loaded = await loadGateHouseRules(w.db, TASK, withCodeReview);
    expect('reason' in loaded!).toBe(false);
    expect('errorClass' in loaded!).toBe(false);
    expect(loaded!.entries).toHaveLength(1);
  });

  it("takes the coverage of the code review's own record, else 07b's", async () => {
    const own = seeded({
      validator: { changedFilesCoverage: { listed: 100, total: 150 } },
      review: { coverage: { listed: 10, total: 10, truncated: false } },
    });
    expect((await loadGateHouseRules(own.db, TASK, withCodeReview))!.changedFilesCoverage).toEqual({
      listed: 10,
      total: 10,
    });
    for (const coverage of [null, undefined, 'all of it', { listed: 3 }]) {
      const w = seeded({
        validator: { changedFilesCoverage: { listed: 100, total: 150 } },
        review: { coverage },
      });
      expect((await loadGateHouseRules(w.db, TASK, withCodeReview))!.changedFilesCoverage).toEqual({
        listed: 100,
        total: 150,
      });
    }
    const neither = seeded({ review: { coverage: null } });
    const loaded = await loadGateHouseRules(neither.db, TASK, withCodeReview);
    expect('changedFilesCoverage' in loaded!).toBe(false);
  });

  it("maps each check's violations through that check's own stamp, and lists both", async () => {
    const w = seeded({
      validator: { issues: [violation(shortA)] },
      review: {
        peer: peerWith(
          peerFinding(shortC, { path: 'src/b.php', lines: '5-9', issue: 'stylesheet inlined' }),
        ),
      },
    });
    const loaded = await loadGateHouseRules(w.db, TASK, withCodeReview);
    expect(loaded!.violations).toEqual([
      {
        shortId: shortA,
        title: 'No inline SVGs',
        file: 'templates/node.tpl.php:12',
        description: 'inline svg in a template',
      },
      {
        shortId: shortC,
        title: 'Stylesheets stay in files',
        file: 'src/b.php:5-9',
        description: 'stylesheet inlined',
      },
    ]);
  });

  it('names a code review finding by its path alone when it has no lines', async () => {
    const w = seeded({ review: { peer: peerWith(peerFinding(shortC, { lines: undefined })) } });
    const [v] = (await loadGateHouseRules(w.db, TASK, withCodeReview))!.violations;
    expect(v!.file).toBe('src/a.php');
  });

  it('counts a finding only if it names a rule of the code review own stamp', async () => {
    const w = seeded({
      validator: { issues: [violation(shortC, { file: 'src/c.php:1' })] },
      review: {
        peer: peerWith(
          peerFinding(shortA, { issue: 'names a rule only 07b was given' }),
          peerFinding('deadbeef', { issue: 'names no rule at all' }),
          peerFinding(undefined, { issue: 'names nothing' }),
          peerFinding(7, { issue: 'names a number' }),
          peerFinding(`  RULE ${shortC.toUpperCase()} `, { issue: 'names it loosely' }),
        ),
      },
    });
    const loaded = await loadGateHouseRules(w.db, TASK, withCodeReview);
    expect(loaded!.violations.map((v) => v.description)).toEqual(['names it loosely']);
  });

  it('names an entry by the short id houseRuleShortIds gives, not by the 8 digits ids share', async () => {
    const shorts = houseRuleShortIds([TWIN_1, TWIN_2]);
    const w = world();
    w.step07b(validatorOutput());
    w.invocation(VALIDATOR, stamp({ entries: [entryA] }));
    w.step08c(
      reviewOutput({
        peer: peerWith(
          peerFinding('77aa11bb', { issue: 'prefix' }),
          peerFinding(shorts.get(TWIN_1), { issue: 'twin' }),
        ),
      }),
    );
    w.invocation(
      PEER,
      stamp({ entries: [entry(TWIN_1, 'Twin one', ALWAYS), entry(TWIN_2, 'Twin two', ALWAYS)] }),
    );
    const loaded = await loadGateHouseRules(w.db, TASK, withCodeReview);
    expect(loaded!.violations.map((v) => v.description)).toEqual(['twin']);
  });

  it("lists both checks' conflicts, 07b's first, each as bounded one-line text", async () => {
    const w = seeded({
      validator: { ruleConflicts: [{ rule: shortA, file: 'src/a.php:7', reason: 'spec says so' }] },
      review: {
        ruleConflicts: [
          { rule: shortC, file: 'src/b.php:9', reason: 'line one\nline two' },
          { rule: shortC },
          'junk',
        ],
      },
    });
    expect((await loadGateHouseRules(w.db, TASK, withCodeReview))!.conflicts).toEqual([
      { rule: shortA, file: 'src/a.php:7', reason: 'spec says so' },
      { rule: shortC, file: 'src/b.php:9', reason: 'line one line two' },
    ]);
  });

  it('is the code review row alone when 07b names no usable stamp', async () => {
    const w = world();
    w.step07b(validatorOutput({ validatorInvocationId: null }));
    w.step08c(
      reviewOutput({
        peer: peerWith(peerFinding(shortC)),
        ruleConflicts: [{ rule: shortC, reason: 'a person asked for it' }],
      }),
    );
    w.invocation(PEER, stamp({ entries: [entryC] }));
    const loaded = await loadGateHouseRules(w.db, TASK, withCodeReview);
    expect(loaded!.entries.map((e) => e.shortId)).toEqual([shortC]);
    expect(loaded!.violations).toHaveLength(1);
    expect(loaded!.conflicts).toHaveLength(1);
  });

  it('reads the latest round of the code review', async () => {
    const w = world();
    w.step07b(validatorOutput());
    w.invocation(VALIDATOR, stamp({ entries: [entryA] }));
    w.step08c(reviewOutput({ peerInvocationId: OTHER }), 0);
    w.step08c(reviewOutput(), 1);
    w.invocation(OTHER, stamp({ entries: [entryA, entryB] }));
    w.invocation(PEER, stamp({ entries: [entryC] }));
    expect((await loadGateHouseRules(w.db, TASK, withCodeReview))!.entries).toHaveLength(1);
  });

  it('finds the peer invocation by the id the output names and by nothing else', async () => {
    const w = seeded({ review: { peer: peerWith(peerFinding(shortC)) } });
    const before = await loadGateHouseRules(w.db, TASK, withCodeReview);
    w.invocation(OTHER, stamp({ entries: [entryA, entryB], reason: 'unavailable' }), {
      agentTitle: 'Peer Reviewer',
      statusMessage: 'Peer Reviewer',
    });
    expect(await loadGateHouseRules(w.db, TASK, withCodeReview)).toEqual(before);
  });
});

describe('givenRuleIds', () => {
  const entries = [entry(RULE_A, 'No inline SVGs', ALWAYS), entry(RULE_B, 'Templates', ALWAYS)];

  it('is the short ids of the stamp of the invocation it is given', async () => {
    const w = world();
    w.invocation(VALIDATOR, stamp({ entries }));
    w.invocation(OTHER, stamp({ entries: [entry(RULE_C, 'Other', ALWAYS)] }));
    const shorts = houseRuleShortIds([RULE_A, RULE_B]);
    expect(await givenRuleIds(w.db, [{ rule: 'x' }], VALIDATOR)).toEqual(
      new Set([shorts.get(RULE_A), shorts.get(RULE_B)]),
    );
  });

  it('reads no stamp unless an item names a rule', async () => {
    const reads: unknown[] = [];
    const db = new Proxy({} as Database, {
      get: (_target, key) => {
        reads.push(key);
        throw new Error('the store was read');
      },
    });
    expect(await givenRuleIds(db, [{}, { rule: undefined }], VALIDATOR)).toEqual(new Set());
    expect(await givenRuleIds(db, [{ rule: 'x' }], null)).toEqual(new Set());
    expect(await givenRuleIds(db, [{ rule: 'x' }], undefined)).toEqual(new Set());
    expect(reads).toEqual([]);
  });

  it.each([
    ['an invocation that does not exist', OTHER, undefined],
    ['a NULL stamp', VALIDATOR, null],
    ['a stamp that does not parse', VALIDATOR, { mode: 'bogus', entries: 'x' }],
  ])('is empty for %s', async (_name, id, stored) => {
    const w = world();
    if (stored !== undefined) w.invocation(VALIDATOR, stored);
    expect(await givenRuleIds(w.db, [{ rule: 'x' }], id)).toEqual(new Set());
  });
});

describe('raiseRuleViolations', () => {
  const given = new Set(['42ac658a']);
  const item = (severity: string, rule?: string) => ({
    severity: severity as never,
    rule,
    id: severity,
  });

  it('raises what names a given rule below high to high, however the rule is written', () => {
    const out = raiseRuleViolations(
      [
        item('low', '42ac658a'),
        item('medium', ' RULE 42AC658A '),
        item('high', '42ac658a'),
        item('critical', '42ac658a'),
      ],
      given,
    );
    expect(out.items.map((i) => i.severity)).toEqual(['high', 'high', 'high', 'critical']);
    expect(out.raised).toBe(2);
    expect(out.stamped).toBe(4);
  });

  it('leaves what names an unknown rule or none, and does not touch its input', () => {
    const items = [item('low', 'deadbeef'), item('medium'), item('low', '9d1f0b7c')];
    const before = JSON.stringify(items);
    const out = raiseRuleViolations(items, given);
    expect(out.items).toEqual(items);
    expect(out.raised).toBe(0);
    expect(out.stamped).toBe(0);
    expect(JSON.stringify(items)).toBe(before);
  });

  it('raises nothing when the pass was given no rule', () => {
    const out = raiseRuleViolations([item('low', '42ac658a')], new Set());
    expect(out.items.map((i) => i.severity)).toEqual(['low']);
    expect(out.stamped).toBe(0);
  });
});

const rule = (over: Partial<GateHouseRules['entries'][number]> = {}) => ({
  shortId: '42ac658a',
  title: 'No inline SVGs',
  why: ALWAYS,
  ...over,
});
const data = (over: Partial<GateHouseRules> = {}): GateHouseRules => ({
  mode: 'review',
  entries: [],
  omitted: [],
  violations: [],
  conflicts: [],
  ...over,
});
const found = {
  shortId: '42ac658a',
  title: 'No inline SVGs',
  file: 'templates/node.tpl.php:12',
  description: 'inline svg in a template',
};
const conflict = { rule: '42ac658a', file: 'src/a.php:7', reason: 'the spec requires it' };
const left = { title: 'Did not fit', why: 'budget' } as const;
const capped = { listed: 100, total: 150 };

const TABLE = [
  ['a conflict', data({ entries: [rule()], conflicts: [conflict] }), 'warn', 'CONFLICT', true],
  ['a violation', data({ entries: [rule()], violations: [found] }), 'fail', 'VIOLATED', true],
  [
    'a store that could not be read',
    data({ reason: 'unavailable', errorClass: 'timeout' }),
    'warn',
    'NOT CHECKED',
    true,
  ],
  [
    'a prompt that was too large',
    data({ reason: 'too_large', omitted: [left] }),
    'warn',
    'NOT CHECKED',
    true,
  ],
  ['house rules switched off', data({ reason: 'switched_off' }), 'info', 'OFF', false],
  ['a rule left out', data({ entries: [rule()], omitted: [left] }), 'warn', 'PARTIAL', true],
  [
    'a file list capped below the change',
    data({ entries: [rule()], changedFilesCoverage: capped }),
    'warn',
    'PARTIAL',
    true,
  ],
  ['rules checked', data({ entries: [rule()] }), 'pass', 'ENFORCED', false],
  [
    'a file list that covers the change',
    data({ entries: [rule()], changedFilesCoverage: { listed: 100, total: 100 } }),
    'pass',
    'ENFORCED',
    false,
  ],
] as const;

describe('houseRulesRow', () => {
  it.each(TABLE)(
    '%s: status, pill and whether it holds Approve',
    (_name, d, status, label, holds) => {
      const row = houseRulesRow(d)!;
      expect(row.label).toBe('House rules');
      expect(row.status).toBe(status);
      expect(row.statusLabel).toBe(label);
      expect(row.defaultOpen).toBe(status !== 'pass' && status !== 'info');
      expect(houseRulesHoldApprove(d)).toBe(holds);
    },
  );

  it('gives no row, and holds nothing, when there is nothing to say', () => {
    for (const d of [data(), data({ mode: 'write' }), null, undefined]) {
      expect(houseRulesRow(d)).toBeNull();
      expect(houseRulesHoldApprove(d)).toBe(false);
    }
  });

  it('takes the first case that matches', () => {
    const all = data({
      entries: [rule()],
      omitted: [left],
      violations: [found],
      conflicts: [conflict],
      reason: 'unavailable',
    });
    expect(houseRulesRow(all)!.statusLabel).toBe('CONFLICT');
    expect(houseRulesRow({ ...all, conflicts: [] })!.statusLabel).toBe('VIOLATED');
    expect(houseRulesRow({ ...all, conflicts: [], violations: [] })!.statusLabel).toBe(
      'NOT CHECKED',
    );
    expect(
      houseRulesRow({ ...all, conflicts: [], violations: [], reason: 'switched_off' })!.statusLabel,
    ).toBe('OFF');
    expect(
      houseRulesRow({ ...all, conflicts: [], violations: [], reason: undefined })!.statusLabel,
    ).toBe('PARTIAL');
    expect(
      houseRulesRow({ ...all, conflicts: [], violations: [], reason: undefined, omitted: [] })!
        .statusLabel,
    ).toBe('ENFORCED');
  });

  it('ranks a capped file list like a rule left out: below the other states, above ENFORCED', () => {
    const all = data({
      entries: [rule()],
      violations: [found],
      conflicts: [conflict],
      reason: 'unavailable',
      changedFilesCoverage: capped,
    });
    expect(houseRulesRow(all)!.statusLabel).toBe('CONFLICT');
    expect(houseRulesRow({ ...all, conflicts: [] })!.statusLabel).toBe('VIOLATED');
    expect(houseRulesRow({ ...all, conflicts: [], violations: [] })!.statusLabel).toBe(
      'NOT CHECKED',
    );
    expect(
      houseRulesRow({ ...all, conflicts: [], violations: [], reason: 'switched_off' })!.statusLabel,
    ).toBe('OFF');
    const rest = { ...all, conflicts: [], violations: [], reason: undefined };
    expect(houseRulesRow(rest)!.statusLabel).toBe('PARTIAL');
    expect(houseRulesRow({ ...rest, changedFilesCoverage: undefined })!.statusLabel).toBe(
      'ENFORCED',
    );
  });

  it('says how many changed files the validator was given, and lists the rest as not checked', () => {
    const row = houseRulesRow(data({ entries: [rule()], changedFilesCoverage: capped }))!;
    expect(row.detail).toBe('1 rule(s) checked; the validator was given 100 of 150 changed files');
    expect(row.body).toBe(
      [
        '## Checked',
        '- Rule `42ac658a` No inline SVGs — every change',
        '',
        '## Not checked',
        "- 50 changed files beyond the validator's list of 100",
      ].join('\n'),
    );
  });

  it('puts the cap after the rules left out, in the same section and the same detail', () => {
    const row = houseRulesRow(
      data({ entries: [rule()], omitted: [left], changedFilesCoverage: capped }),
    )!;
    expect(row.statusLabel).toBe('PARTIAL');
    expect(row.detail).toBe(
      '1 rule(s) checked; 1 not checked; the validator was given 100 of 150 changed files',
    );
    expect(row.body).toContain(
      [
        '## Not checked',
        '- Rule Did not fit — left out of the prompt: it did not fit the prompt budget',
        "- 50 changed files beyond the validator's list of 100",
      ].join('\n'),
    );
  });

  it('still names the cap beside a conflict and a violation, which keep the row', () => {
    const row = houseRulesRow(
      data({
        entries: [rule()],
        conflicts: [conflict],
        violations: [found],
        changedFilesCoverage: capped,
      }),
    )!;
    expect(row.statusLabel).toBe('CONFLICT');
    expect(row.detail).toBe(
      '1 rule(s) checked; the validator was given 100 of 150 changed files; 1 conflict(s); 1 violation(s) open',
    );
    expect(row.body).toContain(
      "## Not checked\n- 50 changed files beyond the validator's list of 100",
    );
  });

  it('renders exactly as before without the field, and with a list that covers the change', () => {
    const plain = houseRulesRow(data({ entries: [rule()] }))!;
    expect(plain.detail).toBe('1 rule(s) checked');
    expect(plain.body).toBe('## Checked\n- Rule `42ac658a` No inline SVGs — every change');
    const covered = houseRulesRow(
      data({ entries: [rule()], changedFilesCoverage: { listed: 100, total: 100 } }),
    );
    expect(JSON.stringify(covered)).toBe(JSON.stringify(plain));
  });

  it('has nothing to say about a capped file list when no rule was given to the validator', () => {
    const none = data({ changedFilesCoverage: capped });
    expect(houseRulesRow(none)).toBeNull();
    expect(houseRulesHoldApprove(none)).toBe(false);
    const off = houseRulesRow(data({ reason: 'switched_off', changedFilesCoverage: capped }))!;
    expect(off).toMatchObject({ statusLabel: 'OFF', detail: 'house rules are switched off' });
    expect(off.body).toBeUndefined();
    const unread = houseRulesRow(
      data({ reason: 'unavailable', errorClass: 'timeout', changedFilesCoverage: capped }),
    )!;
    expect(unread).toMatchObject({
      statusLabel: 'NOT CHECKED',
      detail: 'the global KB could not be read (timeout)',
    });
    expect(unread.body).toBeUndefined();
  });

  it('counts what was checked, what was not, the conflicts and the open violations', () => {
    const d = data({
      entries: [rule(), rule({ shortId: '9d1f0b7c', title: 'B' })],
      omitted: [left],
      violations: [found],
      conflicts: [conflict, conflict],
    });
    expect(houseRulesRow(d)!.detail).toBe(
      '2 rule(s) checked; 1 not checked; 2 conflict(s); 1 violation(s) open',
    );
    expect(houseRulesRow(data({ entries: [rule()] }))!.detail).toBe('1 rule(s) checked');
  });

  it('says why nothing was checked', () => {
    expect(houseRulesRow(data({ reason: 'unavailable', errorClass: 'timeout' }))!.detail).toBe(
      'the global KB could not be read (timeout)',
    );
    expect(houseRulesRow(data({ reason: 'unavailable' }))!.detail).toBe(
      'the global KB could not be read',
    );
    expect(houseRulesRow(data({ reason: 'too_large', omitted: [left, left] }))!.detail).toBe(
      'the prompt was too large for the CLI; 2 not checked',
    );
    expect(houseRulesRow(data({ reason: 'switched_off' }))!.detail).toBe(
      'house rules are switched off',
    );
  });

  it('lists the rules, what was left out, the conflicts and the open violations', () => {
    const d = data({
      entries: [
        rule(),
        rule({
          shortId: '9d1f0b7c',
          title: 'Templates stay thin',
          why: { scope: 'files', glob: '**/*.tpl.php' },
        }),
        rule({ shortId: '7be19d02', title: 'Unmeasured', why: { scope: 'files', glob: null } }),
      ],
      omitted: [left, { title: 'Refused text', why: 'refused' }],
      violations: [found],
      conflicts: [conflict],
    });
    expect(houseRulesRow(d)!.body).toBe(
      [
        '## Checked',
        '- Rule `42ac658a` No inline SVGs — every change',
        '- Rule `9d1f0b7c` Templates stay thin — files matching `**/*.tpl.php`',
        '- Rule `7be19d02` Unmeasured — files (change not measured)',
        '',
        '## Not checked',
        '- Rule Did not fit — left out of the prompt: it did not fit the prompt budget',
        '- Rule Refused text — left out of the prompt: its text was refused',
        '',
        '## Conflicts',
        '- Rule `42ac658a` No inline SVGs — `src/a.php:7`: the spec requires it',
        '',
        '## Violations open',
        '- Rule `42ac658a` No inline SVGs — `templates/node.tpl.php:12`: inline svg in a template',
      ].join('\n'),
    );
  });

  it('writes a section only when it has lines, and no body when it has none', () => {
    expect(houseRulesRow(data({ entries: [rule()] }))!.body).toBe(
      '## Checked\n- Rule `42ac658a` No inline SVGs — every change',
    );
    expect(houseRulesRow(data({ reason: 'switched_off' }))!.body).toBeUndefined();
    expect(
      houseRulesRow(data({ reason: 'unavailable', errorClass: 'auth' }))!.body,
    ).toBeUndefined();
  });

  it('names a conflict by its rule when the stamp has no such entry, and drops the file it lacks', () => {
    const d = data({
      entries: [rule()],
      conflicts: [{ rule: 'rule DEADBEEF', reason: 'a person asked for it' }],
    });
    expect(houseRulesRow(d)!.body).toContain(
      '## Conflicts\n- Rule `rule DEADBEEF` — a person asked for it',
    );
  });

  it('resolves a conflict written as "Rule <id>" in any case to the entry it names', () => {
    const d = data({
      entries: [rule()],
      conflicts: [{ rule: ' RULE 42AC658A ', file: 'src/a.php:7', reason: 'why' }],
    });
    expect(houseRulesRow(d)!.body).toContain(
      '## Conflicts\n- Rule `42ac658a` No inline SVGs — `src/a.php:7`: why',
    );
  });

  it('shows agent text as text, so an image in it is never fetched', () => {
    const d = data({
      entries: [rule({ title: '![x](http://e.test/i.png)' })],
      omitted: [{ title: '# heading', why: 'budget' }],
      violations: [{ ...found, shortId: '42ac658a', description: '[link](http://e.test)' }],
      conflicts: [{ rule: '42ac658a', reason: '![y](http://e.test/j.png)' }],
    });
    const body = houseRulesRow(d)!.body!;
    expect(body).not.toContain('![');
    expect(body).not.toContain('](');
    expect(body).toContain('\\!\\[x\\]\\(http\\:\\/\\/e\\.test\\/i\\.png\\)');
    expect(body).toContain('\\# heading');
  });

  it('sets a file or glob that holds backticks in a code span that cannot be closed early', () => {
    const d = data({
      entries: [rule({ why: { scope: 'files', glob: 'a`b/**' } })],
      violations: [{ ...found, file: 'x`y.php:1' }],
    });
    const body = houseRulesRow(d)!.body!;
    expect(body).toContain('files matching ``a`b/**``');
    expect(body).toContain('``x`y.php:1``');
  });

  it('leaves the payload it is given as it found it', () => {
    const d = data({ entries: [rule()], violations: [found], conflicts: [conflict] });
    const before = JSON.stringify(d);
    houseRulesRow(d);
    houseRulesHoldApprove(d);
    expect(JSON.stringify(d)).toBe(before);
  });
});

describe('houseRulesHoldApprove', () => {
  it.each(TABLE)('%s', (_name, d, _status, _label, holds) => {
    expect(houseRulesHoldApprove(d)).toBe(holds);
  });
});
