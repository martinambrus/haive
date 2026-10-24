import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlanStarter } from './plan-starter';
import {
  buttons,
  createRenderer,
  findAll,
  fire,
  isDisabled,
  textOf,
  type Renderer,
} from '../../../test/render-tree';

// No DOM in this package: the starter runs through test/render-tree.ts, and the network is stubbed.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('../../../test/render-tree')).reactHooks,
}));
vi.mock('next/link', async () => {
  const { createElement } = await import('react');
  return {
    default: ({ href, children }: { href: string; children?: unknown }) =>
      createElement('a', { href }, children as never),
  };
});
vi.mock('lucide-react', () => ({ FolderUp: () => null, Paperclip: () => null, X: () => null }));

const net = vi.hoisted(() => ({
  repoRow: vi.fn(),
  buildPlan: vi.fn(),
  startTask: vi.fn(),
  uploadTaskAttachment: vi.fn(),
}));
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  api: {
    get: async (path: string) => (path === '/repos/repo-1' ? net.repoRow() : { providers: [] }),
  },
  getPlanBuildClis: async () => ({ plannerCliProviderId: null, questionerCliProviderId: null }),
  buildPlan: net.buildPlan,
  startTask: net.startTask,
  uploadTaskAttachment: net.uploadTaskAttachment,
}));

const BUILD = /^(draft a plan from this|retry)/;
const onNavigate = vi.fn();

async function mount(): Promise<Renderer> {
  const view = createRenderer(() => (
    <PlanStarter
      repositoryId="repo-1"
      onboarded={true}
      onNavigate={onNavigate}
      onCreateRoot={async () => {}}
    />
  ));
  await view.flush();
  const textarea = findAll(view.tree(), (h) => h.tag === 'textarea')[0]!;
  fire.type(textarea, 'A club site');
  view.draw();
  const input = findAll(view.tree(), (h) => h.tag === 'input' && h.props.type === 'file')[0]!;
  const files = [new File(['x'], 'a.md'), new File(['y'], 'b.md')];
  (input.props.onChange as (e: unknown) => void)({ target: { files } });
  view.draw();
  return view;
}

const build = (view: Renderer) => buttons(view.tree(), BUILD)[0]!;
const press = async (view: Renderer) => {
  fire.click(build(view));
  await view.flush();
};
const page = (view: Renderer) => textOf(view.tree());
const addFile = (view: Renderer, name: string) => {
  const input = findAll(view.tree(), (h) => h.tag === 'input' && h.props.type === 'file')[0]!;
  (input.props.onChange as (e: unknown) => void)({ target: { files: [new File(['z'], name)] } });
  view.draw();
};

beforeEach(() => {
  vi.resetAllMocks();
  net.repoRow.mockResolvedValue({ repository: { source: 'git_https', writable: false } });
  let created = 0;
  net.buildPlan.mockImplementation(async () => ({ taskId: `draft-${++created}` }));
  net.uploadTaskAttachment.mockResolvedValue({});
  net.startTask.mockResolvedValue({ ok: true, started: true, status: 'queued' });
});

describe('PlanStarter when the start is refused', () => {
  it('C1: the next press starts the same draft and creates nothing', async () => {
    net.startTask
      .mockReset()
      .mockRejectedValueOnce(new Error('the queue is draining'))
      .mockResolvedValue({ ok: true, started: true, status: 'queued' });
    const view = await mount();

    await press(view);
    expect(net.buildPlan).toHaveBeenCalledTimes(1);
    expect(net.buildPlan.mock.calls[0]![1]).toMatchObject({ deferStart: true });
    expect(net.uploadTaskAttachment).toHaveBeenCalledTimes(2);
    expect(net.startTask).toHaveBeenCalledTimes(1);
    expect(net.startTask).toHaveBeenLastCalledWith('draft-1');
    expect(onNavigate).not.toHaveBeenCalled();
    expect(isDisabled(build(view))).toBe(false);

    await press(view);
    expect(net.buildPlan).toHaveBeenCalledTimes(1);
    expect(net.uploadTaskAttachment).toHaveBeenCalledTimes(2);
    expect(net.startTask).toHaveBeenCalledTimes(2);
    expect(net.startTask.mock.calls.map((c) => c[0])).toEqual(['draft-1', 'draft-1']);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith('/tasks/draft-1');
  });

  it('C2: says the draft exists, links to it and offers to retry the start', async () => {
    net.startTask.mockReset().mockRejectedValue(new Error('the queue is draining'));
    const view = await mount();
    await press(view);

    expect(page(view)).toContain('The task was created but could not be started');
    expect(page(view)).toContain('the queue is draining');
    const link = findAll(view.tree(), (h) => h.tag === 'a' && h.props.href === '/tasks/draft-1');
    expect(link.map((l) => textOf(l))).toEqual(['Open the draft task instead']);
    const retry = buttons(view.tree(), 'retry starting the build');
    expect(retry).toHaveLength(1);
    expect(isDisabled(retry[0]!)).toBe(false);
    expect(buttons(view.tree(), 'retry the failed uploads')).toHaveLength(0);
  });

  it('C3: a failed upload still retries only that file and then starts the draft', async () => {
    let failOnce = true;
    let release: () => void = () => {};
    net.uploadTaskAttachment.mockImplementation(async (_task: string, file: File) => {
      if (file.name === 'b.md' && failOnce) {
        failOnce = false;
        throw new Error('too large');
      }
      if (file.name === 'b.md') {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return {};
    });
    const view = await mount();

    await press(view);
    expect(net.startTask).not.toHaveBeenCalled();
    expect(textOf(build(view))).toBe('Retry the failed uploads');

    await press(view);
    expect(textOf(build(view))).toBe('Retry the failed uploads');
    expect(isDisabled(build(view))).toBe(true);

    release();
    await view.flush();
    expect(net.uploadTaskAttachment.mock.calls.map((c) => (c[1] as File).name)).toEqual([
      'a.md',
      'b.md',
      'b.md',
    ]);
    expect(net.buildPlan).toHaveBeenCalledTimes(1);
    expect(net.startTask).toHaveBeenCalledTimes(1);
    expect(net.startTask).toHaveBeenCalledWith('draft-1');
    expect(onNavigate).toHaveBeenCalledWith('/tasks/draft-1');
  });

  it('C5: removing every row after a refused start still starts the same draft', async () => {
    net.startTask
      .mockReset()
      .mockRejectedValueOnce(new Error('the queue is draining'))
      .mockResolvedValue({ ok: true, started: true, status: 'queued' });
    const view = await mount();
    await press(view);
    expect(onNavigate).not.toHaveBeenCalled();

    for (const name of ['a.md', 'b.md']) {
      const remove = buttons(view.tree(), `remove ${name}`)[0]!;
      if (!isDisabled(remove)) fire.click(remove);
      view.draw();
    }
    await press(view);

    expect(net.buildPlan).toHaveBeenCalledTimes(1);
    expect(net.startTask.mock.calls.map((c) => c[0])).toEqual(['draft-1', 'draft-1']);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith('/tasks/draft-1');
  });

  it('C6: a row already attached to the draft cannot be removed or re-described', async () => {
    net.startTask.mockReset().mockRejectedValue(new Error('the queue is draining'));
    const view = await mount();
    await press(view);

    for (const name of ['a.md', 'b.md']) {
      expect(isDisabled(buttons(view.tree(), `remove ${name}`)[0]!)).toBe(true);
    }
    const inputs = findAll(
      view.tree(),
      (h) => h.tag === 'input' && h.props.placeholder === 'What is this? (optional)',
    );
    expect(inputs).toHaveLength(2);
    expect(inputs.every((i) => isDisabled(i))).toBe(true);
  });

  it('C4: a refused create leaves no draft, so the next press creates again', async () => {
    net.buildPlan.mockRejectedValueOnce(new Error('no capacity'));
    const view = await mount();

    await press(view);
    expect(page(view)).toContain('no capacity');
    expect(textOf(build(view))).toBe('Draft a plan from this');
    expect(page(view)).not.toContain('Open the draft task instead');

    await press(view);
    expect(net.buildPlan).toHaveBeenCalledTimes(2);
  });

  it('C7: a file picked after a refused start is named by the button and uploaded alone', async () => {
    net.startTask
      .mockReset()
      .mockRejectedValueOnce(new Error('the queue is draining'))
      .mockResolvedValue({ ok: true, started: true, status: 'queued' });
    const view = await mount();
    await press(view);
    expect(textOf(build(view))).toBe('Retry starting the build');

    addFile(view, 'c.md');
    expect(textOf(build(view))).toBe('Retry starting the build with the new files');

    await press(view);
    expect(net.uploadTaskAttachment.mock.calls.map((c) => (c[1] as File).name)).toEqual([
      'a.md',
      'b.md',
      'c.md',
    ]);
    expect(net.buildPlan).toHaveBeenCalledTimes(1);
    expect(net.startTask.mock.calls.map((c) => c[0])).toEqual(['draft-1', 'draft-1']);
    expect(onNavigate).toHaveBeenCalledWith('/tasks/draft-1');
  });

  it('C8: a failed row still names the button when a new file is picked beside it', async () => {
    net.uploadTaskAttachment.mockImplementation(async (_task: string, file: File) => {
      if (file.name === 'b.md') throw new Error('too large');
      return {};
    });
    const view = await mount();
    await press(view);
    addFile(view, 'c.md');
    expect(textOf(build(view))).toBe('Retry the failed uploads');
  });
});

describe('PlanStarter for a read-only local repository', () => {
  const NOTE = 'This repository is imported read-only, so files cannot be attached.';
  const fileInputs = (view: Renderer) =>
    findAll(view.tree(), (h) => h.tag === 'input' && h.props.type === 'file');

  async function mountPlain(): Promise<Renderer> {
    const view = createRenderer(() => (
      <PlanStarter
        repositoryId="repo-1"
        onboarded={true}
        onNavigate={onNavigate}
        onCreateRoot={async () => {}}
      />
    ));
    await view.flush();
    return view;
  }

  it('R1: offers no attach controls and says why', async () => {
    net.repoRow.mockResolvedValue({ repository: { source: 'local_path', writable: false } });
    const view = await mountPlain();
    expect(buttons(view.tree(), /^attach (files|folder)/)).toHaveLength(0);
    expect(fileInputs(view)).toHaveLength(0);
    expect(page(view)).toContain(NOTE);
  });

  it('R2: a writable local repository keeps both buttons and shows no sentence', async () => {
    net.repoRow.mockResolvedValue({ repository: { source: 'local_path', writable: true } });
    const view = await mountPlain();
    expect(buttons(view.tree(), 'attach files')).toHaveLength(1);
    expect(buttons(view.tree(), 'attach folder')).toHaveLength(1);
    expect(page(view)).not.toContain(NOTE);
  });

  it('R3: keeps the controls when the repository cannot be fetched', async () => {
    net.repoRow.mockRejectedValue(new Error('offline'));
    const view = await mountPlain();
    expect(buttons(view.tree(), 'attach files')).toHaveLength(1);
    expect(buttons(view.tree(), 'attach folder')).toHaveLength(1);
    expect(page(view)).not.toContain(NOTE);
  });

  it('R4: drafts the plan with no deferred start and opens the task', async () => {
    net.repoRow.mockResolvedValue({ repository: { source: 'local_path', writable: false } });
    const view = await mountPlain();
    const textarea = findAll(view.tree(), (h) => h.tag === 'textarea')[0]!;
    fire.type(textarea, 'A club site');
    view.draw();
    await press(view);
    expect(net.buildPlan).toHaveBeenCalledTimes(1);
    expect(net.buildPlan.mock.calls[0]![1]).not.toHaveProperty('deferStart');
    expect(onNavigate).toHaveBeenCalledWith('/tasks/draft-1');
  });
});
