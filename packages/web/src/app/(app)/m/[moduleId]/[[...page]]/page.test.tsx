import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ModulePageProps } from '@haive/web-kit/host';
import { api } from '@/lib/api-client';
import ModulePage from './page';

const received: ModulePageProps[] = [];
const route = vi.hoisted(() => ({ moduleId: 'stats', page: ['detail'] as string[] }));

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('not found');
  },
  useParams: () => route,
}));

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
    try {
      expect(renderToStaticMarkup(<ModulePage />)).toContain('Loading...');
    } finally {
      route.moduleId = 'stats';
      route.page = ['detail'];
    }
  });
});
