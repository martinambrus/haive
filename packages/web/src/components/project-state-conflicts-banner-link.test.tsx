import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProjectStateConflictsBanner } from './project-state-conflicts-banner';
import { createRenderer, findAll } from '../../test/render-tree';

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  ...(await import('../../test/render-tree')).reactHooks,
}));
vi.mock('next/link', () => ({ default: 'a' }));
vi.mock('@/components/markdown/markdown-view', () => ({
  MarkdownView: ({ body }: { body: string }) => <div>{body}</div>,
}));
const h = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ api: { get: h.get } }));
const conflict = {
  id: 'question',
  unit: 'settings/rtk-enabled.json',
  key: null,
  base: { present: true, value: true },
  local: { present: true, value: true },
  incoming: { present: true, value: false },
  detectedAt: '2026-10-12T08:00:00.000Z',
  resolution: null,
  resolvedAt: null,
};
beforeEach(() => {
  h.get.mockResolvedValue({ conflicts: [conflict] });
});
afterEach(() => vi.resetAllMocks());

it('links pending project questions to the encoded repository data page', async () => {
  const view = createRenderer(() => <ProjectStateConflictsBanner repositoryId="a/b ?#" />);
  await view.flush();
  expect(findAll(view.tree(), (node) => node.tag === 'a').map((node) => node.props.href)).toContain(
    '/repos/a%2Fb%20%3F%23/haive-data',
  );
});

it('can suppress self-navigation on the Haive data page', async () => {
  const view = createRenderer(() => (
    <ProjectStateConflictsBanner repositoryId="repo" showHaiveDataLink={false} />
  ));
  await view.flush();
  expect(findAll(view.tree(), (node) => node.tag === 'a')).toHaveLength(0);
});

it('does not create an empty banner or a link when no questions remain', async () => {
  h.get.mockResolvedValue({ conflicts: [] });
  const view = createRenderer(() => <ProjectStateConflictsBanner repositoryId="repo" />);
  await view.flush();
  expect(findAll(view.tree(), (node) => node.tag === 'a')).toHaveLength(0);
  expect(view.tree().kids).toHaveLength(0);
});
