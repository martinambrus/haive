import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import NewTaskPage from './page';
import { UploadFailureList } from '@/components/attachments/upload-failure-list';
import {
  buttons,
  controls,
  createRenderer,
  findAll,
  fire,
  isDisabled,
  textOf,
  valueOf,
  type Renderer,
} from '../../../../../test/render-tree';

// No DOM in this package: the page runs through test/render-tree.ts, and the network is a stub of fetch.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('../../../../../test/render-tree')).reactHooks,
}));
const nav = vi.hoisted(() => ({ search: new URLSearchParams(), pushed: [] as string[] }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: (href: string) => {
      nav.pushed.push(href);
    },
  }),
  useSearchParams: () => nav.search,
}));
vi.mock('next/link', async () => {
  const { createElement } = await import('react');
  return {
    default: ({ href, children }: { href: string; children?: unknown }) =>
      createElement('a', { href }, children as never),
  };
});
vi.mock('@/lib/use-page-title', () => ({ usePageTitle: () => {} }));
vi.mock('lucide-react', () => ({ Lock: () => null, Unlock: () => null }));
vi.mock('@/components/markdown/markdown-view', () => ({
  MarkdownView: ({ body }: { body: string }) => body,
}));
vi.mock('@/components/attachments/upload-failure-list', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('@/components/attachments/upload-failure-list')>();
  return { ...real, UploadFailureList: vi.fn(real.UploadFailureList) };
});

const status = (over: Record<string, unknown> = {}) => ({
  onboarded: false,
  nothingToOnboard: false,
  onboardingTaskId: null,
  canMarkOnboarded: false,
  missing: [],
  ...over,
});
const repo = (id: string, name: string) => ({ id, name, status: 'ready', detectedFramework: null });
const localRepo = (id: string, name: string, writable: boolean) => ({
  ...repo(id, name),
  source: 'local_path',
  writable,
});
const taskType = (slug: string, over: Record<string, unknown> = {}) => ({
  slug,
  displayName: slug,
  description: null,
  requiresRepository: true,
  sortOrder: 0,
  restoresDatabase: false,
  dispatchesCli: true,
  available: true,
  ...over,
});
const [P1, P2, P3] = ['cli-1', 'cli-2', 'cli-3'];

const STATUS = (id: string) => `GET /repos/${id}/onboarding-status`;
const MARK = (id: string) => `POST /repos/${id}/mark-onboarded`;
const RESET = (id: string) => `DELETE /repos/${id}/onboarding-artifacts`;
const LAST_CLI = (id = '') => `GET /tasks/last-cli${id ? `?repositoryId=${id}` : ''}`;
const SAVED = (slug: string) => `GET /task-types/${slug}/saved-step-clis`;
const savedStep = (stepId: string, title: string, over: Record<string, unknown> = {}) => ({
  stepId,
  title,
  preferredCliProviderId: null,
  preferredEffortLevel: null,
  ...over,
});
const disabledClis = new Set<string>();
const savedRows: Record<string, unknown[]> = {};
let savedFailure = 0;
let savedDefault: string | null = null;
const GETS: Record<string, unknown> = {
  '/repos': {
    repositories: [
      repo('repo-a', 'Alpha'),
      repo('repo-b', 'Beta'),
      localRepo('repo-ro', 'Read only', false),
      localRepo('repo-rw', 'Writable', true),
    ],
  },
  get '/cli-providers'() {
    return {
      providers: [P1, P2, P3].map((id) => ({
        id,
        name: id,
        label: id,
        enabled: !disabledClis.has(id),
      })),
    };
  },
  '/task-types': {
    taskTypes: [
      taskType('workflow'),
      taskType('run_app'),
      taskType('repoless', { requiresRepository: false }),
      taskType('scoped'),
    ],
  },
};
const last = { cliChoice: null, summaryChoice: null };
const remembered = (providerId: string) => ({
  cliChoice: { providerId },
  summaryChoice: { providerId, llmEnabled: true },
});
const PARENTS: Record<string, unknown[]> = {
  'repo-a': [{ id: 'task-a1', title: 'Alpha feature', type: 'workflow' }],
  'repo-b': [{ id: 'task-b1', title: 'Beta feature', type: 'workflow' }],
};

const held = new Map<string, (code: number, body: unknown) => void>();
const sent: string[] = [];
const posted: Record<string, unknown>[] = [];
let holdLastCli = false;
let holdParents = false;
let holdUploads = false;
let failUploads: Record<string, string> = {};
let failStart = false;
let missingAttachments = false;
let startAnswer: { started: boolean; status: string } | null = null;
const actions: Record<string, unknown>[] = [];

const reply = (code: number, body: unknown) => ({
  ok: code < 400,
  status: code,
  json: async () => structuredClone(body),
});

const HELD =
  /^(GET \/repos\/[^/]+\/onboarding-status|POST \/repos\/[^/]+\/mark-onboarded|DELETE \/repos\/[^/]+\/onboarding-artifacts)$/;

async function fakeFetch(input: unknown, init?: { method?: string; body?: string }) {
  const url = new URL(String(input), 'http://localhost');
  const path = url.pathname;
  const call = `${init?.method ?? 'GET'} ${path}`;
  const key = `${call}${url.search}`;
  sent.push(key);
  if (
    HELD.test(call) ||
    (holdLastCli && path === '/tasks/last-cli') ||
    (holdParents && call === 'GET /tasks') ||
    (holdUploads && call === 'POST /tasks/task-new/attachments')
  ) {
    return new Promise((resolve) => {
      held.set(key, (code, body) => resolve(reply(code, body)));
    });
  }
  if (path === '/tasks/last-cli') return reply(200, last);
  if (call === 'GET /tasks') {
    return reply(200, { tasks: PARENTS[url.searchParams.get('repositoryId') ?? ''] ?? [] });
  }
  if (call === 'POST /tasks/task-new/attachments') {
    const name = url.searchParams.get('filename') ?? '';
    return Object.hasOwn(failUploads, name)
      ? reply(500, { error: failUploads[name] })
      : reply(201, { attachment: { id: name } });
  }
  if (call === 'POST /tasks/task-new/action') {
    const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
    if (missingAttachments && !body.confirmMissingAttachments) {
      actions.push(body);
      return reply(409, {
        error: 'arbitrary copy',
        code: 'task_attachments_missing',
        landed: 1,
        expected: 2,
      });
    }
    if (failStart) return reply(409, { error: 'the queue is draining' });
    if (startAnswer) return reply(200, { ok: true, ...startAnswer });
    actions.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>);
    return reply(200, { ok: true, started: true, status: 'queued' });
  }
  if (call === 'POST /tasks') {
    posted.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>);
    return reply(200, { task: { id: 'task-new' } });
  }
  const savedSlug = /^\/task-types\/([^/]+)\/saved-step-clis$/.exec(path)?.[1];
  if (call.startsWith('GET ') && savedSlug !== undefined && savedSlug in savedRows) {
    return savedFailure
      ? reply(savedFailure, { error: 'saved CLIs failed' })
      : reply(200, { steps: savedRows[savedSlug], defaultProviderId: savedDefault });
  }
  if (call.startsWith('GET ') && path in GETS) return reply(200, GETS[path]);
  return reply(404, { error: `not stubbed: ${call}` });
}

beforeAll(() => vi.stubGlobal('fetch', fakeFetch));
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  held.clear();
  disabledClis.clear();
  for (const key of Object.keys(savedRows)) delete savedRows[key];
  savedFailure = 0;
  savedDefault = null;
  sent.length = 0;
  posted.length = 0;
  holdLastCli = false;
  holdParents = false;
  holdUploads = false;
  failUploads = {};
  failStart = false;
  missingAttachments = false;
  startAnswer = null;
  nav.pushed.length = 0;
  actions.length = 0;
});

async function mount(): Promise<Renderer> {
  const view = createRenderer(() => <NewTaskPage />);
  for (let i = 0; i < 4; i += 1) await view.flush();
  return view;
}

function pick(view: Renderer, repositoryId: string) {
  fire.type(controls(view.tree(), /^repository/)[0]!, repositoryId);
  view.draw();
}

function chooseType(view: Renderer, slug: string) {
  fire.type(controls(view.tree(), /^task type$/)[0]!, slug);
  view.draw();
}

const cliPick = (view: Renderer) => controls(view.tree(), /^cli provider/)[0]!;
const summaryPick = (view: Renderer) => controls(view.tree(), /^summary cli/)[0]!;
const asked = () => sent.filter((call) => call.startsWith('GET /tasks/last-cli'));

async function release(view: Renderer, call: string, code: number, body: unknown) {
  const settle = held.get(call);
  if (!settle) throw new Error(`no request is waiting for ${call}`);
  held.delete(call);
  settle(code, body);
  await view.flush();
}

const answer = (view: Renderer, repositoryId: string, code: number, body: unknown) =>
  release(view, STATUS(repositoryId), code, body);

const page = (view: Renderer) => textOf(view.tree());
const submit = (view: Renderer) => buttons(view.tree(), /^create task$/)[0]!;

async function submitForm(view: Renderer) {
  const form = findAll(view.tree(), (h) => h.tag === 'form')[0]!;
  await (form.props.onSubmit as (e: unknown) => Promise<void>)({ preventDefault: () => {} });
  await view.flush();
}

describe('the onboarding status beside the repository select', () => {
  it('is the answer for the repository now selected, however late an earlier one comes', async () => {
    const view = await mount();
    pick(view, 'repo-a');
    pick(view, 'repo-b');
    await answer(view, 'repo-b', 200, status({ onboarded: true }));
    expect(page(view)).toContain('Will run: workflow');
    await answer(view, 'repo-a', 200, status({ missing: ['knowledge base'] }));
    expect(page(view)).toContain('Will run: workflow');
    expect(page(view)).not.toContain('Missing: knowledge base');
    expect(page(view)).not.toContain('Checking onboarding');
  });

  it('is not replaced by a failure of an earlier repository', async () => {
    const view = await mount();
    pick(view, 'repo-a');
    pick(view, 'repo-b');
    await answer(view, 'repo-b', 200, status({ onboarded: true }));
    await answer(view, 'repo-a', 500, { error: 'status check failed for a' });
    expect(page(view)).toContain('Will run: workflow');
    expect(page(view)).not.toContain('status check failed for a');
  });

  it('is not shown for the selected repository while its own answer is still to come', async () => {
    const view = await mount();
    pick(view, 'repo-a');
    pick(view, 'repo-b');
    await answer(view, 'repo-a', 200, status({ onboarded: true }));
    expect(page(view)).toContain('Checking onboarding');
    expect(page(view)).not.toContain('Will run');
    expect(isDisabled(submit(view))).toBe(true);
    await answer(view, 'repo-b', 200, status({ missing: ['knowledge base'] }));
    expect(page(view)).toContain('Missing: knowledge base');
    expect(page(view)).not.toContain('Checking onboarding');
  });

  it('keeps Create task off once no repository is selected, whatever an earlier one answers', async () => {
    const view = await mount();
    pick(view, 'repo-a');
    pick(view, '');
    await answer(view, 'repo-a', 200, status({ onboarded: true }));
    expect(isDisabled(submit(view))).toBe(true);
    pick(view, 'repo-b');
    expect(isDisabled(submit(view))).toBe(true);
  });

  it('shows the answer of the only request, and stops saying it is checking', async () => {
    const view = await mount();
    pick(view, 'repo-a');
    expect(page(view)).toContain('Checking onboarding');
    await answer(view, 'repo-a', 200, status({ missing: ['knowledge base'] }));
    expect(page(view)).toContain('Missing: knowledge base');
    expect(page(view)).not.toContain('Checking onboarding');
  });

  describe('once the person moves to another repository', () => {
    async function checkedA() {
      const view = await mount();
      pick(view, 'repo-a');
      await answer(view, 'repo-a', 200, status({ onboarded: true }));
      expect(page(view)).toContain('Will run: workflow');
      return view;
    }

    it('keeps Create task off, and offers no Re-run onboarding, until the new one has answered', async () => {
      const view = await checkedA();
      pick(view, 'repo-b');
      expect(page(view)).toContain('Checking onboarding');
      expect(page(view)).not.toContain('Will run');
      expect(buttons(view.tree(), /^re-run onboarding$/)).toHaveLength(0);
      expect(isDisabled(submit(view))).toBe(true);
      await answer(view, 'repo-b', 200, status({ missing: ['knowledge base'] }));
      expect(page(view)).toContain('Will run: onboarding');
      expect(isDisabled(submit(view))).toBe(false);
    });

    it('shows no field that only the verdict of the one it left would show', async () => {
      const view = await checkedA();
      expect(controls(view.tree(), /bug fix/)).toHaveLength(1);
      pick(view, 'repo-b');
      expect(controls(view.tree(), /bug fix/)).toHaveLength(0);
      expect(controls(view.tree(), /^description \(optional\)$/)).toHaveLength(1);
    });

    it('shows no failure of the one it left', async () => {
      const view = await mount();
      pick(view, 'repo-a');
      await answer(view, 'repo-a', 500, { error: 'status check failed for a' });
      expect(page(view)).toContain('status check failed for a');
      pick(view, 'repo-b');
      expect(page(view)).toContain('Checking onboarding');
      expect(page(view)).not.toContain('status check failed for a');
    });

    it('creates no task from the verdict of the one it left', async () => {
      const view = await checkedA();
      fire.type(controls(view.tree(), /^title$/)[0]!, 'A title');
      fire.type(controls(view.tree(), /^description/)[0]!, 'A description');
      pick(view, 'repo-b');
      await submitForm(view);
      expect(sent).not.toContain('POST /tasks');
      expect(page(view)).toContain('Waiting for onboarding status check');
    });
  });

  describe('when the check fails', () => {
    const retry = (view: Renderer) => buttons(view.tree(), /^retry$/);
    const asks = (repositoryId: string) =>
      sent.filter((call) => call === STATUS(repositoryId)).length;
    function clickRetry(view: Renderer) {
      expect(retry(view)).toHaveLength(1);
      fire.click(retry(view)[0]!);
      view.draw();
    }
    async function failedForBoth() {
      const view = await mount();
      pick(view, 'repo-a');
      await answer(view, 'repo-a', 500, { error: 'status check failed for a' });
      pick(view, 'repo-b');
      await answer(view, 'repo-b', 500, { error: 'status check failed for b' });
      return view;
    }

    it('keeps Create task off, and offers Retry beside the failure', async () => {
      const view = await failedForBoth();
      expect(page(view)).toContain('status check failed for b');
      expect(isDisabled(submit(view))).toBe(true);
      expect(retry(view)).toHaveLength(1);
    });

    it('asks again for the repository now selected, and shows that answer', async () => {
      const view = await failedForBoth();
      clickRetry(view);
      expect([asks('repo-a'), asks('repo-b')]).toEqual([1, 2]);
      expect(page(view)).toContain('Checking onboarding');
      expect(page(view)).not.toContain('status check failed for b');
      expect(isDisabled(submit(view))).toBe(true);
      await answer(view, 'repo-b', 200, status({ onboarded: true }));
      expect(page(view)).toContain('Will run: workflow');
      expect(isDisabled(submit(view))).toBe(false);
    });

    it('offers Retry again when the second ask fails too', async () => {
      const view = await failedForBoth();
      clickRetry(view);
      await answer(view, 'repo-b', 500, { error: 'status check failed again for b' });
      expect(page(view)).toContain('status check failed again for b');
      clickRetry(view);
      await answer(view, 'repo-b', 200, status({ onboarded: true }));
      expect(page(view)).toContain('Will run: workflow');
    });

    it('does not show the answer to a Retry under a repository the person moved to meanwhile', async () => {
      const view = await failedForBoth();
      clickRetry(view);
      pick(view, 'repo-a');
      await answer(view, 'repo-a', 200, status({ missing: ['knowledge base'] }));
      await answer(view, 'repo-b', 200, status({ onboarded: true }));
      expect(page(view)).toContain('Missing: knowledge base');
      expect(page(view)).toContain('Will run: onboarding');
      expect(page(view)).not.toContain('Will run: workflow');
    });
  });

  describe('after Re-run onboarding', () => {
    const left = {
      ok: true,
      removed: [],
      cleaned: [],
      skipped: [{ path: 'AGENTS.md', reason: 'edited' }],
    };
    const NOTE = 'Left alone: AGENTS.md (edited).';
    async function resetA() {
      const view = await mount();
      pick(view, 'repo-a');
      await answer(view, 'repo-a', 200, status({ onboarded: true }));
      fire.click(buttons(view.tree(), /^re-run onboarding$/)[0]!);
      view.draw();
      return view;
    }
    beforeEach(() => vi.stubGlobal('window', { confirm: () => true }));
    afterEach(() => Reflect.deleteProperty(globalThis, 'window'));

    it('says what it left alone under that repository, and under no other', async () => {
      const view = await resetA();
      await release(view, RESET('repo-a'), 200, left);
      await answer(view, 'repo-a', 200, status());
      expect(page(view)).toContain(NOTE);
      pick(view, 'repo-b');
      expect(page(view)).not.toContain(NOTE);
    });

    it('does not say it under a repository the person moved to before the reset finished', async () => {
      const view = await resetA();
      pick(view, 'repo-b');
      await release(view, RESET('repo-a'), 200, left);
      await answer(view, 'repo-b', 200, status({ onboarded: true }));
      expect(page(view)).not.toContain(NOTE);
      expect(page(view)).toContain('Will run: workflow');
    });

    it('does not show its failure under a repository the person moved to before it finished', async () => {
      const view = await resetA();
      pick(view, 'repo-b');
      await release(view, RESET('repo-a'), 500, { error: 'reset failed for a' });
      await answer(view, 'repo-b', 200, status({ onboarded: true }));
      expect(page(view)).not.toContain('reset failed for a');
      expect(page(view)).toContain('Will run: workflow');
    });

    it('offers no Retry for its failure, since Re-run onboarding is still there to try again', async () => {
      const view = await resetA();
      await release(view, RESET('repo-a'), 500, { error: 'reset failed for a' });
      expect(page(view)).toContain('reset failed for a');
      expect(buttons(view.tree(), /^retry$/)).toHaveLength(0);
      expect(buttons(view.tree(), /^re-run onboarding$/)).toHaveLength(1);
    });

    it('keeps the verdict in view beside its failure', async () => {
      const view = await resetA();
      await release(view, RESET('repo-a'), 500, { error: 'reset failed for a' });
      expect(page(view)).toContain('reset failed for a');
      expect(page(view)).toContain('Will run: workflow');
      expect(isDisabled(submit(view))).toBe(false);
    });

    it('disables Retry while the status is being asked for again', async () => {
      const view = await resetA();
      // A failure that lands after the person came back to repo-a meets that repository's new ask.
      pick(view, 'repo-b');
      pick(view, 'repo-a');
      await release(view, RESET('repo-a'), 500, { error: 'reset failed for a' });
      expect(page(view)).toContain('Checking onboarding');
      const retry = buttons(view.tree(), /^retry$/);
      expect(retry).toHaveLength(1);
      expect(isDisabled(retry[0]!)).toBe(true);
    });
  });

  describe('after Mark as onboarded', () => {
    const marked = { ok: true, onboardedAt: '2026-10-16T00:00:00.000Z' };
    async function markOnboarded() {
      const view = await mount();
      pick(view, 'repo-a');
      await answer(view, 'repo-a', 200, status({ canMarkOnboarded: true }));
      fire.click(buttons(view.tree(), /^mark as onboarded$/)[0]!);
      view.draw();
      return view;
    }

    it('asks again for the repository it marked, and shows that answer', async () => {
      const view = await markOnboarded();
      await release(view, MARK('repo-a'), 200, marked);
      await answer(view, 'repo-a', 200, status({ onboarded: true }));
      expect(page(view)).toContain('Will run: workflow');
      expect(page(view)).not.toContain('Mark as onboarded');
    });

    it('keeps Create task off while it asks again for the repository it marked', async () => {
      const view = await markOnboarded();
      fire.type(controls(view.tree(), /^title$/)[0]!, 'A title');
      await release(view, MARK('repo-a'), 200, marked);
      expect(page(view)).toContain('Checking onboarding');
      expect(isDisabled(submit(view))).toBe(true);
      await submitForm(view);
      expect(sent).not.toContain('POST /tasks');
      await answer(view, 'repo-a', 200, status({ onboarded: true }));
      expect(isDisabled(submit(view))).toBe(false);
    });

    it('does not ask again for a repository the person has left meanwhile', async () => {
      const view = await markOnboarded();
      pick(view, 'repo-b');
      await release(view, MARK('repo-a'), 200, marked);
      await answer(view, 'repo-b', 200, status({ onboarded: true }));
      held.get(STATUS('repo-a'))?.(200, status({ missing: ['knowledge base'] }));
      await view.flush();
      expect(page(view)).toContain('Will run: workflow');
      expect(page(view)).not.toContain('Missing: knowledge base');
      expect(page(view)).not.toContain('Checking onboarding');
    });

    it('does not show its failure under a repository the person has left meanwhile', async () => {
      const view = await markOnboarded();
      pick(view, 'repo-b');
      await release(view, MARK('repo-a'), 500, { error: 'mark failed for a' });
      await answer(view, 'repo-b', 200, status({ onboarded: true }));
      expect(page(view)).not.toContain('mark failed for a');
      expect(page(view)).toContain('Will run: workflow');
    });

    it('keeps the verdict in view beside its failure', async () => {
      const view = await markOnboarded();
      await release(view, MARK('repo-a'), 500, { error: 'mark failed for a' });
      expect(page(view)).toContain('mark failed for a');
      expect(page(view)).toContain('Will run: onboarding');
      expect(isDisabled(submit(view))).toBe(false);
    });
  });
});

describe('the CLI choice the form starts from', () => {
  beforeEach(() => {
    holdLastCli = true;
  });

  it('drops a remembered disabled provider from both CLI choices', async () => {
    disabledClis.add(P3);
    const view = await mount();
    chooseType(view, 'repoless');
    await release(view, LAST_CLI(), 200, remembered(P3));
    expect(valueOf(cliPick(view))).toBe('');
    expect(valueOf(summaryPick(view))).toBe('');
  });

  it('is the latest one across repositories for a type that needs none', async () => {
    const view = await mount();
    chooseType(view, 'repoless');
    expect(asked()).toEqual([LAST_CLI()]);
    await release(view, LAST_CLI(), 200, remembered(P1));
    expect(valueOf(cliPick(view))).toBe(P1);
    expect(valueOf(summaryPick(view))).toBe(P1);
  });

  it('is asked for only once a repository is picked, for a type that needs one', async () => {
    const view = await mount();
    expect(asked()).toEqual([]);
    chooseType(view, 'scoped');
    expect(asked()).toEqual([]);
    pick(view, 'repo-a');
    expect(asked()).toEqual([LAST_CLI('repo-a')]);
    await release(view, LAST_CLI('repo-a'), 200, remembered(P2));
    expect(valueOf(cliPick(view))).toBe(P2);
  });

  it.each([
    ['CLI provider', cliPick, summaryPick],
    ['Summary CLI', summaryPick, cliPick],
  ])(
    'leaves a %s picked with no repository to the pick, not to the answer that lands after it',
    async (_name, picked, other) => {
      const view = await mount();
      chooseType(view, 'repoless');
      fire.type(picked(view), P3);
      view.draw();
      await release(view, LAST_CLI(), 200, remembered(P1));
      expect(valueOf(picked(view))).toBe(P3);
      expect(valueOf(other(view))).toBe(P1);
    },
  );

  it('ignores the answer for no repository once a repository has been picked', async () => {
    const view = await mount();
    chooseType(view, 'repoless');
    pick(view, 'repo-a');
    await release(view, LAST_CLI('repo-a'), 200, remembered(P2));
    await release(view, LAST_CLI(), 200, remembered(P1));
    expect(valueOf(cliPick(view))).toBe(P2);
  });

  it('gives way to the memory of a repository picked after a pick made with none', async () => {
    const view = await mount();
    chooseType(view, 'repoless');
    await release(view, LAST_CLI(), 200, remembered(P1));
    fire.type(cliPick(view), P3);
    view.draw();
    pick(view, 'repo-a');
    expect(asked()).toEqual([LAST_CLI(), LAST_CLI('repo-a')]);
    await release(view, LAST_CLI('repo-a'), 200, remembered(P2));
    expect(valueOf(cliPick(view))).toBe(P2);
  });
});

describe('the parent of a bug fix', () => {
  const parentPick = (view: Renderer) => controls(view.tree(), /^parent task/)[0]!;

  async function pickedOnA() {
    const view = await mount();
    pick(view, 'repo-a');
    await answer(view, 'repo-a', 200, status({ onboarded: true }));
    fire.check(controls(view.tree(), /bug fix/)[0]!, true);
    view.draw();
    await view.flush();
    fire.type(parentPick(view), 'task-a1');
    view.draw();
    return view;
  }

  async function movedToB(view: Renderer) {
    pick(view, 'repo-b');
    await answer(view, 'repo-b', 200, status({ onboarded: true }));
    await view.flush();
  }

  async function create(view: Renderer) {
    fire.type(controls(view.tree(), /^title$/)[0]!, 'A title');
    fire.type(controls(view.tree(), /^description/)[0]!, 'A description');
    view.draw();
    await submitForm(view);
  }

  it('is posted with the repository it was picked on', async () => {
    const view = await pickedOnA();
    await create(view);
    expect(posted).toEqual([
      expect.objectContaining({ repositoryId: 'repo-a', parentTaskId: 'task-a1' }),
    ]);
  });

  it('is no longer picked once the person moves to another repository', async () => {
    const view = await pickedOnA();
    await movedToB(view);
    expect(valueOf(parentPick(view))).toBe('');
  });

  it('is not posted for a repository the person moved to after picking it', async () => {
    const view = await pickedOnA();
    await movedToB(view);
    await create(view);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ repositoryId: 'repo-b', isBugFix: true });
    expect(posted[0]).not.toHaveProperty('parentTaskId');
  });

  it("offers none of the repository it left while the new one's tasks load", async () => {
    const view = await pickedOnA();
    holdParents = true;
    await movedToB(view);
    // While the new list loads the picker may be absent; either way it must not offer the old one's tasks.
    const offered = () => {
      const select = controls(view.tree(), /^parent task/)[0];
      return select ? findAll(select, (host) => host.tag === 'option').map((o) => textOf(o)) : [];
    };
    expect(offered()).not.toContain('Alpha feature');
    await release(view, 'GET /tasks?repositoryId=repo-b&status=completed&pageSize=100', 200, {
      tasks: PARENTS['repo-b'],
    });
    view.draw();
    expect(offered()).toContain('Beta feature');
  });

  it('is posted when it is picked on the repository the person moved to', async () => {
    const view = await pickedOnA();
    await movedToB(view);
    fire.type(parentPick(view), 'task-b1');
    view.draw();
    await create(view);
    expect(posted).toEqual([
      expect.objectContaining({ repositoryId: 'repo-b', parentTaskId: 'task-b1' }),
    ]);
  });
});

describe('a new task with attachments', () => {
  const UPLOAD = (name: string) => `POST /tasks/task-new/attachments?filename=${name}`;
  const START = 'POST /tasks/task-new/action';
  const writes = () => sent.filter((call) => !call.startsWith('GET '));

  async function readyOnA(files: File[]) {
    const view = await mount();
    pick(view, 'repo-a');
    await answer(view, 'repo-a', 200, status({ onboarded: true }));
    fire.type(controls(view.tree(), /^title$/)[0]!, 'A title');
    fire.type(controls(view.tree(), /^description/)[0]!, 'A description');
    const input = controls(view.tree(), /^attachments/)[0]!;
    (input.props.onChange as (e: unknown) => void)({ target: { files } });
    view.draw();
    return view;
  }
  const two = () => [new File(['a'], 'a.md'), new File(['b'], 'b.md')];
  const three = () => [new File(['a'], 'a.md'), new File(['b'], 'b.md'), new File(['c'], 'c.md')];
  const failedList = (view: Renderer) =>
    findAll(
      view.tree(),
      (h) => h.tag === 'ul' && h.props['aria-label'] === 'Attachments that failed to upload',
    )[0];
  const failedFiles = (view: Renderer) =>
    findAll(failedList(view)!, (h) => h.tag === 'li').map((li) => textOf(li));
  const submitButton = (view: Renderer) =>
    findAll(view.tree(), (h) => h.tag === 'button' && h.props.type === 'submit')[0]!;

  it.each([true, false])('confirms a missing upload before starting: %s', async (yes) => {
    missingAttachments = true;
    const confirm = vi.fn(() => yes);
    vi.stubGlobal('window', { confirm });
    const view = await readyOnA(two());
    await submitForm(view);
    expect(posted[0]).toMatchObject({ deferStart: true, expectedAttachmentCount: 2 });
    expect(confirm).toHaveBeenCalledWith('1 of 2 attachments are missing. Start anyway?');
    expect(actions).toEqual(
      yes
        ? [{ action: 'start' }, { action: 'start', confirmMissingAttachments: true }]
        : [{ action: 'start' }],
    );
    expect(nav.pushed).toEqual(yes ? ['/tasks/task-new'] : []);
    if (!yes) expect(page(view)).toContain('Attachments');
  });

  it('creates the task unstarted, uploads every file, then starts it', async () => {
    const view = await readyOnA(two());
    await submitForm(view);
    expect(posted).toEqual([expect.objectContaining({ deferStart: true })]);
    expect(writes()).toEqual(['POST /tasks', UPLOAD('a.md'), UPLOAD('b.md'), START]);
    expect(actions).toEqual([{ action: 'start' }]);
  });

  it('starts the task only once its uploads have landed', async () => {
    holdUploads = true;
    const view = await readyOnA([new File(['a'], 'a.md')]);
    const submitted = submitForm(view);
    await view.flush();
    expect(writes()).toEqual(['POST /tasks', UPLOAD('a.md')]);
    await release(view, UPLOAD('a.md'), 201, { attachment: { id: 'a.md' } });
    await submitted;
    expect(writes()).toEqual(['POST /tasks', UPLOAD('a.md'), START]);
  });

  it('tries every file when one fails, starts the task once, and stays to name the file', async () => {
    failUploads = { 'b.md': 'too large' };
    const view = await readyOnA(three());
    await submitForm(view);
    expect(writes()).toEqual([
      'POST /tasks',
      UPLOAD('a.md'),
      UPLOAD('b.md'),
      UPLOAD('c.md'),
      START,
    ]);
    expect(actions).toEqual([{ action: 'start' }]);
    expect(failedFiles(view)).toEqual(['b.md: too large']);
    expect(page(view)).toContain('The task was created and started.');
    expect(page(view)).toContain('1 of 3 attachment(s) could not be uploaded:');
    expect(UploadFailureList).toHaveBeenCalledWith(
      expect.objectContaining({
        total: 3,
        failed: [{ name: 'b.md', message: 'too large' }],
      }),
    );
    expect(
      findAll(view.tree(), (h) => h.tag === 'a' && h.props.href === '/tasks/task-new'),
    ).toHaveLength(1);
    expect(nav.pushed).toEqual([]);
    expect(isDisabled(submitButton(view))).toBe(true);
    expect(textOf(submitButton(view))).toBe('Created');
  });

  it('names every file that failed with its own message', async () => {
    failUploads = { 'a.md': 'too large', 'c.md': 'type not allowed' };
    const view = await readyOnA(three());
    await submitForm(view);
    expect(failedFiles(view)).toEqual(['a.md: too large', 'c.md: type not allowed']);
    expect(page(view)).toContain('2 of 3 attachment(s) could not be uploaded:');
  });

  it('names a file from a picked folder by its path inside the folder', async () => {
    const inFolder = new File(['x'], 'spec.md');
    Object.defineProperty(inFolder, 'webkitRelativePath', { value: 'docs/spec.md' });
    failUploads = { 'docs/spec.md': 'too large' };
    const view = await readyOnA([inFolder]);
    await submitForm(view);
    expect(failedFiles(view)).toEqual(['docs/spec.md: too large']);
  });

  it('navigates to the task, with no failure list, when every upload lands', async () => {
    const view = await readyOnA(three());
    await submitForm(view);
    expect(nav.pushed).toEqual(['/tasks/task-new']);
    expect(failedList(view)).toBeUndefined();
  });

  it('does not say the task started when its start is refused', async () => {
    failUploads = { 'b.md': 'too large' };
    failStart = true;
    const view = await readyOnA(three());
    await submitForm(view);
    expect(page(view)).toContain(
      'The task was created but could not be started (the queue is draining).',
    );
    expect(page(view)).not.toContain('created and started');
    expect(nav.pushed).toEqual([]);
  });

  it('stays and gives the reason when its start is refused after every upload landed', async () => {
    failStart = true;
    const view = await readyOnA(two());
    await submitForm(view);
    expect(writes()).toEqual(['POST /tasks', UPLOAD('a.md'), UPLOAD('b.md'), START]);
    expect(nav.pushed).toEqual([]);
    expect(page(view)).toContain(
      'The task was created but could not be started (the queue is draining). Open it and press Start.',
    );
    expect(page(view)).not.toContain('could not be uploaded');
    expect(failedList(view)).toBeUndefined();
    expect(
      findAll(view.tree(), (h) => h.tag === 'a' && h.props.href === '/tasks/task-new'),
    ).toHaveLength(1);
    expect(isDisabled(submitButton(view))).toBe(true);
    expect(textOf(submitButton(view))).toBe('Created');
  });

  it('says the task did not start when its start answers that it is no longer created', async () => {
    failUploads = { 'b.md': 'too large' };
    startAnswer = { started: false, status: 'cancelled' };
    const view = await readyOnA(three());
    await submitForm(view);
    expect(page(view)).toContain('The task was created but not started: it is cancelled now.');
    expect(page(view)).not.toContain('created and started');
    expect(nav.pushed).toEqual([]);
  });

  it('creates and starts a task with no attachments in one call', async () => {
    const view = await readyOnA([]);
    await submitForm(view);
    expect(posted).toHaveLength(1);
    expect(posted[0]).not.toHaveProperty('deferStart');
    expect(writes()).toEqual(['POST /tasks']);
  });

  describe('for a read-only local repository', () => {
    const NOTE = 'This repository is imported read-only, so files cannot be attached.';
    const folderInputs = (view: Renderer) =>
      findAll(view.tree(), (h) => h.tag === 'input' && 'webkitdirectory' in h.props);

    it('N1: offers no attachment controls and says why', async () => {
      const view = await mount();
      pick(view, 'repo-ro');
      expect(controls(view.tree(), /^attachments/)).toHaveLength(0);
      expect(folderInputs(view)).toHaveLength(0);
      expect(page(view)).toContain(NOTE);
    });

    it('N2: a writable local repository keeps the controls and shows no sentence', async () => {
      const view = await mount();
      pick(view, 'repo-rw');
      expect(controls(view.tree(), /^attachments/)).toHaveLength(1);
      expect(folderInputs(view)).toHaveLength(1);
      expect(page(view)).not.toContain(NOTE);
    });

    it('N3: files picked for another repository do not ride a deferred start into it', async () => {
      const view = await readyOnA(two());
      expect(page(view)).toContain('2 file(s) selected');

      pick(view, 'repo-ro');
      await answer(view, 'repo-ro', 200, status({ onboarded: true }));
      await submitForm(view);
      expect(posted).toHaveLength(1);
      expect(posted[0]).not.toHaveProperty('deferStart');
      expect(writes()).toEqual(['POST /tasks']);
      expect(nav.pushed).toEqual(['/tasks/task-new']);
    });

    it('N4: files picked before moving to it are gone when the person moves back', async () => {
      const view = await readyOnA(two());
      pick(view, 'repo-ro');
      expect(page(view)).not.toContain('file(s) selected');

      pick(view, 'repo-a');
      expect(controls(view.tree(), /^attachments/)).toHaveLength(1);
      expect(page(view)).not.toContain('file(s) selected');
    });
  });
});

describe('the steps that keep a saved CLI under the none option', () => {
  const lock = (view: Renderer) => buttons(view.tree(), /use this cli for every step/)[0]!;
  const toggle = (view: Renderer) => {
    fire.click(lock(view));
    view.draw();
  };
  const choose = (view: Renderer, value: string) => {
    fire.type(cliPick(view), value);
    view.draw();
  };
  const askedSaved = () => sent.filter((call) => call.includes('/saved-step-clis'));

  async function onScoped(
    rows: unknown[] = [savedStep('08-implement', 'Implementation', { preferredCliProviderId: P1 })],
  ) {
    savedRows.scoped = rows;
    const view = await mount();
    chooseType(view, 'scoped');
    await view.flush();
    return view;
  }

  it('lists the step and its CLI only while none is picked', async () => {
    const view = await onScoped();
    expect(page(view)).toContain(
      'With no default CLI, a step that has a saved CLI of its own still uses it:',
    );
    expect(page(view)).toContain('Implementation');
    expect(page(view)).toContain('08-implement');
    expect(page(view)).toContain('cli-1 (cli-1)');
    choose(view, P2);
    expect(page(view)).not.toContain('08-implement');
    choose(view, '');
    expect(page(view)).toContain('08-implement');
  });

  it('lists it again when none is chosen over a ticked lock, which cannot apply to none', async () => {
    const view = await onScoped();
    choose(view, P2);
    toggle(view);
    expect(page(view)).not.toContain('08-implement');
    choose(view, '');
    expect(page(view)).toContain('08-implement');
  });

  describe('the default CLI named under the none option', () => {
    const LINE = 'Steps with no saved CLI will use cli-2 (cli-2).';
    const SENTENCE = 'With no default CLI, a step that has a saved CLI of its own still uses it:';

    it('is shown under none with the exact text', async () => {
      savedDefault = P2;
      const view = await onScoped();
      expect(page(view)).toContain(LINE);
    });

    it('is shown when the type has no saved steps', async () => {
      savedDefault = P2;
      const view = await onScoped([]);
      expect(page(view)).not.toContain(SENTENCE);
      expect(page(view)).toContain(LINE);
    });

    it('comes after the saved-steps box', async () => {
      savedDefault = P2;
      const view = await onScoped();
      const text = page(view);
      expect(text.indexOf(SENTENCE)).toBeGreaterThan(-1);
      expect(text.indexOf(LINE)).toBeGreaterThan(text.indexOf(SENTENCE));
    });

    it('is hidden once a CLI is picked and back after choosing none', async () => {
      savedDefault = P2;
      const view = await onScoped();
      choose(view, P1);
      expect(page(view)).not.toContain('Steps with no saved CLI will use');
      choose(view, '');
      expect(page(view)).toContain(LINE);
    });

    it.each([
      ['null', null],
      ['a provider that is not known', 'cli-unknown'],
    ])('is absent when the default is %s', async (_what, id) => {
      savedDefault = id;
      const view = await onScoped();
      expect(page(view)).not.toContain('Steps with no saved CLI will use');
    });
  });

  describe('the lock', () => {
    async function onWorkflow() {
      savedRows.workflow = [];
      const view = await mount();
      pick(view, 'repo-a');
      await answer(view, 'repo-a', 200, status({ onboarded: true }));
      return view;
    }
    const fill = (view: Renderer) => {
      fire.type(controls(view.tree(), /^title$/)[0]!, 'A title');
      fire.type(controls(view.tree(), /^description/)[0]!, 'A description');
      view.draw();
    };

    it('is disabled while none is picked and enabled with a CLI picked', async () => {
      const view = await onScoped();
      expect(isDisabled(lock(view))).toBe(true);
      choose(view, P1);
      expect(isDisabled(lock(view))).toBe(false);
      choose(view, '');
      expect(isDisabled(lock(view))).toBe(true);
    });

    it('is not posted when it was ticked and then none was chosen', async () => {
      const view = await onWorkflow();
      choose(view, P1);
      toggle(view);
      choose(view, '');
      fill(view);
      await submitForm(view);
      expect(posted).toHaveLength(1);
      expect(posted[0]).toMatchObject({ cliProviderId: null });
      expect(posted[0]).not.toHaveProperty('ignoreSavedStepClis');
    });

    it('is posted with a CLI picked', async () => {
      const view = await onWorkflow();
      choose(view, P1);
      toggle(view);
      fill(view);
      await submitForm(view);
      expect(posted[0]).toMatchObject({ cliProviderId: P1, ignoreSavedStepClis: true });
    });

    it('is not posted when a repository switch brings back a remembered none', async () => {
      holdLastCli = true;
      savedRows.workflow = [];
      const view = await mount();
      pick(view, 'repo-a');
      await answer(view, 'repo-a', 200, status({ onboarded: true }));
      await release(view, LAST_CLI('repo-a'), 200, remembered(P1));
      expect(valueOf(cliPick(view))).toBe(P1);
      toggle(view);
      pick(view, 'repo-b');
      await answer(view, 'repo-b', 200, status({ onboarded: true }));
      await release(view, LAST_CLI('repo-b'), 200, { cliChoice: null, summaryChoice: null });
      expect(valueOf(cliPick(view))).toBe('');
      fill(view);
      await submitForm(view);
      expect(posted).toHaveLength(1);
      expect(posted[0]).toMatchObject({ cliProviderId: null });
      expect(posted[0]).not.toHaveProperty('ignoreSavedStepClis');
    });
  });

  it("asks for the chosen type, and shows only that type's rows", async () => {
    savedRows.repoless = [savedStep('02-plan', 'Planning', { preferredCliProviderId: P2 })];
    const view = await onScoped();
    expect(askedSaved()).toEqual([SAVED('scoped')]);
    chooseType(view, 'repoless');
    await view.flush();
    expect(askedSaved()).toEqual([SAVED('scoped'), SAVED('repoless')]);
    expect(page(view)).toContain('02-plan');
    expect(page(view)).not.toContain('08-implement');
  });

  it('asks nothing for the Workflow kind until the repository verdict is known, then for its type', async () => {
    savedRows.workflow = [
      savedStep('08-implement', 'Implementation', { preferredCliProviderId: P1 }),
    ];
    savedRows.onboarding = [savedStep('03-scan', 'Scanning', { preferredCliProviderId: P2 })];
    const view = await mount();
    pick(view, 'repo-a');
    expect(askedSaved()).toEqual([]);
    expect(page(view)).not.toContain('With no default CLI');
    await answer(view, 'repo-a', 200, status({ onboarded: true }));
    expect(askedSaved()).toEqual([SAVED('workflow')]);
    await view.flush();
    expect(page(view)).toContain('08-implement');
    pick(view, 'repo-b');
    await answer(view, 'repo-b', 200, status());
    expect(askedSaved()).toEqual([SAVED('workflow'), SAVED('onboarding')]);
    await view.flush();
    expect(page(view)).toContain('03-scan');
    expect(page(view)).not.toContain('08-implement');
  });

  it('drops a step whose only saved CLI is disabled, and lists both CLIs of a step saved on two', async () => {
    disabledClis.add(P3);
    const view = await onScoped([
      savedStep('08-implement', 'Implementation', {
        preferredCliProviderId: P1,
        cliRoles: [{ id: 'fixer', label: 'Fixer' }],
        cliRoleProviders: { fixer: P2 },
      }),
      savedStep('09-review', 'Review', { preferredCliProviderId: P3 }),
    ]);
    expect(page(view)).toContain('08-implement');
    expect(page(view)).toContain('cli-1 (cli-1), cli-2 (cli-2)');
    expect(page(view)).not.toContain('09-review');
  });

  it.each([404, 500])(
    'leaves the page working with no list when the request answers %i',
    async (code) => {
      savedFailure = code;
      const view = await onScoped();
      expect(askedSaved()).toEqual([SAVED('scoped')]);
      expect(page(view)).not.toContain('With no default CLI');
      expect(controls(view.tree(), /^cli provider/)).toHaveLength(1);
    },
  );

  it('words the none option without promising that no AI runs', async () => {
    const view = await mount();
    const none = findAll(cliPick(view), (h) => h.tag === 'option' && h.props.value === '')[0]!;
    expect(textOf(none)).toBe('(none — no default CLI)');
    expect(textOf(none)).not.toMatch(/deterministic/i);
  });

  it('says the saved choices are ignored only with the lock on', async () => {
    const view = await mount();
    expect(page(view)).toContain('With the lock on, your saved per-step CLI choices are ignored');
    expect(page(view)).not.toContain('Ignores your saved per-step CLI choices');
  });
});

it('offers only enabled providers for a new task', async () => {
  disabledClis.add(P3);
  const view = await mount();
  for (const select of [cliPick(view), summaryPick(view)]) {
    expect(select).toBeDefined();
    const options = findAll(select, (h) => h.tag === 'option').map((h) => h.props.value);
    expect(options).toContain(P1);
    expect(options).not.toContain(P3);
  }
});
