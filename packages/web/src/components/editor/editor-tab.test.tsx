// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorTab } from './editor-tab';

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('@/lib/api-client', () => ({
  api: { post },
}));
vi.mock('@/components/task-source', () => ({ TaskSource: () => <div>Files</div> }));
vi.mock('@/components/markdown/markdown-view', () => ({
  MarkdownView: ({ body }: { body: string }) => <div data-testid="markdown">{body}</div>,
}));

const url = 'http://localhost:3001/ide/_handshake#single-use';
const refusal = (status: number) => Object.assign(new Error('**Editor refused**'), { status });
const settle = async () => {
  await act(async () => {});
};

beforeEach(() => {
  vi.useFakeTimers();
  post.mockReset();
  post.mockImplementation(async (path: string) =>
    path.endsWith('/ensure-ide') ? { enabled: true, ready: true } : { url },
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('EditorTab grants', () => {
  it.each([{ taskId: 'task' }, { repositoryId: 'repo' }])(
    'opens the exact bootstrap URL after ensure for %o',
    async (props) => {
      render(<EditorTab {...props} />);
      await settle();
      const prefix = 'taskId' in props ? '/tasks/task' : '/repos/repo';
      expect(post.mock.calls.map(([path]) => path)).toEqual([
        `${prefix}/ensure-ide`,
        `${prefix}/editor-handshake`,
      ]);
      expect(screen.getByTitle('Editor').getAttribute('src')).toBe(url);
    },
  );

  it('waits for ensure readiness before minting', async () => {
    post.mockResolvedValueOnce({ enabled: true, pending: true });
    render(<EditorTab taskId="task" />);
    await settle();
    expect(post).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(2500));
    expect(post.mock.calls.map(([path]) => path)).toEqual([
      '/tasks/task/ensure-ide',
      '/tasks/task/ensure-ide',
      '/tasks/task/editor-handshake',
    ]);
  });

  it.each([403, 404, 409])('shows grant %s as a final markdown refusal', async (status) => {
    post
      .mockResolvedValueOnce({ enabled: true, ready: true })
      .mockRejectedValueOnce(refusal(status));
    render(<EditorTab taskId="task" />);
    await settle();
    expect(screen.getByTestId('markdown').textContent).toBe('**Editor refused**');
    expect(screen.queryByTitle('Editor')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(post).toHaveBeenCalledTimes(2);
  });

  it.each([refusal(503), new TypeError('Network unavailable')])(
    'offers manual Retry after a transient grant failure: %s',
    async (error) => {
      post.mockResolvedValueOnce({ enabled: true, ready: true }).mockRejectedValueOnce(error);
      render(<EditorTab taskId="task" />);
      await settle();
      expect(screen.getByTestId('markdown').textContent).toBe(error.message);
      expect(screen.queryByTitle('Editor')).toBeNull();
      await act(() => vi.advanceTimersByTimeAsync(60_000));
      expect(post).toHaveBeenCalledTimes(2);
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await settle();
      expect(post).toHaveBeenCalledTimes(4);
      expect(screen.getByTitle('Editor').getAttribute('src')).toBe(url);
    },
  );

  it('mints once per mounted frame, keeps it on resize and mints anew on reopen', async () => {
    const view = render(
      <StrictMode>
        <EditorTab taskId="task" />
      </StrictMode>,
    );
    await settle();
    const grants = () => post.mock.calls.filter(([path]) => path.endsWith('/editor-handshake'));
    expect(grants()).toHaveLength(1);
    const frame = screen.getByTitle('Editor');
    fireEvent.click(screen.getByRole('button', { name: 'Maximize' }));
    await settle();
    expect(screen.getByTitle('Editor')).toBe(frame);
    expect(grants()).toHaveLength(1);
    view.unmount();
    post.mockImplementation(async (path: string) =>
      path.endsWith('/ensure-ide') ? { enabled: true, ready: true } : { url: url + '-new' },
    );
    render(<EditorTab taskId="task" />);
    await settle();
    expect(grants()).toHaveLength(2);
    expect(screen.getByTitle('Editor').getAttribute('src')).toBe(url + '-new');
  });

  it('ignores a grant that finishes after its target is closed', async () => {
    let resolve!: (value: { url: string }) => void;
    post.mockResolvedValueOnce({ enabled: true, ready: true }).mockReturnValueOnce(
      new Promise<{ url: string }>((done) => {
        resolve = done;
      }),
    );
    const view = render(<EditorTab taskId="task" />);
    await settle();
    view.rerender(<EditorTab repositoryId="repo" />);
    await settle();
    await act(async () => resolve({ url: url + '-stale' }));
    expect(screen.getByTitle('Editor').getAttribute('src')).toBe(url);
  });
});
