import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ModulePageProps } from '@haive/web-kit/host';
import { api } from '@/lib/api-client';
import ModulePage from './page';

const received: ModulePageProps[] = [];
const route = vi.hoisted(() => ({ moduleId: 'stats', page: ['detail'] as string[] }));
const listing = vi.hoisted(() => ({
  modules: null as { id: string; compiledWeb: boolean; pages: Record<string, never> }[] | null,
  error: null as string | null,
}));

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('not found');
  },
  useParams: () => route,
}));

vi.mock('@/lib/use-modules', () => ({ useModules: () => listing }));

vi.mock('@/generated/module-pages', () => ({
  moduleWebPages: {
    stats: {
      detail: (props: ModulePageProps) => {
        received.push(props);
        return <p>page-{props.moduleId}</p>;
      },
    },
  },
}));

describe('module route page', () => {
  beforeEach(() => {
    received.length = 0;
    route.moduleId = 'stats';
    route.page = ['detail'];
    listing.modules = [{ id: 'stats', compiledWeb: true, pages: {} }];
    listing.error = null;
  });

  it('passes the host api to the resolved page component', () => {
    expect(renderToStaticMarkup(<ModulePage />)).toBe('<p>page-stats</p>');
    expect(received).toHaveLength(1);
    expect(received[0]!.moduleId).toBe('stats');
    expect(received[0]!.path).toEqual(['detail']);
    expect(received[0]!.api).toBe(api);
  });

  it('shows a loading state, not a 404, for a path no compiled page owns', () => {
    route.moduleId = 'acme';
    route.page = ['overview'];
    listing.modules = null;
    expect(renderToStaticMarkup(<ModulePage />)).toContain('Loading...');
  });

  it('holds a compiled page back until the module list has loaded', () => {
    listing.modules = null;
    const html = renderToStaticMarkup(<ModulePage />);
    expect(html).toContain('Loading...');
    expect(html).not.toContain('page-stats');
    expect(received).toHaveLength(0);
  });

  it('answers not-found for a compiled page of a module the list leaves out', () => {
    listing.modules = [{ id: 'other', compiledWeb: true, pages: {} }];
    expect(() => renderToStaticMarkup(<ModulePage />)).toThrow('not found');
    expect(received).toHaveLength(0);
  });

  it('answers not-found for a compiled page of a module whose compiled web parts the list withholds', () => {
    listing.modules = [{ id: 'stats', compiledWeb: false, pages: {} }];
    expect(() => renderToStaticMarkup(<ModulePage />)).toThrow('not found');
    expect(received).toHaveLength(0);
  });

  it('shows why the list failed instead of a compiled page it could not confirm', () => {
    listing.modules = null;
    listing.error = 'Failed to load modules.';
    const html = renderToStaticMarkup(<ModulePage />);
    expect(html).toContain('Failed to load modules.');
    expect(html).not.toContain('page-stats');
    expect(received).toHaveLength(0);
  });
});
