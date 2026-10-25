import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { configService } from '@haive/shared';
import { runPrPollTick } from '../src/queues/pr-poll-queue.js';
const h = vi.hoisted(() => ({ resolve: vi.fn(), state: vi.fn() }));
vi.mock('../src/forge/index.js', async (original) => ({
  ...(await original<typeof import('../src/forge/index.js')>()),
  resolveForgeContext: h.resolve,
  resolveForgeProvider: () => ({ getPullRequestState: h.state }),
}));
afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  h.resolve.mockReset();
  h.state.mockReset();
});
function fixture(
  opts: {
    prRemoteUrl?: string | null;
    repoRemote?: string | null;
    matchingStep?: boolean;
    resetStep?: boolean;
  } = {},
) {
  vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
  h.resolve.mockResolvedValue({ provider: 'github', host: 'github.com' });
  h.state.mockResolvedValue({ state: 'open' });
  const writes: Record<string, unknown>[] = [];
  const remoteUrl = 'https://github.com/acme/app.git';
  const db = {
    query: {
      tasks: {
        findMany: async () => [
          {
            id: 'task',
            userId: 'user',
            repositoryId: 'repo',
            prNumber: '7',
            prCredentialId: 'cred',
            prState: 'open',
            prUrl: 'https://github.com/acme/app/pull/7',
            prRemoteUrl: opts.prRemoteUrl ?? null,
          },
        ],
      },
      repositories: {
        findFirst: vi.fn(async () => ({
          source: 'local_path',
          remoteUrl: opts.repoRemote ?? null,
        })),
      },
      taskSteps: {
        findFirst: vi.fn(async () =>
          opts.resetStep
            ? undefined
            : {
                detectOutput: { originUrl: remoteUrl },
                output: {
                  action: 'create_pr',
                  prUrl:
                    opts.matchingStep === false
                      ? 'https://github.com/acme/other/pull/7'
                      : 'https://github.com/acme/app/pull/7',
                },
              },
        ),
      },
    },
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          writes.push(values);
        },
      }),
    }),
  };
  return { db, writes, remoteUrl };
}
it('polls and stamps the origin used to open a local_path PR when remote_url is NULL', async () => {
  const { db, writes, remoteUrl } = fixture();
  await runPrPollTick(db as never);
  expect(h.resolve).toHaveBeenCalledWith(expect.objectContaining({ remoteUrl }));
  expect(h.state).toHaveBeenCalled();
  expect(writes[0]?.prPollError).toBeNull();
  expect(writes[0]?.prRemoteUrl).toBe(remoteUrl);
});
it('keeps a recorded PR origin after the repository is relinked and step output reset', async () => {
  const recorded = 'https://github.com/original/app.git';
  const { db } = fixture({
    prRemoteUrl: recorded,
    repoRemote: 'https://github.com/new/app.git',
    resetStep: true,
  });
  await runPrPollTick(db as never);
  expect(h.resolve).toHaveBeenCalledWith(expect.objectContaining({ remoteUrl: recorded }));
  expect(db.query.taskSteps.findFirst).not.toHaveBeenCalled();
  expect(db.query.repositories.findFirst).not.toHaveBeenCalled();
});
it('uses the matching legacy PR step before a relinked repository address', async () => {
  const { db, remoteUrl } = fixture({ repoRemote: 'https://github.com/new/app.git' });
  await runPrPollTick(db as never);
  expect(h.resolve).toHaveBeenCalledWith(expect.objectContaining({ remoteUrl }));
});
it('does not borrow another PR origin from step output', async () => {
  const { db, writes } = fixture({ matchingStep: false });
  await runPrPollTick(db as never);
  expect(h.resolve).not.toHaveBeenCalled();
  expect(writes[0]?.prPollError).toMatch(/no remote URL/);
});
it('retains repository fallback for older PRs without usable step output', async () => {
  const remote = 'https://github.com/legacy/app.git';
  const { db } = fixture({ resetStep: true, repoRemote: remote });
  await runPrPollTick(db as never);
  expect(h.resolve).toHaveBeenCalledWith(expect.objectContaining({ remoteUrl: remote }));
});
it('records a legacy lookup failure instead of silently dropping the poll', async () => {
  const { db, writes } = fixture();
  db.query.taskSteps.findFirst.mockRejectedValueOnce(new Error('lookup unavailable'));
  await runPrPollTick(db as never);
  expect(writes[0]?.prPollError).toBe('lookup unavailable');
  expect(h.state).not.toHaveBeenCalled();
});
