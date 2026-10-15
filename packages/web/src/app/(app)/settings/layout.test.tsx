import { describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { TabNav } from '@/components/tabs';
import SettingsLayout from './layout';

const route = vi.hoisted(() => ({ pathname: '/settings/integrations' }));

vi.mock('next/navigation', () => ({ usePathname: () => route.pathname }));
vi.mock('@/lib/use-modules', () => ({ useModules: () => ({ modules: [], error: null }) }));

type El = ReactElement<{ children?: ReactNode; active?: string }>;

const flatten = (node: ReactNode): El[] =>
  Array.isArray(node)
    ? node.flatMap(flatten)
    : isValidElement<El['props']>(node)
      ? [node, ...flatten(node.props.children)]
      : [];

const activeTab = (pathname: string) => {
  route.pathname = pathname;
  return flatten(SettingsLayout({ children: null })).find((e) => e.type === TabNav)?.props.active;
};

describe('the settings tabs', () => {
  it.each([
    '/settings/integrations',
    '/settings/integrations/preferred',
    '/settings/integrations/callback/github',
  ])('mark Integrations active on %s', (pathname) => {
    expect(activeTab(pathname)).toBe('/settings/integrations');
  });

  it('mark the tab a sibling path belongs to, not Integrations', () => {
    expect(activeTab('/settings/credentials')).toBe('/settings/credentials');
  });
});
