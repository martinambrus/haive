import { describe, expect, it } from 'vitest';
import {
  sumCustomToolCalls,
  sumIntegrationCalls,
  type CallOutcomeCounts,
  type CustomToolCallCount,
  type IntegrationCallCount,
} from '../src/stats/tool-usage.js';

const counts = (over: Partial<CallOutcomeCounts> = {}): CallOutcomeCounts => ({
  ok: 0,
  refused: 0,
  error: 0,
  running: 0,
  ...over,
});
const custom = (
  tool: string,
  action: string,
  over: Partial<CallOutcomeCounts> = {},
): CustomToolCallCount => ({ tool, action, ...counts(over) });

const integration = (
  providerId: string,
  tool: string,
  access: 'read' | 'write',
  over: Partial<CallOutcomeCounts> = {},
): IntegrationCallCount => ({ providerId, tool, access, ...counts(over) });
const label = (e: IntegrationCallCount) => `${e.providerId}/${e.tool}/${e.access}`;

describe('sumCustomToolCalls', () => {
  it('is [] for no input', () => {
    expect(sumCustomToolCalls([])).toEqual([]);
    expect(sumCustomToolCalls([[], []])).toEqual([]);
  });

  it('adds every outcome of one identity across lists', () => {
    const merged = sumCustomToolCalls([
      [custom('lookup', 'http-get', { ok: 2, refused: 1 })],
      [custom('lookup', 'http-get', { ok: 3, error: 1, running: 1 })],
    ]);
    expect(merged).toEqual([
      custom('lookup', 'http-get', { ok: 5, refused: 1, error: 1, running: 1 }),
    ]);
  });

  it('adds the entries inside one list too', () => {
    const merged = sumCustomToolCalls([
      [custom('lookup', 'http-get', { ok: 1 }), custom('lookup', 'http-get', { error: 2 })],
    ]);
    expect(merged).toEqual([custom('lookup', 'http-get', { ok: 1, error: 2 })]);
  });

  it('keeps identities that differ in the tool or the action apart', () => {
    const merged = sumCustomToolCalls([
      [custom('lookup', 'http-get', { ok: 1 }), custom('lookup', 'rag-query', { ok: 1 })],
      [custom('notes', 'http-get', { ok: 1 })],
    ]);
    expect(merged.map((e) => `${e.tool}/${e.action}`)).toEqual([
      'lookup/http-get',
      'lookup/rag-query',
      'notes/http-get',
    ]);
  });

  it('keeps apart identities whose parts run together alike', () => {
    const merged = sumCustomToolCalls([
      [custom('a', 'bc', { ok: 1 }), custom('ab', 'c', { ok: 1 }), custom('', 'abc', { ok: 1 })],
    ]);
    expect(merged).toHaveLength(3);
  });

  it('orders by every outcome counted, then tool, then action', () => {
    const merged = sumCustomToolCalls([
      [
        custom('zeta', 'http-get', { ok: 5 }),
        custom('beta', 'http-get', { ok: 2 }),
        custom('alpha', 'rag-query', { ok: 2 }),
        custom('alpha', 'http-get', { refused: 2 }),
        custom('mixed', 'http-get', { ok: 1, refused: 1, error: 1 }),
        custom('gamma', 'http-get', { running: 9 }),
      ],
    ]);
    expect(merged.map((e) => `${e.tool}/${e.action}`)).toEqual([
      'gamma/http-get',
      'zeta/http-get',
      'mixed/http-get',
      'alpha/http-get',
      'alpha/rag-query',
      'beta/http-get',
    ]);
  });

  it('breaks a tie by code unit, as the MCP merge does', () => {
    const merged = sumCustomToolCalls([
      [custom('alpha', 'x', { ok: 1 }), custom('Zed', 'x', { ok: 1 })],
    ]);
    expect(merged.map((e) => e.tool)).toEqual(['Zed', 'alpha']);
  });

  it('leaves its input as it was', () => {
    const first = Object.freeze([Object.freeze(custom('lookup', 'http-get', { ok: 1 }))]);
    const second = Object.freeze([Object.freeze(custom('lookup', 'http-get', { ok: 2 }))]);
    const merged = sumCustomToolCalls([[...first], [...second]]);
    expect(merged).toEqual([custom('lookup', 'http-get', { ok: 3 })]);
    expect(first[0]).toEqual(custom('lookup', 'http-get', { ok: 1 }));
    expect(second[0]).toEqual(custom('lookup', 'http-get', { ok: 2 }));
  });
});

describe('sumIntegrationCalls', () => {
  it('is [] for no input', () => {
    expect(sumIntegrationCalls([])).toEqual([]);
    expect(sumIntegrationCalls([[], []])).toEqual([]);
  });

  it('adds every outcome of one identity across lists', () => {
    const merged = sumIntegrationCalls([
      [integration('github', 'get_pull_request_state', 'read', { ok: 2, refused: 1 })],
      [integration('github', 'get_pull_request_state', 'read', { ok: 3, error: 1, running: 1 })],
    ]);
    expect(merged).toEqual([
      integration('github', 'get_pull_request_state', 'read', {
        ok: 5,
        refused: 1,
        error: 1,
        running: 1,
      }),
    ]);
  });

  it('keeps identities that differ in the provider, the tool or the access apart', () => {
    const merged = sumIntegrationCalls([
      [
        integration('github', 'open_pull_request', 'write', { ok: 1 }),
        integration('github', 'open_pull_request', 'read', { ok: 1 }),
        integration('gitlab', 'open_pull_request', 'write', { ok: 1 }),
      ],
      [integration('github', 'get_pull_request_state', 'read', { ok: 1 })],
    ]);
    expect(merged.map(label)).toEqual([
      'github/get_pull_request_state/read',
      'github/open_pull_request/read',
      'github/open_pull_request/write',
      'gitlab/open_pull_request/write',
    ]);
  });

  it('keeps apart identities whose parts run together alike', () => {
    const merged = sumIntegrationCalls([
      [
        integration('a', 'bc', 'read', { ok: 1 }),
        integration('ab', 'c', 'read', { ok: 1 }),
        integration('', 'abc', 'read', { ok: 1 }),
      ],
    ]);
    expect(merged).toHaveLength(3);
  });

  it('orders by every outcome counted, then provider, then tool, then access', () => {
    const merged = sumIntegrationCalls([
      [
        integration('gitlab', 'get', 'read', { ok: 2 }),
        integration('github', 'open', 'write', { refused: 2 }),
        integration('github', 'open', 'read', { ok: 1, refused: 1 }),
        integration('github', 'get', 'read', { running: 2 }),
        integration('zeta', 'any', 'read', { ok: 1, refused: 1, error: 1 }),
      ],
    ]);
    expect(merged.map(label)).toEqual([
      'zeta/any/read',
      'github/get/read',
      'github/open/read',
      'github/open/write',
      'gitlab/get/read',
    ]);
  });

  it('leaves its input as it was', () => {
    const first = Object.freeze([Object.freeze(integration('github', 'get', 'read', { ok: 1 }))]);
    const second = Object.freeze([
      Object.freeze(integration('github', 'get', 'read', { error: 2 })),
    ]);
    const merged = sumIntegrationCalls([[...first], [...second]]);
    expect(merged).toEqual([integration('github', 'get', 'read', { ok: 1, error: 2 })]);
    expect(first[0]).toEqual(integration('github', 'get', 'read', { ok: 1 }));
    expect(second[0]).toEqual(integration('github', 'get', 'read', { error: 2 }));
  });
});
