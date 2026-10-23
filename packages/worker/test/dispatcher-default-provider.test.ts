import { describe, expect, it } from 'vitest';
import { resolveDefaultCliProvider } from '@haive/shared';
import { dispatchCandidates, resolveDispatch } from '../src/orchestrator/dispatcher.js';
import type { CliProviderRecord } from '../src/cli-adapters/types.js';

type Overrides = Partial<CliProviderRecord> & Pick<CliProviderRecord, 'id' | 'name' | 'createdAt'>;

function makeProvider(overrides: Overrides): CliProviderRecord {
  return {
    userId: 'user-1',
    label: `${overrides.name} label`,
    executablePath: null,
    wrapperPath: null,
    envVars: null,
    cliArgs: null,
    supportsSubagents: false,
    authMode: 'subscription',
    enabled: true,
    updatedAt: overrides.createdAt,
    ...overrides,
  } as CliProviderRecord;
}

const at = (iso: string): Date => new Date(iso);

const permutations = <T>(items: readonly T[]): T[][] =>
  items.length <= 1
    ? [[...items]]
    : items.flatMap((item, i) =>
        permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
      );

const sequence = (providers: CliProviderRecord[], preferred: string | null): string[] =>
  [...dispatchCandidates(providers, preferred, { needsVision: false })].map((c) => c.provider.id);

const firstOf = (providers: CliProviderRecord[], preferred: string | null): string | null =>
  sequence(providers, preferred)[0] ?? null;

describe('the default provider when nothing is preferred', () => {
  const oldest = makeProvider({
    id: 'z',
    name: 'claude-code',
    createdAt: at('2026-01-01T00:00:00Z'),
  });
  const middle = makeProvider({ id: 'm', name: 'gemini', createdAt: at('2026-02-01T00:00:00Z') });
  const newest = makeProvider({ id: 'a', name: 'codex', createdAt: at('2026-03-01T00:00:00Z') });

  it('is the oldest enabled provider for every list order, on every call', () => {
    for (const order of permutations([oldest, middle, newest])) {
      for (let i = 0; i < 25; i++) {
        expect(sequence([...order], null)).toEqual(['z', 'm', 'a']);
      }
    }
  });

  it('breaks a createdAt tie by the lowest id', () => {
    const high = makeProvider({ id: 'bbb', name: 'gemini', createdAt: at('2026-01-01T00:00:00Z') });
    const low = makeProvider({
      id: 'aaa',
      name: 'claude-code',
      createdAt: at('2026-01-01T00:00:00Z'),
    });
    expect(sequence([high, low], null)).toEqual(['aaa', 'bbb']);
    expect(sequence([low, high], null)).toEqual(['aaa', 'bbb']);
  });

  it('never picks a disabled older provider', () => {
    const off = makeProvider({
      id: 'off',
      name: 'amp',
      createdAt: at('2025-01-01T00:00:00Z'),
      enabled: false,
    });
    for (const order of permutations([off, middle, newest])) {
      expect(sequence(order, null)).toEqual(['m', 'a']);
    }
  });

  it('keeps a named enabled preferred provider first and the rest in priority order', () => {
    for (const order of permutations([oldest, middle, newest])) {
      expect(sequence(order, 'a')).toEqual(['a', 'z', 'm']);
      expect(sequence(order, 'm')).toEqual(['m', 'z', 'a']);
    }
  });

  it('falls to the default when the preferred id is disabled or unknown', () => {
    const off = makeProvider({
      id: 'off',
      name: 'amp',
      createdAt: at('2025-01-01T00:00:00Z'),
      enabled: false,
    });
    for (const order of permutations([off, newest, oldest, middle])) {
      expect(sequence(order, 'off')).toEqual(['z', 'm', 'a']);
      expect(sequence(order, 'no-such-id')).toEqual(['z', 'm', 'a']);
    }
  });

  it('falls through a provider that cannot host MCP by priority, not list order', () => {
    const noMcp = makeProvider({ id: 'q', name: 'amp', createdAt: at('2025-12-01T00:00:00Z') });
    for (const order of permutations([noMcp, oldest, middle, newest])) {
      const plan = resolveDispatch({
        providers: order,
        preferredProviderId: null,
        requiresMcp: true,
        input: { kind: 'prompt', prompt: 'p', capabilities: [] },
        invokeOpts: {},
      });
      expect(plan.providerId).toBe('z');
    }
  });
});

describe('dispatch parity with the shared default provider', () => {
  const p = (
    id: string,
    name: CliProviderRecord['name'],
    iso: string,
    enabled = true,
  ): CliProviderRecord => makeProvider({ id, name, createdAt: at(iso), enabled });

  const table: [string, CliProviderRecord[], string | null][] = [
    [
      'newest first',
      [p('n', 'gemini', '2026-03-01T00:00:00Z'), p('o', 'codex', '2026-01-01T00:00:00Z')],
      'o',
    ],
    [
      'a tie',
      [p('bb', 'gemini', '2026-01-01T00:00:00Z'), p('aa', 'codex', '2026-01-01T00:00:00Z')],
      'aa',
    ],
    [
      'a disabled oldest',
      [p('d', 'amp', '2025-01-01T00:00:00Z', false), p('e', 'codex', '2026-01-01T00:00:00Z')],
      'e',
    ],
    ['a single provider', [p('s', 'gemini', '2026-01-01T00:00:00Z')], 's'],
    ['none enabled', [p('x', 'gemini', '2026-01-01T00:00:00Z', false)], null],
    ['an empty list', [], null],
    [
      'three, mixed',
      [
        p('c', 'claude-code', '2026-02-01T00:00:00Z'),
        p('b', 'gemini', '2026-02-01T00:00:00Z'),
        p('a', 'codex', '2026-02-02T00:00:00Z'),
      ],
      'b',
    ],
  ];

  for (const [what, providers, expected] of table) {
    it(`agrees on ${what}`, () => {
      expect(firstOf(providers, null)).toBe(expected);
      expect(resolveDefaultCliProvider(providers)?.id ?? null).toBe(expected);
    });
  }
});
