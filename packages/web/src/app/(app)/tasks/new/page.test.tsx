import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import NewTaskPage from './page';
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
const nav = vi.hoisted(() => ({ search: new URLSearchParams() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {} }),
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

const status = (over: Record<string, unknown> = {}) => ({
  onboarded: false,
  nothingToOnboard: false,
  onboardingTaskId: null,
  canMarkOnboarded: false,
  missing: [],
  ...over,
});
const repo = (id: string, name: string) => ({ id, name, status: 'ready', detectedFramework: null });
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
const GETS: Record<string, unknown> = {
  '/repos': { repositories: [repo('repo-a', 'Alpha'), repo('repo-b', 'Beta')] },
  '/cli-providers': { providers: [P1, P2, P3].map((id) => ({ id, name: id, label: id })) },
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
let failUploads = false;
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
    return failUploads
      ? reply(500, { error: 'upload failed' })
      : reply(201, { attachment: { id: url.searchParams.get('filename') } });
  }
  if (call === 'POST /tasks/task-new/action') {
    actions.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>);
    return reply(200, { ok: true, started: true, status: 'queued' });
  }
  if (call === 'POST /tasks') {
    posted.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>);
    return reply(200, { task: { id: 'task-new' } });
  }
  if (call.startsWith('GET ') && path in GETS) return reply(200, GETS[path]);
  return reply(404, { error: `not stubbed: ${call}` });
}

beforeAll(() => vi.stubGlobal('fetch', fakeFetch));
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  held.clear();
  sent.length = 0;
  posted.length = 0;
  holdLastCli = false;
  holdParents = false;
  holdUploads = false;
  failUploads = false;
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

  it('still starts the task when an upload fails', async () => {
    failUploads = true;
    const view = await readyOnA(two());
    await submitForm(view);
    expect(writes()).toEqual(['POST /tasks', UPLOAD('a.md'), START]);
  });

  it('creates and starts a task with no attachments in one call', async () => {
    const view = await readyOnA([]);
    await submitForm(view);
    expect(posted).toHaveLength(1);
    expect(posted[0]).not.toHaveProperty('deferStart');
    expect(writes()).toEqual(['POST /tasks']);
  });
});
