// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProjectStateConflictsBanner } from './project-state-conflicts-banner';
import { cleanup, render, screen } from '@testing-library/react';

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
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it('links pending project questions to the encoded repository data page', async () => {
  render(<ProjectStateConflictsBanner repositoryId="a/b ?#" />);
  expect((await screen.findByRole('link', { name: 'Open Haive data' })).getAttribute('href')).toBe(
    '/repos/a%2Fb%20%3F%23/haive-data',
  );
});

it('can suppress self-navigation on the Haive data page', async () => {
  render(<ProjectStateConflictsBanner repositoryId="repo" showHaiveDataLink={false} />);
  await screen.findByText('Question about the project record');
  expect(screen.queryByRole('link', { name: 'Open Haive data' })).toBeNull();
});

it('does not create an empty banner or a link when no questions remain', async () => {
  h.get.mockResolvedValue({ conflicts: [] });
  const { container } = render(<ProjectStateConflictsBanner repositoryId="repo" />);
  await import('@testing-library/react').then(({ waitFor }) =>
    waitFor(() => expect(h.get).toHaveBeenCalled()),
  );
  expect(screen.queryByRole('link', { name: 'Open Haive data' })).toBeNull();
  expect(container.childElementCount).toBe(0);
});
