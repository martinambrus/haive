// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { HostApi } from '@haive/web-kit/host';
import { buildFilesRead, type FilesReadGroupRow } from '@haive/shared/stats';
import { StatsPage } from '../../../modules/statistics/src/web/stats-page';
import { filesReadMessage } from '../../../modules/statistics/src/web/components/files-read-section';
import { MarkdownView } from '@/components/markdown/markdown-view';

const SEARCH = 'preset=7d&tab=tools&repositoryId=repo1';
const h = vi.hoisted(() => ({ search: '', replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: h.replace }),
  useSearchParams: () => new URLSearchParams(h.search),
}));
vi.mock('@haive/web-kit/use-page-title', () => ({ usePageTitle: () => undefined }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
beforeEach(() => {
  h.search = SEARCH;
});
afterEach(() => {
  cleanup();
  h.replace.mockReset();
});

const FAILED = filesReadMessage({ repositoryId: 'repo1', report: null, failed: true })!;

const GROUP: FilesReadGroupRow = {
  stepId: '05-implement',
  provider: 'claude-code',
  runs: 2,
  inFlight: 0,
  recorded: 2,
  observable: 2,
  partial: 0,
  weighted: 2,
  fileReads: 3,
  fileChars: 400,
  weightedChars: 400,
  overflowOmitted: 0,
  overflowRuns: 0,
  overflowReads: 0,
  overflowChars: 0,
  overflowWeightedChars: 0,
  multiFileRuns: 0,
  multiFileReads: 0,
  multiFileChars: 0,
  multiFileWeightedChars: 0,
  shareRuns: 0,
  shareWeightedChars: 0,
  shareInputTokens: 0,
  shareOutputTokens: 0,
  shareCacheReadTokens: 0,
  shareCacheCreationTokens: 0,
};

/** The route's answer for a window whose only read file is `path`. */
const answer = (path: string) => ({
  range: { from: 'a', to: 'b', timeZone: 'UTC' },
  scope: { repositoryId: 'repo1', cliProviderId: null, taskClass: null, allUsers: false },
  available: true,
  ...buildFilesRead({
    paths: {
      rows: [
        { path, reads: 3, chars: 400, weightedChars: 400, weightedRuns: 2, runs: 2, tasks: 1 },
      ],
      count: 1,
    },
    groups: [GROUP],
  }),
});

/** A host api whose files-read answers are scripted; `sent` holds the path of every request. */
function fakeApi(filesRead: (path: string, call: number) => Promise<unknown>) {
  const sent: string[] = [];
  const get = vi.fn(async (path: string): Promise<unknown> => {
    if (path === '/user-settings/ui-prefs') return { settingsJson: '{}' };
    if (path === '/repos') return { repositories: [] };
    if (path.includes('/settings/')) return { values: {} };
    if (path.includes('/files-read')) {
      sent.push(path);
      return filesRead(path, sent.length);
    }
    return null;
  });
  return { api: { get } as unknown as HostApi, sent };
}

const page = (api: HostApi) => (
  <StatsPage moduleId="statistics" path={[]} api={api} MarkdownView={MarkdownView} />
);

it('retries a failed request from the card and renders the report it then gets', async () => {
  const { api, sent } = fakeApi(async (_path, call) => {
    if (call === 1) throw new Error('boom');
    return answer('src/retried.ts');
  });
  render(page(api));
  await screen.findByText(FAILED);
  expect(sent).toHaveLength(1);

  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByText('src/retried.ts');
  expect(sent).toHaveLength(2);
  expect(sent[1]).toBe(sent[0]);
  expect(screen.queryByText(FAILED)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
});

it.each(['resolve', 'reject'] as const)(
  'drops the late %s of a request for an old window after a retry',
  async (how) => {
    let late!: { resolve: (value: unknown) => void; reject: (error: Error) => void };
    const { api, sent } = fakeApi((path, call) => {
      if (call === 1) return Promise.reject(new Error('boom'));
      if (path.includes('repositoryId=repo2')) return Promise.resolve(answer('src/new.ts'));
      return new Promise((resolve, reject) => {
        late = { resolve, reject };
      });
    });
    const view = render(page(api));
    await screen.findByText(FAILED);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(late).toBeDefined());

    h.search = 'preset=7d&tab=tools&repositoryId=repo2';
    view.rerender(page(api));
    await screen.findByText('src/new.ts');
    await act(async () => {
      if (how === 'resolve') late.resolve(answer('src/old.ts'));
      else late.reject(new Error('late'));
    });

    expect(screen.getByText('src/new.ts')).toBeTruthy();
    expect(screen.queryByText('src/old.ts')).toBeNull();
    expect(screen.queryByText(FAILED)).toBeNull();
    expect(sent).toHaveLength(3);
  },
);
