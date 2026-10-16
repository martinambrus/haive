import { describe, expect, it } from 'vitest';
import { moduleManifestSchema } from '../src/modularity/index.js';
import {
  DEVICE,
  OAUTH,
  TOKEN,
  fixtureManifest,
  fixtureProvider,
  fixtureStep,
  without,
  type Raw,
} from './module-integrations-fixtures.js';

const parse = (value: unknown) => moduleManifestSchema.safeParse(value);
const messagesOf = (value: unknown): string[] => {
  const result = parse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
};

const DOCS = 'module.fx.docs';
const long = (moduleId: string, length: number) => `module.${moduleId}.${'x'.repeat(length)}`;

const withProvider = (over: Raw): Raw =>
  fixtureManifest('fx', { integrations: [fixtureProvider('fx', over)] });
const withCategories = (categories: Raw[]): Raw => fixtureManifest('fx', { categories });
const withStep = (integrations: Raw[]): Raw =>
  fixtureManifest('fx', { composableSteps: [fixtureStep('sync-docs', integrations)] });
const category = (id: string): Raw => ({ id, label: `Label of ${id}` });
const need = (target: Raw): Raw => ({ id: 'need', access: 'read', ...target });

interface Row {
  rule: string;
  name: string;
  /** false: pinned beyond the brief, tagged [K1+] and left out of the message comparison. */
  brief: boolean;
  manifest: () => Raw;
}

const row = (rule: string, name: string, manifest: () => Raw, brief = true): Row => ({
  rule,
  name,
  brief,
  manifest,
});

const REFUSALS: Row[] = [
  row('prefix', 'a provider id of another module', () => withProvider({ id: 'module.other.crm' })),
  row('prefix', 'a declared category id of another module', () =>
    withCategories([category(DOCS), category('module.other.docs')]),
  ),
  row(
    'prefix',
    'a provider id of the core grammar, which would claim a core provider',
    () => withProvider({ id: 'github' }),
    false,
  ),
  row('outside-categories', 'a provider filling a category of another module', () =>
    withProvider({ categories: ['module.other.docs'] }),
  ),
  row(
    'outside-categories',
    'a provider filling a category of its own prefix it does not declare',
    () => withProvider({ categories: ['module.fx.undeclared'] }),
  ),
  row('forge', 'a provider in the forge category', () =>
    withProvider({ categories: [DOCS, 'forge'] }),
  ),
  row('mcp', 'a remote mcp surface', () =>
    withProvider({ mcp: { kind: 'remote', url: 'https://mcp.fx.example/sse' } }),
  ),
  row('mcp', 'a stdio mcp surface', () =>
    withProvider({ mcp: { kind: 'stdio', package: '@fx/mcp', version: '1.0.0' } }),
  ),
  row('self-hosted', 'selfHosted: true', () => withProvider({ selfHosted: true })),
  row('sign-in', 'a token method alone', () => withProvider({ auth: [TOKEN] })),
  row('sign-in', 'an oauth2 method with no userInfo', () =>
    withProvider({ auth: [without(OAUTH, 'userInfo')] }),
  ),
  row('sign-in', 'an oauth2 method with userInfo that is not preregistered', () =>
    withProvider({ auth: [{ ...OAUTH, clientRegistration: ['dcr'] }] }),
  ),
  row('sign-in', 'a device method with no userInfo', () =>
    withProvider({ auth: [without(DEVICE, 'userInfo')] }),
  ),
  row('sign-in', 'an oauth2 method with no userInfo beside a token method', () =>
    withProvider({ auth: [without(OAUTH, 'userInfo'), TOKEN] }),
  ),
  row('duplicate', 'two providers with one id', () =>
    fixtureManifest('fx', { integrations: [fixtureProvider('fx'), fixtureProvider('fx')] }),
  ),
  row('duplicate', 'two categories with one id', () =>
    withCategories([category(DOCS), category(DOCS)]),
  ),
  row('requirement', 'a step requiring an undeclared category of its own prefix', () =>
    withStep([need({ category: 'module.fx.nothing' })]),
  ),
  row('requirement', 'a step requiring a category of another module', () =>
    withStep([need({ category: 'module.other.docs' })]),
  ),
  row('requirement', 'a step requiring an undeclared provider of its own prefix', () =>
    withStep([need({ provider: 'module.fx.nothing' })]),
  ),
  row('requirement', 'a step requiring a provider of another module', () =>
    withStep([need({ provider: 'module.other.crm' })]),
  ),
  row('length', 'a provider id whose local part is 65 characters', () =>
    withProvider({ id: long('fx', 65) }),
  ),
  row('length', 'a category id whose local part is 65 characters', () =>
    withCategories([category(DOCS), category(long('fx', 65))]),
  ),
  row(
    'api-hosts',
    'a provider with no apiHosts',
    () => withProvider({ apiHosts: undefined }),
    false,
  ),
  row(
    'api-hosts',
    'a provider with an empty apiHosts list',
    () => withProvider({ apiHosts: [] }),
    false,
  ),
  row(
    'api-hosts',
    'an apiHosts entry that is a url',
    () => withProvider({ apiHosts: ['https://api.fx.example'] }),
    false,
  ),
  row(
    'api-hosts',
    'an apiHosts entry that is an http url',
    () => withProvider({ apiHosts: ['http://api.fx.example'] }),
    false,
  ),
  row(
    'api-hosts',
    'an apiHosts entry with a path',
    () => withProvider({ apiHosts: ['api.fx.example/v1'] }),
    false,
  ),
  row('api-hosts', 'an empty apiHosts entry', () => withProvider({ apiHosts: [''] }), false),
];

describe('a module manifest declaring integration providers and categories', () => {
  describe('what it accepts', () => {
    it('[K1] accepts a provider and a category, and keeps both with the hosts', () => {
      const manifest = fixtureManifest();
      const result = parse(manifest);

      expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
      expect((result.data as Raw).integrations).toEqual(manifest.integrations);
      expect((result.data as Raw).categories).toEqual(manifest.categories);
    });

    it('[K0] accepts a provider whose only sign-in is a device code with userInfo', () => {
      expect(parse(withProvider({ auth: [DEVICE] })).success).toBe(true);
    });

    it('[K0] accepts local ids of exactly 64 characters', () => {
      const provider = long('fx', 64);
      const categoryId = `module.fx.${'y'.repeat(64)}`;
      const manifest = fixtureManifest('fx', {
        categories: [category(DOCS), category(categoryId)],
        integrations: [fixtureProvider('fx', { id: provider, categories: [categoryId] })],
      });

      expect(parse(manifest).success).toBe(true);
    });

    it('[K0] accepts a step requiring a category and a provider the manifest declares', () => {
      const manifest = withStep([
        need({ category: DOCS }),
        { id: 'pinned', provider: 'module.fx.crm', access: 'read' },
        { id: 'mail', category: 'mail', access: 'read', optional: true },
      ]);

      expect(parse(manifest).success).toBe(true);
    });

    it('[K0] accepts an oauth2 method that lists preregistered among other registrations', () => {
      expect(
        parse(withProvider({ auth: [{ ...OAUTH, clientRegistration: ['dcr', 'preregistered'] }] }))
          .success,
      ).toBe(true);
    });

    it('[K0] accepts a provider with core categories only and no categories list', () => {
      const manifest = without(
        fixtureManifest('fx', {
          integrations: [fixtureProvider('fx', { categories: ['rich-documents', 'mail'] })],
        }),
        'categories',
      );

      expect(parse(manifest).success).toBe(true);
    });

    it('[K0] accepts a categories list with no providers, and several hosts', () => {
      expect(parse(without(fixtureManifest(), 'integrations')).success).toBe(true);
      expect(
        parse(withProvider({ apiHosts: ['api.fx.example', 'files.fx.example', 'a-b.fx.example'] }))
          .success,
      ).toBe(true);
    });

    it('[K0] accepts a manifest with neither key and adds neither to what it returns', () => {
      const result = parse({ id: 'plain', name: 'Plain', version: '1', schemaVersion: 1 });

      expect(result.success).toBe(true);
      expect(Object.keys(result.data as Raw)).toEqual(['id', 'name', 'version', 'schemaVersion']);
    });
  });

  describe('what it refuses', () => {
    for (const { rule, name, brief, manifest } of REFUSALS) {
      it(`[K1${brief ? '' : '+'}] refuses ${name} (${rule})`, () => {
        const mutated = manifest();

        expect(parse(fixtureManifest()).success, 'the unmodified fixture is accepted').toBe(true);
        expect(parse(mutated).success, 'the manifest was accepted').toBe(false);
      });
    }

    it('[K1] gives each rule a message of its own', () => {
      const byRule = new Map<string, Set<string>>();
      for (const { rule, brief, manifest } of REFUSALS) {
        // The brief gives eight rules a message each; the length cap of an id is not one of them.
        if (!brief || rule === 'length') continue;
        const own = byRule.get(rule) ?? new Set<string>();
        for (const message of messagesOf(manifest())) own.add(message);
        byRule.set(rule, own);
      }

      const rules = [...byRule.keys()];
      for (const rule of rules) {
        expect(
          byRule.get(rule)!.size,
          `rule "${rule}" was refused with no message`,
        ).toBeGreaterThan(0);
      }
      const spelled = (rule: string) => [...byRule.get(rule)!].sort().join(' | ');
      for (const [index, rule] of rules.entries()) {
        for (const other of rules.slice(index + 1)) {
          expect(
            spelled(rule),
            `rules "${rule}" and "${other}" are refused with the same message`,
          ).not.toBe(spelled(other));
        }
      }
    });
  });
});
