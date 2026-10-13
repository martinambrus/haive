import { describe, expect, it } from 'vitest';
import { resolveModulePage } from './module-pages';

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
