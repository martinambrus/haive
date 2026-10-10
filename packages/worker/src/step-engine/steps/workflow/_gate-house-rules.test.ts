import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { houseRuleShortIds, type HouseRulesStamp } from '@haive/shared/global-kb';
import { changeFingerprint } from '../../../orchestrator/house-rules-dispatch.js';
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
  taskChangeFingerprint,
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

  it('carries the flag 07b stored when a fix left the change unread, beside the counts', async () => {
    const w = world();
    w.step07b(validatorOutput({ changedFilesCoverage: { listed: 3, total: 3, scanFailed: true } }));
    w.invocation(VALIDATOR, stamp({ entries }));
    expect((await loadGateHouseRules(w.db, TASK))!.changedFilesCoverage).toEqual({
      listed: 3,
      total: 3,
      scanFailed: true,
    });
  });

  it.each([
    ['false', false],
    ['text', 'true'],
    ['a number', 1],
    ['null', null],
  ])('reads a flag stored as %s as no flag, and keeps the counts', async (_name, stored) => {
    const w = world();
    w.step07b(
      validatorOutput({ changedFilesCoverage: { listed: 3, total: 3, scanFailed: stored } }),
    );
    w.invocation(VALIDATOR, stamp({ entries }));
    const loaded = await loadGateHouseRules(w.db, TASK);
    expect(loaded!.changedFilesCoverage).toEqual({ listed: 3, total: 3 });
    expect('scanFailed' in loaded!.changedFilesCoverage!).toBe(false);
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
      changedFilesCoverage: { listed: 2, total: 2, givenTo: 'code review' },
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
      givenTo: 'code review',
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

describe('loadGateHouseRules: the change after the last check', () => {
  const PEER = 'cccccccc-0000-4000-8000-000000000001';
  const STORED = 'a'.repeat(64);
  const LATER = 'b'.repeat(64);
  const MOVED = 'c'.repeat(64);
  const entryA = entry(RULE_A, 'No inline SVGs', ALWAYS);
  const entryC = entry(RULE_C, 'Stylesheets stay in files', ALWAYS);
  const withCodeReview = { withCodeReview: true };

  /** What the caller says the change is now, and how many times it was asked. */
  function change(value: string | null) {
    const asked = { count: 0 };
    return {
      asked,
      currentFingerprint: async () => {
        asked.count += 1;
        return value;
      },
    };
  }
  const reviewOutput = (over: Record<string, unknown> = {}) => ({
    reviewed: true,
    peer: { verdict: 'APPROVE', findings: [], positives: [] },
    coverage: { listed: 2, total: 2, truncated: false },
    ruleConflicts: [],
    peerInvocationId: PEER,
    ...over,
  });

  /** 07b checked rule A and stored STORED. */
  function checkedByValidator(
    over: { output?: Record<string, unknown>; stamp?: Partial<HouseRulesStamp> } = {},
  ) {
    const w = world();
    w.step07b(validatorOutput({ changeFingerprint: STORED, ...over.output }));
    w.invocation(VALIDATOR, stamp({ entries: [entryA], ...over.stamp }));
    return w;
  }

  it('marks a change that moved after 07b checked it, and changes nothing else of the row', async () => {
    const w = checkedByValidator();
    const plain = await loadGateHouseRules(w.db, TASK);
    const moved = change(MOVED);
    const loaded = await loadGateHouseRules(w.db, TASK, {
      currentFingerprint: moved.currentFingerprint,
    });
    expect(loaded).toEqual({ ...plain, modifiedAfterCheck: true });
    expect(moved.asked.count).toBe(1);
  });

  it('leaves a change that did not move exactly as the row it was', async () => {
    const w = checkedByValidator();
    const plain = await loadGateHouseRules(w.db, TASK);
    const same = change(STORED);
    const loaded = await loadGateHouseRules(w.db, TASK, {
      currentFingerprint: same.currentFingerprint,
    });
    expect(loaded).toEqual(plain);
    expect('modifiedAfterCheck' in loaded!).toBe(false);
  });

  it('reads a files rule that matched nothing as a rule in play: a later write may match it', async () => {
    const w = checkedByValidator({ stamp: { entries: [], filesRulesUnmatched: 2 } });
    const loaded = await loadGateHouseRules(w.db, TASK, {
      currentFingerprint: change(MOVED).currentFingerprint,
    });
    expect(loaded!.entries).toEqual([]);
    expect(loaded!.modifiedAfterCheck).toBe(true);
  });

  it.each([
    ['no entries and no unmatched rule', { entries: [] }],
    ['no entries and a count of zero', { entries: [], filesRulesUnmatched: 0 }],
    ['the switch off', { entries: [], reason: 'switched_off' as const }],
  ])(
    'says nothing of a change that moved when the stamp has %s, and does not ask for it',
    async (_n, over) => {
      const w = checkedByValidator({ stamp: over });
      const moved = change(MOVED);
      const loaded = await loadGateHouseRules(w.db, TASK, {
        currentFingerprint: moved.currentFingerprint,
      });
      expect('modifiedAfterCheck' in loaded!).toBe(false);
      expect(moved.asked.count).toBe(0);
    },
  );

  it.each([
    ['carries no changeFingerprint (an output written before there was one)', undefined],
    ['has null', null],
    ['has an empty one', ''],
    ['has one that is not text', 7],
  ])('does not ask for the change when 07b %s', async (_name, stored) => {
    const w = checkedByValidator({ output: { changeFingerprint: stored } });
    const moved = change(MOVED);
    const loaded = await loadGateHouseRules(w.db, TASK, {
      currentFingerprint: moved.currentFingerprint,
    });
    expect('modifiedAfterCheck' in loaded!).toBe(false);
    expect(moved.asked.count).toBe(0);
  });

  it('reads a change it could not fingerprint now as a change that did not move', async () => {
    const w = checkedByValidator();
    const loaded = await loadGateHouseRules(w.db, TASK, {
      currentFingerprint: change(null).currentFingerprint,
    });
    expect('modifiedAfterCheck' in loaded!).toBe(false);
  });

  it('compares with the code review, the later check, when it ran with a stamp', async () => {
    const w = checkedByValidator();
    w.step08c(reviewOutput({ changeFingerprint: LATER }));
    w.invocation(PEER, stamp({ entries: [entryC] }));
    const alone = await loadGateHouseRules(w.db, TASK, withCodeReview);
    const as07b = await loadGateHouseRules(w.db, TASK, {
      ...withCodeReview,
      currentFingerprint: change(STORED).currentFingerprint,
    });
    expect(as07b).toEqual({ ...alone, modifiedAfterCheck: true });
    const as08c = await loadGateHouseRules(w.db, TASK, {
      ...withCodeReview,
      currentFingerprint: change(LATER).currentFingerprint,
    });
    expect(as08c).toEqual(alone);
  });

  it("never falls back to 07b's fingerprint when the code review stored none", async () => {
    const w = checkedByValidator();
    w.step08c(reviewOutput());
    w.invocation(PEER, stamp({ entries: [entryC] }));
    const moved = change(MOVED);
    const loaded = await loadGateHouseRules(w.db, TASK, {
      ...withCodeReview,
      currentFingerprint: moved.currentFingerprint,
    });
    expect('modifiedAfterCheck' in loaded!).toBe(false);
    expect(moved.asked.count).toBe(0);
  });

  it('judges whether a rule was in play by the stamp of the LAST check', async () => {
    const w = checkedByValidator();
    w.step08c(reviewOutput({ changeFingerprint: LATER }));
    w.invocation(PEER, stamp({ entries: [] }));
    const moved = change(MOVED);
    const loaded = await loadGateHouseRules(w.db, TASK, {
      ...withCodeReview,
      currentFingerprint: moved.currentFingerprint,
    });
    expect('modifiedAfterCheck' in loaded!).toBe(false);
    expect(moved.asked.count).toBe(0);
  });

  it.each([
    ['carries no peerInvocationId', { peerInvocationId: undefined }],
    ['names an invocation that does not exist', { peerInvocationId: OTHER }],
  ])('compares with 07b when the code review output %s', async (_name, over) => {
    const w = checkedByValidator();
    w.step08c(reviewOutput({ changeFingerprint: LATER, ...over }));
    w.invocation(PEER, stamp({ entries: [entryC] }));
    const loaded = await loadGateHouseRules(w.db, TASK, {
      ...withCodeReview,
      currentFingerprint: change(LATER).currentFingerprint,
    });
    expect(loaded!.modifiedAfterCheck).toBe(true);
  });

  it('compares gate 3, which reads 07b alone, with 07b whatever the code review stored', async () => {
    const w = checkedByValidator();
    w.step08c(reviewOutput({ changeFingerprint: LATER }));
    w.invocation(PEER, stamp({ entries: [entryC] }));
    const loaded = await loadGateHouseRules(w.db, TASK, {
      currentFingerprint: change(LATER).currentFingerprint,
    });
    expect(loaded!.modifiedAfterCheck).toBe(true);
    const same = await loadGateHouseRules(w.db, TASK, {
      currentFingerprint: change(STORED).currentFingerprint,
    });
    expect('modifiedAfterCheck' in same!).toBe(false);
  });

  it('is asked for nothing when the caller supplies no way to read the change', async () => {
    const w = checkedByValidator();
    const loaded = await loadGateHouseRules(w.db, TASK, withCodeReview);
    expect('modifiedAfterCheck' in loaded!).toBe(false);
  });

  it('gives no row, however the change moved, when 07b names no usable stamp', async () => {
    const w = world();
    w.step07b(validatorOutput({ changeFingerprint: STORED, validatorInvocationId: null }));
    const moved = change(MOVED);
    expect(
      await loadGateHouseRules(w.db, TASK, { currentFingerprint: moved.currentFingerprint }),
    ).toBeNull();
    expect(moved.asked.count).toBe(0);
  });
});

describe('loadGateHouseRules: whose list of changed files was capped', () => {
  const PEER = 'cccccccc-0000-4000-8000-000000000001';
  const entryA = entry(RULE_A, 'No inline SVGs', ALWAYS);
  const withCodeReview = { withCodeReview: true };

  it("names the code review for its own coverage, alone or beside 07b's", async () => {
    const w = world();
    w.step07b(validatorOutput({ changedFilesCoverage: { listed: 100, total: 150 } }));
    w.invocation(VALIDATOR, stamp({ entries: [entryA] }));
    w.step08c({
      reviewed: true,
      peer: { verdict: 'APPROVE', findings: [], positives: [] },
      coverage: { listed: 60, total: 90, truncated: true },
      peerInvocationId: PEER,
    });
    w.invocation(PEER, stamp({ entries: [entryA] }));
    const merged = await loadGateHouseRules(w.db, TASK, withCodeReview);
    expect(merged!.changedFilesCoverage).toEqual({ listed: 60, total: 90, givenTo: 'code review' });

    const alone = world();
    alone.step07b(validatorOutput({ validatorInvocationId: null }));
    alone.step08c({
      reviewed: true,
      peer: { verdict: 'APPROVE', findings: [], positives: [] },
      coverage: { listed: 60, total: 90, truncated: true },
      peerInvocationId: PEER,
    });
    alone.invocation(PEER, stamp({ entries: [entryA] }));
    expect(
      (await loadGateHouseRules(alone.db, TASK, withCodeReview))!.changedFilesCoverage,
    ).toEqual({ listed: 60, total: 90, givenTo: 'code review' });
  });

  it("names the validator for 07b's coverage, which the merged row falls back to", async () => {
    const w = world();
    w.step07b(validatorOutput({ changedFilesCoverage: { listed: 100, total: 150 } }));
    w.invocation(VALIDATOR, stamp({ entries: [entryA] }));
    w.step08c({
      reviewed: true,
      peer: { verdict: 'APPROVE', findings: [], positives: [] },
      coverage: null,
      peerInvocationId: PEER,
    });
    w.invocation(PEER, stamp({ entries: [entryA] }));
    const merged = await loadGateHouseRules(w.db, TASK, withCodeReview);
    expect(merged!.changedFilesCoverage).toEqual({ listed: 100, total: 150 });
    expect('givenTo' in merged!.changedFilesCoverage!).toBe(false);
  });

  it("keeps 07b's unread-change flag in the fallback, and drops it for the code review's own record", async () => {
    const seed = (coverage: unknown) => {
      const w = world();
      w.step07b(
        validatorOutput({ changedFilesCoverage: { listed: 3, total: 3, scanFailed: true } }),
      );
      w.invocation(VALIDATOR, stamp({ entries: [entryA] }));
      w.step08c({
        reviewed: true,
        peer: { verdict: 'APPROVE', findings: [], positives: [] },
        coverage,
        peerInvocationId: PEER,
      });
      w.invocation(PEER, stamp({ entries: [entryA] }));
      return w;
    };
    const fallback = await loadGateHouseRules(seed(null).db, TASK, withCodeReview);
    expect(fallback!.changedFilesCoverage).toEqual({ listed: 3, total: 3, scanFailed: true });
    const own = await loadGateHouseRules(
      seed({ listed: 5, total: 5, truncated: false }).db,
      TASK,
      withCodeReview,
    );
    expect(own!.changedFilesCoverage).toEqual({ listed: 5, total: 5, givenTo: 'code review' });
    expect('scanFailed' in own!.changedFilesCoverage!).toBe(false);
  });
});

describe('taskChangeFingerprint', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });

  async function checkout(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'haive-task-fingerprint-'));
    dirs.push(dir);
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 'test@test.local');
    git(dir, 'config', 'user.name', 'Test');
    git(dir, 'config', 'gc.auto', '0');
    await writeFile(path.join(dir, 'a.php'), '<?php\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'base');
    git(dir, 'checkout', '-q', '-b', 'task');
    await writeFile(path.join(dir, 'a.php'), '<?php // changed\n');
    return dir;
  }
  const taskWith = (output: unknown) => {
    const fake = createFakeDb({ taskSteps: schema.taskSteps });
    if (output !== undefined) {
      fake.insert(schema.taskSteps, {
        taskId: TASK,
        stepId: '01-worktree-setup',
        round: 0,
        output,
      });
    }
    return { db: fake.db as unknown as Database, taskId: TASK };
  };

  it('is the fingerprint of the worktree 01-worktree-setup made, against the base it recorded', async () => {
    const dir = await checkout();
    const fingerprint = await taskChangeFingerprint(
      taskWith({ worktreePath: dir, baseBranch: 'main' }),
    );
    expect(fingerprint).toBe(await changeFingerprint(dir, 'main'));
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    await writeFile(path.join(dir, 'a.php'), '<?php // changed again\n');
    expect(
      await taskChangeFingerprint(taskWith({ worktreePath: dir, baseBranch: 'main' })),
    ).not.toBe(fingerprint);
  });

  it('measures against the dirty files alone when the setup recorded no base', async () => {
    const dir = await checkout();
    expect(await taskChangeFingerprint(taskWith({ worktreePath: dir }))).toBe(
      await changeFingerprint(dir, null),
    );
  });

  it.each([
    ['no setup row', undefined],
    ['an output that was reset', null],
    ['an output without a worktree path', { baseBranch: 'main' }],
    ['a worktree path that is not text', { worktreePath: 7, baseBranch: 'main' }],
  ])('is null for %s', async (_name, output) => {
    expect(await taskChangeFingerprint(taskWith(output))).toBeNull();
  });

  it('is null for a worktree that is not a checkout', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'haive-task-fingerprint-'));
    dirs.push(dir);
    expect(
      await taskChangeFingerprint(taskWith({ worktreePath: dir, baseBranch: 'main' })),
    ).toBeNull();
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
const unread = { listed: 3, total: 3, scanFailed: true } as const;

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
  [
    'a change a fix left unread',
    data({ entries: [rule()], changedFilesCoverage: unread }),
    'warn',
    'PARTIAL',
    true,
  ],
  [
    'a change modified after the last check',
    data({ entries: [rule()], modifiedAfterCheck: true }),
    'warn',
    'PARTIAL',
    true,
  ],
  [
    'a change modified after a check whose files rules matched nothing yet',
    data({ modifiedAfterCheck: true }),
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

  it('ranks a change modified after the last check like a rule left out: below the other states, above ENFORCED', () => {
    const all = data({
      entries: [rule()],
      violations: [found],
      conflicts: [conflict],
      reason: 'unavailable',
      modifiedAfterCheck: true,
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
    expect(houseRulesRow({ ...rest, modifiedAfterCheck: false })!.statusLabel).toBe('ENFORCED');
    expect(houseRulesRow({ ...rest, modifiedAfterCheck: undefined })!.statusLabel).toBe('ENFORCED');
  });

  it('says the change was modified after the last house-rules check, and lists it as not checked', () => {
    const row = houseRulesRow(data({ entries: [rule()], modifiedAfterCheck: true }))!;
    expect(row.detail).toBe(
      '1 rule(s) checked; the change was modified after the last house-rules check',
    );
    expect(row.body).toBe(
      [
        '## Checked',
        '- Rule `42ac658a` No inline SVGs — every change',
        '',
        '## Not checked',
        '- changes made after the last house-rules check',
      ].join('\n'),
    );
  });

  it('still gives a row for a check that matched no files rule yet: a write since may break one', () => {
    const row = houseRulesRow(data({ modifiedAfterCheck: true }))!;
    expect(row).toMatchObject({ status: 'warn', statusLabel: 'PARTIAL', defaultOpen: true });
    expect(row.detail).toBe('the change was modified after the last house-rules check');
    expect(row.body).toBe('## Not checked\n- changes made after the last house-rules check');
  });

  it('puts the modified change after the rules left out and the capped list, in the same section', () => {
    const row = houseRulesRow(
      data({
        entries: [rule()],
        omitted: [left],
        changedFilesCoverage: capped,
        modifiedAfterCheck: true,
      }),
    )!;
    expect(row.detail).toBe(
      '1 rule(s) checked; 1 not checked; the validator was given 100 of 150 changed files; the change was modified after the last house-rules check',
    );
    expect(row.body).toContain(
      [
        '## Not checked',
        '- Rule Did not fit — left out of the prompt: it did not fit the prompt budget',
        "- 50 changed files beyond the validator's list of 100",
        '- changes made after the last house-rules check',
      ].join('\n'),
    );
  });

  it('still names the modified change beside a conflict and a violation, which keep the row', () => {
    const row = houseRulesRow(
      data({
        entries: [rule()],
        conflicts: [conflict],
        violations: [found],
        modifiedAfterCheck: true,
      }),
    )!;
    expect(row.statusLabel).toBe('CONFLICT');
    expect(row.detail).toBe(
      '1 rule(s) checked; the change was modified after the last house-rules check; 1 conflict(s); 1 violation(s) open',
    );
    expect(row.body).toContain('## Not checked\n- changes made after the last house-rules check');
  });

  it('names the code review where the capped list was its own, and the validator where it was not', () => {
    const own = { ...capped, givenTo: 'code review' as const };
    const row = houseRulesRow(data({ entries: [rule()], changedFilesCoverage: own }))!;
    expect(row.detail).toBe(
      '1 rule(s) checked; the code review was given 100 of 150 changed files',
    );
    expect(row.body).toContain("- 50 changed files beyond the code review's list of 100");
    expect(row.body).not.toContain('validator');
    const validator = houseRulesRow(data({ entries: [rule()], changedFilesCoverage: capped }))!;
    expect(validator.detail).toBe(
      '1 rule(s) checked; the validator was given 100 of 150 changed files',
    );
    expect(validator.body).toContain("- 50 changed files beyond the validator's list of 100");
    expect(validator.body).not.toContain('code review');
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

  it('ranks a change a fix left unread like a capped file list: below the other states, above ENFORCED', () => {
    const all = data({
      entries: [rule()],
      violations: [found],
      conflicts: [conflict],
      reason: 'unavailable',
      changedFilesCoverage: unread,
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
    expect(
      houseRulesRow({ ...rest, changedFilesCoverage: { listed: 3, total: 3 } })!.statusLabel,
    ).toBe('ENFORCED');
  });

  it('says the change could not be fully read, and lists what the read missed as not checked', () => {
    const row = houseRulesRow(data({ entries: [rule()], changedFilesCoverage: unread }))!;
    expect(row.detail).toBe('1 rule(s) checked; the change could not be fully read');
    expect(row.body).toBe(
      [
        '## Checked',
        '- Rule `42ac658a` No inline SVGs — every change',
        '',
        '## Not checked',
        '- files the read missed, if any — the change could not be fully read',
      ].join('\n'),
    );
  });

  it('puts the unread change after the capped list and before the late modification, in the same section', () => {
    const row = houseRulesRow(
      data({
        entries: [rule()],
        omitted: [left],
        changedFilesCoverage: { ...capped, scanFailed: true },
        modifiedAfterCheck: true,
      }),
    )!;
    expect(row.detail).toBe(
      '1 rule(s) checked; 1 not checked; the validator was given 100 of 150 changed files; the change could not be fully read; the change was modified after the last house-rules check',
    );
    expect(row.body).toContain(
      [
        '## Not checked',
        '- Rule Did not fit — left out of the prompt: it did not fit the prompt budget',
        "- 50 changed files beyond the validator's list of 100",
        '- files the read missed, if any — the change could not be fully read',
        '- changes made after the last house-rules check',
      ].join('\n'),
    );
  });

  it('still names the unread change beside a conflict and a violation, which keep the row', () => {
    const row = houseRulesRow(
      data({
        entries: [rule()],
        conflicts: [conflict],
        violations: [found],
        changedFilesCoverage: unread,
      }),
    )!;
    expect(row.statusLabel).toBe('CONFLICT');
    expect(row.detail).toBe(
      '1 rule(s) checked; the change could not be fully read; 1 conflict(s); 1 violation(s) open',
    );
    expect(row.body).toContain(
      '## Not checked\n- files the read missed, if any — the change could not be fully read',
    );
  });

  it('has nothing to say about an unread change when no rule was given to the validator', () => {
    const none = data({ changedFilesCoverage: unread });
    expect(houseRulesRow(none)).toBeNull();
    expect(houseRulesHoldApprove(none)).toBe(false);
    const off = houseRulesRow(data({ reason: 'switched_off', changedFilesCoverage: unread }))!;
    expect(off).toMatchObject({ statusLabel: 'OFF', detail: 'house rules are switched off' });
    expect(off.body).toBeUndefined();
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
