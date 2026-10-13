import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ModuleDashboardWidgets } from './module-dashboard';
import { api } from './api-client';

const Alpha = ({ moduleId }: { moduleId: string }) => <p>alpha-{moduleId}</p>;
const Beta = ({ moduleId }: { moduleId: string }) => <p>beta-{moduleId}</p>;

describe('ModuleDashboardWidgets', () => {
  it('renders nothing for an empty list', () => {
    expect(renderToStaticMarkup(<ModuleDashboardWidgets widgets={[]} />)).toBe('');
  });

  it('renders each widget with its module id, in order', () => {
    const html = renderToStaticMarkup(
      <ModuleDashboardWidgets
        widgets={[
          { moduleId: 'stats', id: 'a', Component: Alpha },
          { moduleId: 'other', id: 'b', Component: Beta },
        ]}
      />,
    );
    expect(html).toBe('<p>alpha-stats</p><p>beta-other</p>');
  });

  it('accepts two widgets with the same id from different modules', () => {
    const html = renderToStaticMarkup(
      <ModuleDashboardWidgets
        widgets={[
          { moduleId: 'x', id: 'w', Component: Alpha },
          { moduleId: 'y', id: 'w', Component: Alpha },
        ]}
      />,
    );
    expect(html).toBe('<p>alpha-x</p><p>alpha-y</p>');
  });

  it('passes the host api to each widget', () => {
    const seen: unknown[] = [];
    const Probe = (props: { moduleId: string; api: unknown }) => {
      seen.push(props.api);
      return null;
    };
    renderToStaticMarkup(
      <ModuleDashboardWidgets
        widgets={[
          { moduleId: 'x', id: 'p', Component: Probe },
          { moduleId: 'y', id: 'p', Component: Probe },
        ]}
      />,
    );
    expect(seen).toEqual([api, api]);
    expect(seen[0]).toBe(api);
    expect(seen[1]).toBe(api);
  });
});
