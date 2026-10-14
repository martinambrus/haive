import { describe, expect, it } from 'vitest';
import type { DashboardSpec } from '@haive/shared/modularity';
import { resolveModulePage, resolveModuleRoute } from './module-pages';

const Index = () => null;
const Detail = () => null;
const registry = { stats: { '': Index, 'detail/one': Detail } };

describe('resolveModulePage', () => {
  it('maps no path segments to the index page', () => {
    expect(resolveModulePage(registry, 'stats', [])).toBe(Index);
    expect(resolveModulePage(registry, 'stats', undefined)).toBe(Index);
  });

  it('joins the path segments with a slash', () => {
    expect(resolveModulePage(registry, 'stats', ['detail', 'one'])).toBe(Detail);
  });

  it('returns null for an unknown module or page', () => {
    expect(resolveModulePage(registry, 'other', [])).toBeNull();
    expect(resolveModulePage(registry, 'stats', ['missing'])).toBeNull();
    expect(resolveModulePage({}, 'stats', [])).toBeNull();
  });

  it('does not reach Object.prototype through a module id or a path', () => {
    expect(resolveModulePage(registry, 'constructor', [])).toBeNull();
    expect(resolveModulePage(registry, '__proto__', [])).toBeNull();
    expect(resolveModulePage(registry, 'stats', ['constructor'])).toBeNull();
  });
});

describe('resolveModuleRoute', () => {
  const spec: DashboardSpec = { title: 'Overview', widgets: [{ type: 'markdown', body: 'x' }] };
  const modules: { id: string; compiledWeb: boolean; pages: Record<string, DashboardSpec> }[] = [
    { id: 'stats', compiledWeb: true, pages: { overview: spec, '': spec } },
    { id: 'acme', compiledWeb: true, pages: { overview: spec } },
    { id: 'bare', compiledWeb: true, pages: {} },
  ];

  it('lets the compiled page win over a declared page of the same path', () => {
    const route = resolveModuleRoute(registry, modules, 'stats', []);
    expect(route).toEqual({ kind: 'component', Page: Index });
    expect(resolveModuleRoute(registry, modules, 'stats', ['detail', 'one'])).toEqual({
      kind: 'component',
      Page: Detail,
    });
  });

  it('renders a compiled page only for a module the list names', () => {
    const withoutStats = modules.filter((m) => m.id !== 'stats');
    expect(resolveModuleRoute(registry, withoutStats, 'stats', [])).toEqual({ kind: 'not-found' });
    expect(resolveModuleRoute(registry, withoutStats, 'stats', ['detail', 'one'])).toEqual({
      kind: 'not-found',
    });
    expect(resolveModuleRoute(registry, [], 'stats', [])).toEqual({ kind: 'not-found' });
  });

  it('renders a compiled page only for a module whose compiled web parts the list allows', () => {
    const withheld = modules.map((m) => (m.id === 'stats' ? { ...m, compiledWeb: false } : m));
    expect(resolveModuleRoute(registry, withheld, 'stats', [])).toEqual({ kind: 'not-found' });
    expect(resolveModuleRoute(registry, withheld, 'stats', ['detail', 'one'])).toEqual({
      kind: 'not-found',
    });
    expect(resolveModuleRoute(registry, modules, 'stats', [])).toEqual({
      kind: 'component',
      Page: Index,
    });
  });

  it('falls back to the declared page of a path whose compiled page is withheld', () => {
    const Overview = () => null;
    const compiled = { acme: { overview: Overview } };
    const listed = (compiledWeb: boolean) => [
      { id: 'acme', compiledWeb, pages: { overview: spec } },
    ];
    expect(resolveModuleRoute(compiled, listed(false), 'acme', ['overview'])).toEqual({
      kind: 'dashboard',
      spec,
    });
    expect(resolveModuleRoute(compiled, listed(true), 'acme', ['overview'])).toEqual({
      kind: 'component',
      Page: Overview,
    });
  });

  it('finds a declared page of exactly one segment', () => {
    expect(resolveModuleRoute(registry, modules, 'acme', ['overview'])).toEqual({
      kind: 'dashboard',
      spec,
    });
  });

  it('waits for the module list before deciding, a compiled page included', () => {
    expect(resolveModuleRoute(registry, null, 'acme', ['overview'])).toEqual({ kind: 'loading' });
    expect(resolveModuleRoute(registry, null, 'stats', [])).toEqual({ kind: 'loading' });
    expect(resolveModuleRoute(registry, null, 'stats', ['detail', 'one'])).toEqual({
      kind: 'loading',
    });
  });

  it('answers not-found for a nested path, an unknown module or page, and the module root', () => {
    expect(resolveModuleRoute(registry, modules, 'acme', ['overview', 'more'])).toEqual({
      kind: 'not-found',
    });
    expect(resolveModuleRoute(registry, modules, 'nope', ['overview'])).toEqual({
      kind: 'not-found',
    });
    expect(resolveModuleRoute(registry, modules, 'acme', ['missing'])).toEqual({
      kind: 'not-found',
    });
    expect(resolveModuleRoute(registry, modules, 'acme', [])).toEqual({ kind: 'not-found' });
  });

  it('does not reach Object.prototype through a page id', () => {
    expect(resolveModuleRoute(registry, modules, 'bare', ['constructor'])).toEqual({
      kind: 'not-found',
    });
    expect(resolveModuleRoute(registry, modules, 'bare', ['__proto__'])).toEqual({
      kind: 'not-found',
    });
  });
});
