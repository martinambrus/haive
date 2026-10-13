import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ModulePageProps } from '@haive/web-kit/host';
import { api } from '@/lib/api-client';
import ModulePage from './page';

const received: ModulePageProps[] = [];

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('not found');
  },
  useParams: () => ({ moduleId: 'stats', page: ['detail'] }),
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
});
