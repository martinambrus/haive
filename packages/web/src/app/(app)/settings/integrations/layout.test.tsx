import { describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { TabNav, type TabItem } from '@/components/tabs';
import IntegrationsLayout from './layout';

const route = vi.hoisted(() => ({ pathname: '/settings/integrations' }));

vi.mock('next/navigation', () => ({ usePathname: () => route.pathname }));

type El = ReactElement<{
  children?: ReactNode;
  items?: TabItem[];
  active?: string;
  variant?: string;
}>;

const flatten = (node: ReactNode): El[] =>
  Array.isArray(node)
    ? node.flatMap(flatten)
    : isValidElement<El['props']>(node)
      ? [node, ...flatten(node.props.children)]
      : [];

const textOf = (node: ReactNode): string =>
  Array.isArray(node)
    ? node.map(textOf).join('')
    : isValidElement<El['props']>(node)
      ? textOf(node.props.children)
      : typeof node === 'string'
        ? node
        : '';

const render = (pathname: string) => {
  route.pathname = pathname;
  const tree = IntegrationsLayout({ children: 'the page' });
  return { tabs: flatten(tree).find((e) => e.type === TabNav), text: textOf(tree) };
};

describe('the Integrations sub-tabs', () => {
  it('offer Connections and Preferred by kind as the nested pill bar', () => {
    const { tabs } = render('/settings/integrations');
    expect(tabs?.props.items?.map((item) => [item.label, item.href])).toEqual([
      ['Connections', '/settings/integrations'],
      ['Preferred by kind', '/settings/integrations/preferred'],
    ]);
    expect(tabs?.props.variant).toBe('pill');
  });

  it('mark the page being shown and keep it under them', () => {
    expect(render('/settings/integrations').tabs?.props.active).toBe('/settings/integrations');
    const preferred = render('/settings/integrations/preferred');
    expect(preferred.tabs?.props.active).toBe('/settings/integrations/preferred');
    expect(preferred.text).toBe('the page');
  });

  it('stay off the sign-in callback, which is neither tab', () => {
    const callback = render('/settings/integrations/callback/github');
    expect(callback.tabs).toBeUndefined();
    expect(callback.text).toBe('the page');
  });
});
