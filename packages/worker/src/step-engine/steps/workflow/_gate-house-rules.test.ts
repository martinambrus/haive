import { describe, expect, it } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { houseRuleShortIds, type HouseRulesStamp } from '@haive/shared/global-kb';
import {
  houseRulesHoldApprove,
  houseRulesRow,
  loadGateHouseRules,
  loadInvocationStamp,
  normalizeRuleRef,
  parseRuleConflicts,
  parseRuleRef,
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
  const invocation = (
    id: string,
    houseRules: unknown,
    over: Record<string, unknown> = {},
  ): void => {
    fake.insert(schema.cliInvocations, { id, taskId: TASK, houseRules, ...over });
  };
  return { fake, db, step07b, invocation };
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
  ['rules checked', data({ entries: [rule()] }), 'pass', 'ENFORCED', false],
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
