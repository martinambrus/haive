// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://localhost:3000/tasks/task"}
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { EditorTab } from './editor-tab';

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ api: { post } }));
vi.mock('@/components/task-source', () => ({ TaskSource: () => <div>Files</div> }));
vi.mock('@/components/markdown/markdown-view', () => ({
  MarkdownView: ({ body }: { body: string }) => <div data-testid="markdown">{body}</div>,
}));

afterEach(cleanup);

it('explains a plain HTTP editor on the same hostname as an HTTPS app', async () => {
  expect(window.location.origin).toBe('https://localhost:3000');
  post.mockImplementation(async (path: string) =>
    path.endsWith('/ensure-ide')
      ? { enabled: true, ready: true }
      : { url: 'http://localhost:3001/ide/_handshake#secret' },
  );
  render(<EditorTab taskId="task" />);
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  expect(screen.queryByTitle('Editor')).toBeNull();
  expect(screen.getByTestId('markdown').textContent).toContain('Serve the editor over HTTPS');
});
