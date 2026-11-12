// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const { post, loadOrigin } = vi.hoisted(() => ({ post: vi.fn(), loadOrigin: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ api: { post } }));
vi.mock('@/lib/editor-origin', async (importOriginal) => {
  loadOrigin();
  return importOriginal();
});
vi.mock('@/components/task-source', () => ({ TaskSource: () => null }));
vi.mock('@/components/markdown/markdown-view', () => ({
  MarkdownView: ({ body }: { body: string }) => <div>{body}</div>,
}));
afterEach(cleanup);

it('opens a same-host HTTP grant without importing editor-origin', async () => {
  const url = new URL('/ide/_handshake#single-use', window.location.origin);
  url.port = '3001';
  post.mockImplementation(async (path: string) =>
    path.endsWith('/ensure-ide') ? { enabled: true, ready: true } : { url: url.href },
  );
  // Import inside the test so even eager module evaluation is observed.
  const { EditorTab } = await import('./editor-tab');
  render(<EditorTab taskId="task" />);
  await act(async () => {});
  expect(screen.getByTitle('Editor').getAttribute('src')).toBe(url.href);
  expect(loadOrigin).not.toHaveBeenCalled();
});
