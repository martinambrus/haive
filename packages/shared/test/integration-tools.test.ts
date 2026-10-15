import { describe, expect, it, vi } from 'vitest';
import type { schema } from '@haive/database';
import { CORE_FORGE_PROVIDER_SPECS } from '../src/forge/provider-specs.js';
import {
  integrationTools,
  parseIntegrationBindings,
  type IntegrationBinding,
} from '../src/integrations/index.js';
import type { IntegrationOperation } from '../src/modularity/index.js';

type StoredBindings = NonNullable<(typeof schema.cliInvocations.$inferInsert)['integrations']>;

const TOOL_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const CONNECTIONS = [
  '5b0f9c1e-1111-4111-8111-111111111111',
  '7d3a2b4f-2222-4222-8222-222222222222',
  '9e8c6a10-3333-4333-8333-333333333333',
] as const;

const op = (opId: string, access: 'read' | 'write'): IntegrationOperation => ({
  opId,
  description: `${opId} description`,
  inputSchema: { type: 'object' },
  access,
});

function bind(
  requirementId: string,
  providerId: string,
  access: IntegrationBinding['access'],
  connection = 0,
): IntegrationBinding {
  return {
    requirementId,
    categoryId: 'forge',
    providerId,
    connectionId: CONNECTIONS[connection]!,
    access,
  };
}

const CORE = new Map(CORE_FORGE_PROVIDER_SPECS.map((spec) => [spec.id, spec]));
const coreSpecOf = (providerId: string) => CORE.get(providerId);
const coreOp = (opId: string) => CORE.get('github')!.operations!.find((o) => o.opId === opId)!;

const specsOf =
  (table: Record<string, IntegrationOperation[] | undefined>) => (providerId: string) =>
    providerId in table ? { operations: table[providerId] } : undefined;

const names = (tools: ReadonlyMap<string, unknown>): string[] => [...tools.keys()];
const switchIs = (writeAllowed: boolean) => ({ writeAllowed: () => writeAllowed });

describe('integrationTools', () => {
  it('offers a read binding the read operations alone, whatever the write switch says', () => {
    const read = bind('forge', 'github', 'read');

    for (const writeAllowed of [false, true]) {
      const tools = integrationTools([read], coreSpecOf, switchIs(writeAllowed));

      expect(names(tools)).toEqual(['get_pull_request_state']);
      expect(tools.get('get_pull_request_state')).toEqual({
        binding: read,
        op: coreOp('get_pull_request_state'),
      });
    }
  });

  it('withholds the write operation from a write binding whose switch is off', () => {
    const write = bind('forge', 'github', 'write');
    const tools = integrationTools([write], coreSpecOf, switchIs(false));

    expect(names(tools)).toEqual(['get_pull_request_state']);
    expect(tools.has('open_pull_request')).toBe(false);
  });

  it('offers a write binding whose switch is on both operations, in the spec order', () => {
    const write = bind('forge', 'github', 'write');
    const tools = integrationTools([write], coreSpecOf, switchIs(true));

    expect(tools).toBeInstanceOf(Map);
    expect(names(tools)).toEqual(['open_pull_request', 'get_pull_request_state']);
    expect(tools.get('open_pull_request')).toEqual({
      binding: write,
      op: coreOp('open_pull_request'),
    });
  });

  it('asks the switch about each binding on its own', () => {
    const one = bind('one', 'p', 'write', 0);
    const two = bind('two', 'p', 'write', 1);
    const writeAllowed = vi.fn((binding: IntegrationBinding) => binding === two);

    const tools = integrationTools([one, two], specsOf({ p: [op('save', 'write')] }), {
      writeAllowed,
    });

    expect(names(tools)).toEqual(['two_save']);
    expect(tools.get('two_save')?.binding).toBe(two);
    expect(writeAllowed).toHaveBeenCalledWith(one);
    expect(writeAllowed).toHaveBeenCalledWith(two);
  });

  it('prefixes both names with the requirement id when two bindings offer the same operation', () => {
    const bindings = [bind('source', 'github', 'write', 0), bind('mirror', 'gitlab', 'write', 1)];
    const tools = integrationTools(bindings, coreSpecOf, switchIs(true));

    expect(names(tools)).toEqual([
      'source_open_pull_request',
      'source_get_pull_request_state',
      'mirror_open_pull_request',
      'mirror_get_pull_request_state',
    ]);
    expect(tools.get('mirror_open_pull_request')?.binding.providerId).toBe('gitlab');
    expect(tools.get('source_get_pull_request_state')?.op.opId).toBe('get_pull_request_state');
  });

  it('gives the same names in the same order for the same input', () => {
    const bindings = [bind('source', 'github', 'write', 0), bind('mirror', 'gitlab', 'write', 1)];
    const first = integrationTools(bindings, coreSpecOf, switchIs(true));
    const second = integrationTools(bindings, coreSpecOf, switchIs(true));

    expect(names(second)).toEqual(names(first));
    expect([...second.entries()]).toEqual([...first.entries()]);
  });

  it('prefixes only the names two bindings share', () => {
    const specs = specsOf({
      p1: [op('list_items', 'read'), op('create_item', 'write')],
      p2: [op('list_items', 'read'), op('archive_item', 'write')],
    });
    const bindings = [bind('one', 'p1', 'write', 0), bind('two', 'p2', 'write', 1)];

    expect(names(integrationTools(bindings, specs, switchIs(true)))).toEqual([
      'one_list_items',
      'create_item',
      'two_list_items',
      'archive_item',
    ]);
  });

  it('keeps every name where it was when a write switch flips', () => {
    const specs = specsOf({
      p1: [op('save', 'write'), op('list_items', 'read')],
      p2: [op('save', 'write')],
    });
    const bindings = [bind('one', 'p1', 'write', 0), bind('two', 'p2', 'write', 1)];
    const everything = integrationTools(bindings, specs, switchIs(true));

    expect(names(everything)).toEqual(['one_save', 'list_items', 'two_save']);
    for (const writeAllowed of [
      (binding: IntegrationBinding) => binding.requirementId === 'one',
      (binding: IntegrationBinding) => binding.requirementId === 'two',
      () => false,
    ]) {
      const fewer = integrationTools(bindings, specs, { writeAllowed });
      for (const [name, tool] of fewer) expect(everything.get(name), name).toEqual(tool);
    }
    expect(names(integrationTools(bindings, specs, switchIs(false)))).toEqual(['list_items']);
  });

  it('offers a read binding no write operation even when the switch is on for it', () => {
    const specs = specsOf({ p: [op('list_items', 'read'), op('save', 'write')] });

    expect(names(integrationTools([bind('docs', 'p', 'read')], specs, switchIs(true)))).toEqual([
      'list_items',
    ]);
  });

  it('treats an operation whose access is neither read nor write as a write', () => {
    const specs = specsOf({ p: [op('purge', 'delete' as never)] });

    expect(names(integrationTools([bind('docs', 'p', 'write')], specs, switchIs(false)))).toEqual(
      [],
    );
    expect(names(integrationTools([bind('docs', 'p', 'read')], specs, switchIs(true)))).toEqual([]);
    expect(names(integrationTools([bind('docs', 'p', 'write')], specs, switchIs(true)))).toEqual([
      'purge',
    ]);
  });

  it.each([...CORE.keys()])('gives every %s operation a name the CLIs accept', (providerId) => {
    const alone = integrationTools(
      [bind('forge', providerId, 'write')],
      coreSpecOf,
      switchIs(true),
    );
    const shared = integrationTools(
      [bind('source', providerId, 'write', 0), bind('mirror', providerId, 'write', 1)],
      coreSpecOf,
      switchIs(true),
    );

    expect(names(alone)).toEqual(['open_pull_request', 'get_pull_request_state']);
    expect(names(shared)).toHaveLength(4);
    for (const name of [...names(alone), ...names(shared)]) expect(name).toMatch(TOOL_NAME);
  });

  it('maps the separators an operation id may hold and keeps the vendor id on the operation', () => {
    const specs = specsOf({ p: [op('search.pages', 'read'), op('get-page', 'read')] });
    const tools = integrationTools([bind('docs', 'p', 'read')], specs, switchIs(false));

    expect(names(tools)).toEqual(['search_pages', 'get_page']);
    expect(tools.get('search_pages')?.op.opId).toBe('search.pages');
  });

  it('offers no operation whose name cannot take the grammar', () => {
    const specs = specsOf({
      p: [
        op('2fa_enable', 'read'),
        op('x'.repeat(41), 'read'),
        op('x'.repeat(40), 'read'),
        op('fine', 'read'),
      ],
    });
    const tools = integrationTools([bind('docs', 'p', 'read')], specs, switchIs(false));

    expect(names(tools)).toEqual(['x'.repeat(40), 'fine']);
  });

  it('offers a prefixed name up to 40 characters and none beyond', () => {
    const fits = bind('source-repository', 'github', 'read', 0);
    const tooLong = bind('source-repository2', 'gitlab', 'read', 1);
    const tools = integrationTools([fits, tooLong], coreSpecOf, switchIs(false));

    expect(names(tools)).toEqual(['source_repository_get_pull_request_state']);
    expect('source_repository_get_pull_request_state').toHaveLength(40);
    expect(tools.get('source_repository_get_pull_request_state')?.binding).toBe(fits);
  });

  it('never lets one operation replace another that took its name', () => {
    const specs = specsOf({ p: [op('get.page', 'read'), op('get-page', 'read')] });
    const tools = integrationTools([bind('docs', 'p', 'read')], specs, switchIs(false));

    expect(tools.size).toBe(1);
    expect([...tools.values()][0]?.op.opId).toBe('get.page');
  });

  it('offers nothing for a provider with no spec, or a spec with no operations', () => {
    const specs = specsOf({ 'mcp-only': undefined });
    const bindings = [bind('a', 'missing', 'write', 0), bind('b', 'mcp-only', 'write', 1)];

    expect(integrationTools(bindings, specs, switchIs(true)).size).toBe(0);
    expect(integrationTools([], coreSpecOf, switchIs(true)).size).toBe(0);
  });
});

describe('parseIntegrationBindings', () => {
  const GOOD = bind('source', 'github', 'write');
  const without = (key: keyof IntegrationBinding): Record<string, unknown> => {
    const copy: Record<string, unknown> = { ...GOOD };
    delete copy[key];
    return copy;
  };

  it('reads and writes the type the cli_invocations.integrations column stores', () => {
    // Checked by `pnpm typecheck`: either side drifting from the other stops compiling here.
    const column: StoredBindings = [GOOD, { ...bind('docs', 'p', 'read', 1), categoryId: null }];
    const bindings: IntegrationBinding[] = column;

    expect(parseIntegrationBindings(bindings)).toEqual(column);
  });

  it('gives back what was stored, in order, and drops a key it does not know', () => {
    const second = { ...bind('docs', 'p', 'read', 1), categoryId: null };
    const stored = JSON.parse(JSON.stringify([GOOD, second])) as unknown[];
    (stored[0] as Record<string, unknown>).source = 'task';

    expect(parseIntegrationBindings(stored)).toStrictEqual([GOOD, second]);
  });

  it.each([
    ['a missing connection id', without('connectionId')],
    ['a connection id that is not a uuid', { ...GOOD, connectionId: 'conn-1' }],
    ['an access outside read and write', { ...GOOD, access: 'admin' }],
    ['no access', without('access')],
    ['a numeric provider id', { ...GOOD, providerId: 5 }],
    ['a provider id outside the grammar', { ...GOOD, providerId: 'Git Hub' }],
    ['an empty requirement id', { ...GOOD, requirementId: '' }],
    ['a requirement id outside the grammar', { ...GOOD, requirementId: 'Source Repo' }],
    ['no category key', without('categoryId')],
    ['a category outside the grammar', { ...GOOD, categoryId: 'Git Forge' }],
    ['a category no module or core declares', { ...GOOD, categoryId: 'banana' }],
    ['null', null],
    ['a number', 5],
    ['a string', 'github'],
    ['an array', []],
    ['an empty object', {}],
  ])('drops %s and keeps the entries around it', (_name, bad) => {
    const before = bind('first', 'github', 'read', 0);
    const after = bind('last', 'gitlab', 'write', 1);

    expect(parseIntegrationBindings([before, bad, after])).toEqual([before, after]);
  });

  it('keeps a binding pinned to a provider, which has no category', () => {
    const pinned = { ...GOOD, categoryId: null };

    expect(parseIntegrationBindings([pinned])).toEqual([pinned]);
  });

  it.each([[null], [undefined], [5], ['github'], [true], [{}], [{ 0: GOOD, length: 1 }]])(
    'reads %j as no bindings',
    (stored) => {
      expect(parseIntegrationBindings(stored)).toEqual([]);
    },
  );

  it('leaves a dropped entry with no tools', () => {
    const stored = [{ ...GOOD, access: 'admin' }];

    expect(
      integrationTools(parseIntegrationBindings(stored), coreSpecOf, switchIs(true)).size,
    ).toBe(0);
  });
});
