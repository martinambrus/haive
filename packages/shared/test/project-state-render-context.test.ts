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
  customAgentSpecs: [{ id: 'billing-expert', title: 'Billing expert', tools: ['Read'] }],
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
