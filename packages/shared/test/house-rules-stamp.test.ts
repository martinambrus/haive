import { describe, expect, it } from 'vitest';
import type { schema } from '@haive/database';
import {
  houseRuleStampTitle,
  parseHouseRulesStamp,
  type HouseRulesStamp,
} from '../src/global-kb/house-rules.js';
import { collapseToLine } from '../src/utils/collapse-line.js';

type StoredStamp = NonNullable<(typeof schema.cliInvocations.$inferInsert)['houseRules']>;

const HASH = `hr1:${'a'.repeat(64)}`;
const ID_A = '42ac658a-1111-4111-8111-111111111111';
const ID_B = '9f3e0b7c-2222-4222-8222-222222222222';
const ID_C = 'c0ffee00-3333-4333-8333-333333333333';
const ID_D = 'd00d1e00-4444-4444-8444-444444444444';

const FULL: HouseRulesStamp = {
  mode: 'write',
  entries: [
    { id: ID_A, hash: HASH, title: 'No inline SVGs', why: { scope: 'always' } },
    {
      id: ID_B,
      hash: HASH,
      title: 'Templates stay thin',
      why: { scope: 'files', glob: '**/*.tpl.php' },
    },
    { id: ID_C, hash: HASH, title: 'Unmeasured', why: { scope: 'files', glob: null } },
  ],
  omitted: [
    { id: ID_D, hash: HASH, title: 'Did not fit', why: 'budget' },
    { id: ID_A, hash: HASH, title: 'Refused text', why: 'refused' },
  ],
};

describe('parseHouseRulesStamp', () => {
  it('reads and writes the type the cli_invocations.house_rules column stores', () => {
    // Checked by `pnpm typecheck`: either side drifting from the other stops compiling here.
    const column: StoredStamp = FULL;
    const stamp: HouseRulesStamp = column;
    expect(parseHouseRulesStamp(stamp)).toEqual(FULL);
  });

  it('reads a stamp with entries of both scopes and omitted rules, and gives back what was stored', () => {
    expect(parseHouseRulesStamp(FULL)).toEqual(FULL);
    expect(parseHouseRulesStamp(JSON.parse(JSON.stringify(FULL)))).toEqual(FULL);
  });

  it('gives back a stamp written before the via marker existed, with no via key added', () => {
    expect(parseHouseRulesStamp(FULL)).toStrictEqual(FULL);
    expect(parseHouseRulesStamp(JSON.parse(JSON.stringify(FULL)))).toStrictEqual(FULL);
  });

  it('keeps the via marker of a rule only a named path selected', () => {
    const named: HouseRulesStamp = {
      ...FULL,
      entries: [
        { ...FULL.entries[1]!, why: { scope: 'files', glob: '**/*.css', via: 'named' } },
        FULL.entries[2]!,
      ],
    };
    expect(parseHouseRulesStamp(named)).toStrictEqual(named);
    expect(parseHouseRulesStamp(JSON.parse(JSON.stringify(named)))).toStrictEqual(named);
  });

  it.each([['similar'], [42], [null], [['named']], [{}], [true]])(
    'drops the via %j alone and keeps the rest of the stamp',
    (via) => {
      const stored = {
        ...FULL,
        filesRulesUnmatched: 2,
        entries: FULL.entries.map((e) =>
          e.why.scope === 'files' ? { ...e, why: { ...e.why, via } } : e,
        ),
      };
      const parsed = parseHouseRulesStamp(stored);
      expect(parsed).toEqual({ ...FULL, filesRulesUnmatched: 2 });
      expect(JSON.stringify(parsed)).toBe(JSON.stringify({ ...FULL, filesRulesUnmatched: 2 }));
    },
  );

  it('stores the via marker in the column type as well', () => {
    // Checked by `pnpm typecheck`: the column's own type has to name the key too.
    const column: StoredStamp = {
      mode: 'write',
      entries: [
        {
          id: ID_B,
          hash: HASH,
          title: 'Templates stay thin',
          why: { scope: 'files', glob: '**/*.css', via: 'named' },
        },
      ],
      omitted: [],
    };
    expect(parseHouseRulesStamp(column)).toStrictEqual(column);
  });

  it('reads a review stamp that carries no rule and says why', () => {
    const unavailable: HouseRulesStamp = {
      mode: 'review',
      entries: [],
      omitted: [],
      reason: 'unavailable',
      errorClass: 'timeout',
    };
    expect(parseHouseRulesStamp(unavailable)).toEqual(unavailable);
  });

  it.each(['switched_off', 'unavailable', 'too_large'] as const)(
    'reads the reason %s',
    (reason) => {
      expect(parseHouseRulesStamp({ ...FULL, reason })).toEqual({ ...FULL, reason });
    },
  );

  it.each(['timeout', 'refused', 'auth', 'other'] as const)(
    'reads the error class %s',
    (errorClass) => {
      const stamp = { ...FULL, reason: 'unavailable' as const, errorClass };
      expect(parseHouseRulesStamp(stamp)).toEqual(stamp);
    },
  );

  it('reads the count of files rules that matched nothing, and a stamp written without it', () => {
    const counted: HouseRulesStamp = { ...FULL, filesRulesUnmatched: 2 };
    expect(parseHouseRulesStamp(counted)).toEqual(counted);
    expect(parseHouseRulesStamp({ ...FULL, filesRulesUnmatched: 0 })).toEqual({
      ...FULL,
      filesRulesUnmatched: 0,
    });
    expect('filesRulesUnmatched' in parseHouseRulesStamp(FULL)!).toBe(false);
  });

  it('stores the count in the column type as well', () => {
    // Checked by `pnpm typecheck`: the column's own type has to name the key too.
    const column: StoredStamp = { ...FULL, filesRulesUnmatched: 1 };
    expect(parseHouseRulesStamp(column)?.filesRulesUnmatched).toBe(1);
  });

  it('leaves out a key it does not know rather than refusing the stamp', () => {
    const later = { ...FULL, similar: [{ id: ID_A, score: 0.9 }] };
    expect(parseHouseRulesStamp(later)).toEqual(FULL);
  });

  it.each([[null], [undefined], ['x'], ['{"mode":"write"}'], [3], [true], [[]], [[FULL]]])(
    'reads %j as none',
    (stored) => {
      expect(parseHouseRulesStamp(stored)).toBeNull();
    },
  );

  const entry = FULL.entries[0]!;
  it.each([
    ['an empty object', {}],
    ['a mode that is neither write nor review', { ...FULL, mode: 'other' }],
    ['no mode', { ...FULL, mode: undefined }],
    ['entries that are not a list', { ...FULL, entries: 'none' }],
    ['no entries', { ...FULL, entries: undefined }],
    ['no omitted list', { ...FULL, omitted: undefined }],
    ['an entry without a hash', { ...FULL, entries: [{ ...entry, hash: undefined }] }],
    ['an entry whose id is a number', { ...FULL, entries: [{ ...entry, id: 7 }] }],
    ['an entry without a title', { ...FULL, entries: [{ ...entry, title: undefined }] }],
    ['an entry whose why is a bare word', { ...FULL, entries: [{ ...entry, why: 'always' }] }],
    [
      'an entry with a scope of sometimes',
      { ...FULL, entries: [{ ...entry, why: { scope: 'sometimes' } }] },
    ],
    [
      'a files entry without its glob',
      { ...FULL, entries: [{ ...entry, why: { scope: 'files' } }] },
    ],
    [
      'a files entry whose glob is a number',
      { ...FULL, entries: [{ ...entry, why: { scope: 'files', glob: 3 } }] },
    ],
    [
      'an omitted rule that is neither budget nor refused',
      { ...FULL, omitted: [{ ...entry, why: 'cleared' }] },
    ],
    ['a count of unmatched rules that is negative', { ...FULL, filesRulesUnmatched: -1 }],
    ['a count of unmatched rules that is not whole', { ...FULL, filesRulesUnmatched: 1.5 }],
    ['a count of unmatched rules written as text', { ...FULL, filesRulesUnmatched: '2' }],
    ['a reason it does not know', { ...FULL, reason: 'rate_limited' }],
    ['an error class it does not know', { ...FULL, errorClass: 'dns' }],
  ])('reads %s as none', (_name, stored) => {
    expect(parseHouseRulesStamp(stored)).toBeNull();
  });
});

describe('houseRuleStampTitle', () => {
  it('collapses the title onto one line', () => {
    expect(houseRuleStampTitle('  No \n inline\tSVGs  ')).toBe('No inline SVGs');
  });

  it('keeps a title of 300 characters whole and cuts a longer one to 300', () => {
    expect(houseRuleStampTitle('a'.repeat(300))).toBe('a'.repeat(300));
    expect(houseRuleStampTitle('a'.repeat(301))).toBe('a'.repeat(300));
  });

  it('never leaves half a character or a trailing space where it cuts', () => {
    const astral = '\u{1f600}';
    expect(houseRuleStampTitle(`${'a'.repeat(299)}${astral}`)).toBe('a'.repeat(299));
    expect(houseRuleStampTitle(astral.repeat(200))).toBe(astral.repeat(150));
    expect(houseRuleStampTitle(`${'a'.repeat(299)} b`)).toBe('a'.repeat(299));
  });

  it('answers a title that is already collapsed and short byte for byte', () => {
    for (const title of ['No inline SVGs', 'naïve caching', '- not a bullet']) {
      expect(houseRuleStampTitle(title)).toBe(title);
      expect(collapseToLine(houseRuleStampTitle(title))).toBe(title);
    }
  });
});

describe('the similarity record of a stamp', () => {
  const pending: NonNullable<HouseRulesStamp['similarity']> = {
    status: 'pending',
    scores: [{ id: ID_B, hash: HASH, title: 'Templates stay thin', score: null }],
  };

  it('keeps a record in each of its three states, as the column stores it', () => {
    const ok: NonNullable<HouseRulesStamp['similarity']> = {
      status: 'ok',
      model: 'qwen3-embedding:4b',
      queryHash: 'a'.repeat(64),
      ms: 412,
      scores: [{ id: ID_B, hash: HASH, title: 'Templates stay thin', score: 0.4321 }],
    };
    const failed: NonNullable<HouseRulesStamp['similarity']> = {
      status: 'failed',
      errorClass: 'timeout',
    };
    for (const similarity of [pending, ok, failed]) {
      const column: StoredStamp = { ...FULL, similarity };
      expect(parseHouseRulesStamp(JSON.parse(JSON.stringify(column)))).toStrictEqual({
        ...FULL,
        similarity,
      });
    }
  });

  it('leaves a stamp without one exactly as it was, and an old stamp parses with no key added', () => {
    expect(parseHouseRulesStamp(FULL)).toStrictEqual(FULL);
    expect('similarity' in parseHouseRulesStamp(FULL)!).toBe(false);
  });

  it('drops a malformed record alone and keeps the rest of the stamp', () => {
    for (const bad of [
      { status: 'done' },
      { scores: [] },
      'pending',
      { status: 'ok', ms: -1 },
      null,
    ]) {
      const parsed = parseHouseRulesStamp({ ...FULL, similarity: bad });
      expect(parsed).toEqual(FULL);
    }
  });

  it('drops a key a later release adds to the record, not the record', () => {
    const parsed = parseHouseRulesStamp({ ...FULL, similarity: { ...pending, floor: 0.4 } });
    expect(parsed?.similarity).toStrictEqual(pending);
  });
});
