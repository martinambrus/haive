import { describe, expect, it } from 'vitest';
import * as projectState from '../src/project-state/index.js';
import { emptyProjectState, renderProjectState, renderSchema } from '../src/project-state/index.js';

interface Verdict {
  success: boolean;
  data?: unknown;
  error?: { issues: { path: PropertyKey[] }[] };
}
interface Parser {
  safeParse(value: unknown): Verdict;
}

/** The two names this change adds, looked up by name, so that a missing one is what fails. */
function added<T>(name: string): T {
  const value = (projectState as unknown as Record<string, unknown>)[name];
  if (value === undefined) throw new Error(`@haive/shared/project-state does not export ${name}`);
  return value as T;
}
const columnSchema = () => added<Parser>('renderContextColumnSchema');
const portableRender = () => added<(context: unknown) => Record<string, unknown>>('portableRender');

const PORTABLE = [
  'projectInfo',
  'framework',
  'acceptedAgentIds',
  'customAgentSpecs',
  'lspLanguages',
] as const;
const PER_INSTALL = ['agentTargets', 'enabledCliProviders', 'rtkEnabled'] as const;

// The sets are unsorted on purpose: the record sorts them when it renders, not here.
const portable = () => ({
  projectInfo: {
    name: 'acme',
    framework: 'drupal',
    docroot: 'web',
    runtimeVersions: { php: '8.3' },
    commands: [],
  },
  framework: 'drupal',
  acceptedAgentIds: ['security-auditor', 'code-reviewer'],
  customAgentSpecs: [
    {
      id: 'billing-expert',
      title: 'Billing expert',
      description: 'Knows the billing module',
      tools: ['Read'],
    },
  ],
  lspLanguages: ['php-extended', 'css'],
});

const perInstall = () => ({
  agentTargets: [
    { dir: '.claude/agents', format: 'markdown', supportsLsp: true },
    { dir: '.codex/agents', format: 'toml' },
  ],
  enabledCliProviders: [
    { name: 'claude-code', rulesFile: 'CLAUDE.md', rulesFileMode: 'import' },
    { name: 'codex', rulesFile: 'AGENTS.md', rulesFileMode: 'native' },
  ],
  rtkEnabled: false,
});

const full = (): Record<string, unknown> => ({
  ...portable(),
  ...perInstall(),
  rtkChoiceRecorded: true,
});
const portableOnly = (): Record<string, unknown> => ({ ...portable(), rtkChoiceRecorded: false });

const without = (value: Record<string, unknown>, key: string): Record<string, unknown> => {
  const copy = { ...value };
  delete copy[key];
  return copy;
};
const sorted = (value: unknown): string[] => [...(value as string[])].sort();
const pathsOf = (verdict: Verdict): PropertyKey[] =>
  (verdict.error?.issues ?? []).map((issue) => issue.path[0]!);

describe('renderContextColumnSchema', () => {
  it('accepts a full context and keeps every field in it', () => {
    const verdict = columnSchema().safeParse(full());
    expect(verdict.success).toBe(true);
    expect(verdict.data).toEqual(full());
  });

  it('accepts a context holding the portable fields alone, and adds no per-install field', () => {
    const verdict = columnSchema().safeParse(portableOnly());
    expect(verdict.success).toBe(true);
    expect(verdict.data).toEqual(portableOnly());
    const data = verdict.data as Record<string, unknown>;
    for (const key of PER_INSTALL) expect(data[key]).toBeUndefined();
  });

  it('accepts a per-install list that is empty', () => {
    const verdict = columnSchema().safeParse({
      ...full(),
      agentTargets: [],
      enabledCliProviders: [],
    });
    expect(verdict.success).toBe(true);
  });

  it.each(PORTABLE)('refuses a context missing %s', (field) => {
    for (const context of [full(), portableOnly()]) {
      const verdict = columnSchema().safeParse(without(context, field));
      expect(verdict.success).toBe(false);
      expect(pathsOf(verdict)).toContain(field);
    }
  });

  it('refuses a context missing rtkChoiceRecorded, whatever else it holds', () => {
    for (const context of [full(), portableOnly()]) {
      const verdict = columnSchema().safeParse(without(context, 'rtkChoiceRecorded'));
      expect(verdict.success).toBe(false);
      expect(pathsOf(verdict)).toContain('rtkChoiceRecorded');
    }
  });

  it.each([['true'], [1], [0], [null], [undefined]])(
    'refuses rtkChoiceRecorded when it is %j rather than a boolean',
    (value) => {
      const verdict = columnSchema().safeParse({ ...full(), rtkChoiceRecorded: value });
      expect(verdict.success).toBe(false);
      expect(pathsOf(verdict)).toContain('rtkChoiceRecorded');
    },
  );

  // "Exactly as the record's render schema holds them": the column must give the verdict the
  // render unit gives on every probe, and the probes are not all one verdict.
  const PROBES: Record<(typeof PORTABLE)[number], unknown[]> = {
    projectInfo: ['text', 5, null, undefined, [], {}, { nested: { list: [1, 'a'] } }],
    framework: [null, 'drupal', '', 5, undefined, ['drupal'], {}],
    acceptedAgentIds: [[], ['code-reviewer'], 'code-reviewer', [1], [null], null, undefined],
    customAgentSpecs: [[], [{}], [{ id: 'a' }], [1], ['a'], {}, null, undefined],
    lspLanguages: [[], ['php-extended'], 'php-extended', [1], null, undefined],
  };
  it.each(PORTABLE)('holds %s exactly as the record render schema does', (field) => {
    let accepted = 0;
    let refused = 0;
    for (const probe of PROBES[field]) {
      const render = renderSchema.safeParse({ ...portable(), [field]: probe }).success;
      if (render) accepted += 1;
      else refused += 1;
      const column = columnSchema().safeParse({ ...full(), [field]: probe }).success;
      expect({ field, probe, accepted: column }).toEqual({ field, probe, accepted: render });
    }
    expect(accepted).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
  });

  it('checks the shape of the per-install fields it holds', () => {
    const bad: [string, unknown][] = [
      ['agentTargets', 'not a list'],
      ['agentTargets', [{ dir: '.claude/agents' }]],
      ['agentTargets', [{ format: 'markdown' }]],
      ['enabledCliProviders', 'not a list'],
      ['enabledCliProviders', [{ name: 'claude-code', rulesFile: 'CLAUDE.md' }]],
      ['enabledCliProviders', [{ name: 'claude-code', rulesFileMode: 'import' }]],
      ['enabledCliProviders', [{ rulesFile: 'CLAUDE.md', rulesFileMode: 'import' }]],
      ['rtkEnabled', 'on'],
    ];
    for (const [field, value] of bad) {
      const verdict = columnSchema().safeParse({ ...full(), [field]: value });
      expect({ field, accepted: verdict.success }).toEqual({ field, accepted: false });
    }
  });
});

describe('portableRender', () => {
  const FIVE = [...PORTABLE].sort();

  it.each([
    ['a full context', full],
    ['a portable-only context', portableOnly],
  ])('returns exactly the five portable keys of %s', (_name, make) => {
    const out = portableRender()(make());
    expect(Object.keys(out).sort()).toEqual(FIVE);
    const given = make();
    expect(out.projectInfo).toEqual(given.projectInfo);
    expect(out.framework).toEqual(given.framework);
    expect(out.customAgentSpecs).toEqual(given.customAgentSpecs);
    expect(sorted(out.acceptedAgentIds)).toEqual(sorted(given.acceptedAgentIds));
    expect(sorted(out.lspLanguages)).toEqual(sorted(given.lspLanguages));
  });

  it('leaks no per-install key, nor any key it does not know', () => {
    const out = portableRender()({ ...full(), somethingNew: { a: 1 } });
    expect(Object.keys(out).sort()).toEqual(FIVE);
    for (const key of [...PER_INSTALL, 'rtkChoiceRecorded', 'somethingNew']) {
      expect(key in out).toBe(false);
    }
  });

  it('returns a valid render unit of the record', () => {
    const out = portableRender()(full());
    expect(renderSchema.safeParse(out).success).toBe(true);
    const files = renderProjectState({
      ...emptyProjectState(),
      render: out as never,
    });
    expect([...files.keys()]).toEqual(['format.json', 'project/render.json']);
  });

  it('does not change the context it is given', () => {
    const given = full();
    const before = JSON.stringify(given);
    portableRender()(given);
    expect(JSON.stringify(given)).toBe(before);
  });
});

// ---- the resolution order both 01 and the banner read (B1.4c) --------------------------------------

interface Row {
  id: string;
  generatedAt: Date | null;
  hasSnapshot: boolean | null;
  rtkRecorded: boolean | null;
}
type ColumnRead =
  | { kind: 'absent' }
  | { kind: 'refused'; problems: string[] }
  | { kind: 'column'; column: Record<string, unknown> };
type Origin =
  | { from: 'column'; column: Record<string, unknown>; rtkRecorded: boolean }
  | { from: 'snapshot'; row: Row; rtkRecorded: boolean }
  | { from: 'history'; refused: string[] | null };
type History = { kind: 'onboarding'; rtkRecorded: boolean } | { kind: 'blank' } | { kind: 'none' };

const readColumn = () => added<(value: unknown) => ColumnRead>('readRenderContextColumn');
const originOf = () =>
  added<(input: { column: ColumnRead; rows: Row[] }) => Origin>('renderContextOrigin');
const historyOf = () =>
  added<
    (input: {
      onboarding: { detected: boolean; rtkRecorded: boolean } | null;
      source: string;
    }) => History
  >('historyOrigin');
const pickRow = () => added<(rows: Row[]) => Row | null>('pickSnapshotRow');
const namesOf = () =>
  added<(column: Record<string, unknown>, enabledNames: string[]) => string[]>(
    'renderContextProviderNames',
  );

const row = (
  id: string,
  at: number | null,
  hasSnapshot: boolean | null,
  rtkRecorded: boolean | null,
): Row => ({ id, generatedAt: at === null ? null : new Date(at), hasSnapshot, rtkRecorded });

describe('S1: readRenderContextColumn', () => {
  it('reads a NULL or a missing column as absent, and nothing else', () => {
    expect(readColumn()(null)).toEqual({ kind: 'absent' });
    expect(readColumn()(undefined)).toEqual({ kind: 'absent' });
  });

  it('reads a column the schema accepts as itself, adding no field to it', () => {
    expect(readColumn()(full())).toEqual({ kind: 'column', column: full() });
    expect(readColumn()(portableOnly())).toEqual({ kind: 'column', column: portableOnly() });
  });

  it.each([
    ['an empty object', {}, ['projectInfo', 'rtkChoiceRecorded']],
    ['an unknown key beside a full context', { ...full(), somethingNew: 1 }, []],
    [
      'a context without rtkChoiceRecorded',
      without(full(), 'rtkChoiceRecorded'),
      ['rtkChoiceRecorded'],
    ],
    ['a context missing a portable field', without(portableOnly(), 'framework'), ['framework']],
    ['text', 'not a context', []],
    ['a number', 5, []],
    ['zero', 0, []],
    ['false', false, []],
    ['an empty string', '', []],
    ['a list', [], []],
  ])(
    'refuses %s, with the problems the schema found, and never as absent',
    (_name, value, named) => {
      const read = readColumn()(value);
      expect(read.kind).toBe('refused');
      if (read.kind !== 'refused') return;
      expect(read.problems.length).toBeGreaterThan(0);
      for (const problem of read.problems) expect(typeof problem).toBe('string');
      for (const field of named) expect(read.problems.join('\n')).toContain(field);
    },
  );
});

describe('S1: renderContextOrigin', () => {
  const ROWS: Record<string, Row[]> = {
    'a recorded row older than an unrecorded one': [
      row('a', 1, true, true),
      row('b', 2, true, null),
    ],
    'an unrecorded row only': [row('a', 1, true, null)],
    'rows carrying no snapshot': [row('a', 1, null, null), row('b', 2, false, false)],
    'no rows': [],
  };
  const WANT_ROW: Record<string, { row: Row; rtkRecorded: boolean } | null> = {
    'a recorded row older than an unrecorded one': {
      row: row('a', 1, true, true),
      rtkRecorded: true,
    },
    'an unrecorded row only': { row: row('a', 1, true, null), rtkRecorded: false },
    'rows carrying no snapshot': null,
    'no rows': null,
  };

  const withFlags = (rtkEnabled: boolean | 'absent', recorded: boolean, base = full()) => {
    const column = { ...base, rtkChoiceRecorded: recorded };
    if (rtkEnabled === 'absent') delete (column as Record<string, unknown>).rtkEnabled;
    else (column as Record<string, unknown>).rtkEnabled = rtkEnabled;
    return column;
  };

  it.each(Object.entries(ROWS))(
    'puts a valid column first, whatever the rows say: %s',
    (_name, rows) => {
      for (const rtkEnabled of ['absent', true, false] as const) {
        for (const recorded of [true, false]) {
          const column = withFlags(rtkEnabled, recorded);
          const origin = originOf()({ column: { kind: 'column', column }, rows });
          // The flag is the stored one, whether the column holds rtkEnabled or not, and whatever it says.
          expect({ rtkEnabled, recorded, origin }).toEqual({
            rtkEnabled,
            recorded,
            origin: { from: 'column', column, rtkRecorded: recorded },
          });
        }
      }
      const bare = withFlags('absent', true, portableOnly());
      expect(originOf()({ column: { kind: 'column', column: bare }, rows })).toEqual({
        from: 'column',
        column: bare,
        rtkRecorded: true,
      });
    },
  );

  it.each(Object.entries(ROWS))(
    'leaves the rows and the history to a NULL or a refused column: %s',
    (name, rows) => {
      const refused = readColumn()({});
      expect(refused.kind).toBe('refused');
      const reads: [string, ColumnRead][] = [
        ['absent', { kind: 'absent' }],
        ['refused', refused],
      ];
      for (const [label, column] of reads) {
        const origin = originOf()({ column, rows });
        const want = WANT_ROW[name];
        if (want) {
          expect({ label, origin }).toEqual({
            label,
            origin: { from: 'snapshot', row: want.row, rtkRecorded: want.rtkRecorded },
          });
        } else if (column.kind === 'refused') {
          expect(origin.from).toBe('history');
          const refusedProblems = (origin as { refused: string[] | null }).refused;
          expect(refusedProblems).toEqual(column.problems);
        } else {
          expect({ label, origin }).toEqual({ label, origin: { from: 'history', refused: null } });
        }
      }
    },
  );

  // The design's table: each value a column can hold, read as a reader reads it, against each state
  // of the rows. A column the schema accepts is the origin whatever the rows say, and one it refuses
  // or one that is absent leaves the rows, then the history, exactly as they were.
  const VALUES: [string, unknown, 'column' | 'refused' | 'absent'][] = [
    ['a full column', full(), 'column'],
    ['a portable-only column', portableOnly(), 'column'],
    ['an empty object', {}, 'refused'],
    ['an unknown key', { ...full(), somethingNew: 1 }, 'refused'],
    ['no rtkChoiceRecorded', without(full(), 'rtkChoiceRecorded'), 'refused'],
    ['null', null, 'absent'],
    ['undefined', undefined, 'absent'],
  ];

  it.each(Object.entries(ROWS))('crosses every column value with the rows: %s', (name, rows) => {
    for (const [label, value, kind] of VALUES) {
      const origin = originOf()({ column: readColumn()(value), rows });
      const want = WANT_ROW[name];
      if (kind === 'column') {
        const column = value as Record<string, unknown>;
        expect({ label, origin }).toEqual({
          label,
          origin: { from: 'column', column, rtkRecorded: column.rtkChoiceRecorded },
        });
      } else if (want) {
        expect({ label, origin }).toEqual({
          label,
          origin: { from: 'snapshot', row: want.row, rtkRecorded: want.rtkRecorded },
        });
      } else {
        expect({ label, from: origin.from }).toEqual({ label, from: 'history' });
        const refused = (origin as { refused: string[] | null }).refused;
        if (kind === 'refused') expect(refused?.length ?? 0).toBeGreaterThan(0);
        else expect(refused).toBeNull();
      }
    }
  });

  it('takes the newest recorded row among several, whatever order the rows come in', () => {
    const rows = [row('a', 1, true, true), row('b', 3, true, null), row('c', 2, true, true)];
    for (const order of [rows, [...rows].reverse()]) {
      expect(originOf()({ column: { kind: 'absent' }, rows: order })).toEqual({
        from: 'snapshot',
        row: row('c', 2, true, true),
        rtkRecorded: true,
      });
    }
  });
});

describe('S2: historyOrigin', () => {
  it('reads a repository with no completed onboarding as blank when it is, and as nothing otherwise', () => {
    expect(historyOf()({ onboarding: null, source: 'blank' })).toEqual({ kind: 'blank' });
    expect(historyOf()({ onboarding: null, source: 'git_https' })).toEqual({ kind: 'none' });
    expect(historyOf()({ onboarding: null, source: 'local_path' })).toEqual({ kind: 'none' });
  });

  it('reads a completed onboarding with no step 07 output as nothing, blank or not', () => {
    for (const source of ['blank', 'git_https']) {
      for (const rtkRecorded of [true, false]) {
        expect(historyOf()({ onboarding: { detected: false, rtkRecorded }, source })).toEqual({
          kind: 'none',
        });
      }
    }
  });

  it('reads a completed onboarding with step 07 output as that output, with its RTK flag', () => {
    for (const source of ['blank', 'git_https']) {
      expect(historyOf()({ onboarding: { detected: true, rtkRecorded: true }, source })).toEqual({
        kind: 'onboarding',
        rtkRecorded: true,
      });
      expect(historyOf()({ onboarding: { detected: true, rtkRecorded: false }, source })).toEqual({
        kind: 'onboarding',
        rtkRecorded: false,
      });
    }
  });
});

describe('S3: pickSnapshotRow', () => {
  // The table of 01's pickRenderSnapshot (upgrade-plan-classify.test.ts), on the facts shape.
  it('renders from a row that recorded an RTK choice ahead of one from before RTK', () => {
    const recorded = row('c', 1, true, true);
    expect(pickRow()([row('a', 0, false, false), row('b', 2, true, null), recorded])).toEqual(
      recorded,
    );
    expect(pickRow()([row('a', 0, true, null)])).toEqual(row('a', 0, true, null));
    expect(pickRow()([row('a', 0, false, false)])).toBeNull();
    expect(pickRow()([])).toBeNull();
  });

  it('takes the newest recorded row, whatever order the rows come in, and the higher id on a tie', () => {
    const older = row('a', 1, true, true);
    const newer = row('b', 2, true, true);
    expect(pickRow()([older, newer])).toEqual(newer);
    expect(pickRow()([newer, older])).toEqual(newer);
    expect(pickRow()([row('a', 1, true, true), row('b', 1, true, true)])).toEqual(
      row('b', 1, true, true),
    );
  });

  it('takes the newest row with a snapshot when none recorded a choice, and dates a row with no date last', () => {
    expect(pickRow()([row('a', 1, true, null), row('b', 2, true, null)])).toEqual(
      row('b', 2, true, null),
    );
    expect(pickRow()([row('a', null, true, null), row('b', 1, true, null)])).toEqual(
      row('b', 1, true, null),
    );
  });

  it('does not change the rows it is given', () => {
    const rows = [row('a', 1, true, true), row('b', 2, true, true)];
    const before = JSON.stringify(rows);
    pickRow()(rows);
    expect(JSON.stringify(rows)).toBe(before);
  });
});

describe('S4: renderContextProviderNames', () => {
  it("gives the column's own names when it holds them", () => {
    expect(namesOf()(full(), ['gemini'])).toEqual(['claude-code', 'codex']);
  });

  it('gives its own names even when it holds none', () => {
    expect(namesOf()({ ...full(), enabledCliProviders: [] }, ['claude-code'])).toEqual([]);
  });

  it("gives the caller's enabled names when the column holds no list", () => {
    expect(namesOf()(portableOnly(), ['gemini', 'codex'])).toEqual(['gemini', 'codex']);
    expect(namesOf()(portableOnly(), [])).toEqual([]);
  });
});
