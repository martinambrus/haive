import { describe, expect, it } from 'vitest';
import { FolderGit2, Puzzle } from 'lucide-react';
import {
  ADMIN_NAV_ITEM,
  BASE_NAV_ITEMS,
  navItemsFor,
} from '../src/components/sidebar/nav-items.js';
import type { ModuleSummary } from '../src/lib/api-client.js';

const mod = (id: string, nav: ModuleSummary['nav']): ModuleSummary => ({
  id,
  name: id,
  version: '1.0.0',
  nav,
  pages: {},
  hasGlobalSettings: false,
  hasAdminSettings: false,
  compiledWeb: true,
});

const hrefs = (items: { href: string }[]) => items.map((i) => i.href);
const rendered = BASE_NAV_ITEMS.map(({ order: _order, ...item }) => item);

describe('navItemsFor', () => {
  it('is exactly today list when no modules are installed', () => {
    expect(navItemsFor('user')).toEqual(rendered);
    expect(navItemsFor('user', [])).toEqual(rendered);
    expect(navItemsFor('admin', [])).toEqual([...rendered, ADMIN_NAV_ITEM]);
  });

  it('puts module items after the base items and before Admin', () => {
    const items = navItemsFor('admin', [mod('a', [{ href: '/m/a', label: 'A' }])]);
    expect(hrefs(items)).toEqual([...hrefs(BASE_NAV_ITEMS), '/m/a', '/admin']);
    expect(hrefs(navItemsFor('user', [mod('a', [{ href: '/m/a', label: 'A' }])])).at(-1)).toBe(
      '/m/a',
    );
  });

  it('sorts by order, unordered after ordered, then by label', () => {
    const items = navItemsFor('user', [
      mod('x', [
        { href: '/m/x/z', label: 'Zeta' },
        { href: '/m/x/b2', label: 'Beta', order: 102 },
        { href: '/m/x/a', label: 'Alpha' },
      ]),
      mod('y', [{ href: '/m/y/b1', label: 'First', order: 101 }]),
    ]);
    expect(hrefs(items).slice(BASE_NAV_ITEMS.length)).toEqual([
      '/m/y/b1',
      '/m/x/b2',
      '/m/x/a',
      '/m/x/z',
    ]);
  });

  it('resolves a known icon name and falls back to a generic icon', () => {
    const items = navItemsFor('user', [
      mod('a', [
        { href: '/m/a/1', label: 'One', icon: 'FolderGit2', order: 101 },
        { href: '/m/a/2', label: 'Two', icon: 'no-such-icon', order: 102 },
        { href: '/m/a/3', label: 'Three', order: 103 },
      ]),
    ]);
    const [one, two, three] = items.slice(BASE_NAV_ITEMS.length);
    expect(one!.icon).toBe(FolderGit2);
    expect(two!.icon).toBe(Puzzle);
    expect(three!.icon).toBe(Puzzle);
  });

  describe('module items among the built-ins', () => {
    const labelsWith = (order: number | undefined) =>
      navItemsFor('admin', [mod('a', [{ href: '/m/a', label: 'Mod', order }])]).map((i) => i.label);

    it('lands order 45 between CLI Providers and Settings', () => {
      const labels = labelsWith(45);
      expect(labels.indexOf('Mod')).toBe(labels.indexOf('CLI Providers') + 1);
      expect(labels.indexOf('Mod')).toBe(labels.indexOf('Settings') - 1);
    });

    it('lands order 60 right after Settings', () => {
      const labels = labelsWith(60);
      expect(labels.indexOf('Mod')).toBe(labels.indexOf('Settings') + 1);
    });

    it('lands no order after Settings, and Admin stays last', () => {
      const labels = labelsWith(undefined);
      expect(labels.indexOf('Mod')).toBe(labels.indexOf('Settings') + 1);
      expect(labels.at(-1)).toBe('Admin');
      expect(labelsWith(45).at(-1)).toBe('Admin');
      expect(labelsWith(60).at(-1)).toBe('Admin');
    });

    it('does not put order on the rendered items', () => {
      for (const item of navItemsFor('user')) expect(item).not.toHaveProperty('order');
    });
  });
});
