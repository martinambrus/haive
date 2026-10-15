import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MODULE_DEPENDENTS_CAP } from '@haive/shared/modularity';
import type { ModuleOpenTask } from '@/lib/api-client';
import {
  ModuleTaskTitle,
  ModuleTasksCapNote,
  ModuleTasksOpenDialog,
  moduleOffNotice,
  type ModuleTasksBlocked,
} from './module-tasks-open-dialog';

// The shared Dialog portals into document.body, which the server renderer has no equivalent of.
vi.mock('react-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-dom')>()),
  createPortal: (children: unknown) => children,
}));
// A cap other than the real one, so a note that spells the number itself fails.
vi.mock('@haive/shared/modularity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared/modularity')>()),
  MODULE_DEPENDENTS_CAP: 7,
}));
beforeAll(() => vi.stubGlobal('document', { body: {} }));
afterAll(() => vi.unstubAllGlobals());

const task = (
  id: string,
  title: string,
  status: string,
  currentStepId: string | null,
): ModuleOpenTask => ({ id, title, status, ownerId: 'u1', currentStepId });
const tasks = [
  task('task-1', 'Rebuild the <index>', 'running', 'module.alpha.rebuild'),
  task('task-2', 'Second task', 'waiting_user', '07-phase-2-implement'),
];
const blocked = (over: Partial<ModuleTasksBlocked> = {}): ModuleTasksBlocked => ({
  moduleId: 'alpha',
  name: 'Alpha Search',
  tasks,
  capped: false,
  ...over,
});
const render = (b: ModuleTasksBlocked | null) =>
  renderToStaticMarkup(<ModuleTasksOpenDialog blocked={b} onClose={() => {}} onDone={() => {}} />);
const rowsOf = (html: string) => [...html.matchAll(/<li[\s\S]*?<\/li>/g)].map((m) => m[0]);
const BADGE = /in a [^<]* step/;

const COPY_TAIL =
  'Module code already running finishes its current call, and its background jobs stop at the next worker restart.';

describe('ModuleTasksOpenDialog', () => {
  it('renders nothing while no deactivation is refused', () => {
    expect(render(null)).toBe('');
  });

  it('names the module and lists each blocking task, in order', () => {
    const html = render(blocked({ moduleId: 'statistics', name: null }));
    expect(html).toContain('data-haive-dialog');
    expect(html).toContain('<code>statistics</code>');
    expect(rowsOf(html)).toHaveLength(2);
    expect(html.indexOf('Rebuild the')).toBeLessThan(html.indexOf('Second task'));
  });

  it('links no task before it knows who is signed in', () => {
    expect(render(blocked())).not.toContain('<a ');
  });

  it('shows each task status and escapes a title as text', () => {
    const html = render(blocked());
    expect(html).toContain('running');
    expect(html).toContain('waiting_user');
    expect(html).toContain('Rebuild the &lt;index&gt;');
    expect(html).not.toContain('<index>');
  });

  it('shows the step each task is on, and nothing for a task that has not reached one', () => {
    const rows = rowsOf(
      render(blocked({ tasks: [...tasks, task('task-3', 'Third task', 'queued', null)] })),
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain('module.alpha.rebuild');
    expect(rows[1]).toContain('07-phase-2-implement');
    expect(rows[2]).not.toContain('<code');
  });

  it('is an alert dialog with a Cancel and a danger Turn off now, and no Close', () => {
    const html = render(blocked());
    expect(html).toContain('role="alertdialog"');
    expect(html).toMatch(/<button[^>]*>Cancel<\/button>/);
    expect(html).toMatch(/<button[^>]*>Turn off now<\/button>/);
    expect(html).not.toContain('>Close<');
    expect(html).not.toContain('disabled=""');
  });

  it('wraps the footer buttons instead of overflowing a narrow screen', () => {
    expect(render(blocked())).toContain('class="mt-4 flex flex-wrap justify-end gap-2"');
  });
});

describe('ModuleTaskTitle', () => {
  const own = task('task-1', 'Rebuild the <index>', 'running', null);
  const title = (viewerId: string | null) =>
    renderToStaticMarkup(<ModuleTaskTitle task={own} viewerId={viewerId} />);

  it('links a task owned by the signed-in user, in a new tab that cannot reach back to the opener', () => {
    const tag = /<a [^>]*>/.exec(title('u1'))![0];
    expect(tag).toContain('href="/tasks/task-1"');
    expect(tag).toContain('target="_blank"');
    expect(tag).toContain('rel="noopener noreferrer"');
  });

  it('shows the task of another user as text', () => {
    const html = title('someone-else');
    expect(html).not.toContain('<a');
    expect(html).toContain('Rebuild the &lt;index&gt;');
    expect(html).not.toContain('<index>');
  });

  it('shows text while the signed-in user is not known', () => {
    expect(title(null)).not.toContain('<a');
    expect(title(null)).toContain('Rebuild the &lt;index&gt;');
  });

  it('compares the ids exactly', () => {
    for (const viewer of ['U1', 'u1 ', ' u1', 'u', 'u11'])
      expect(title(viewer)).not.toContain('<a');
  });

  it('decides on the owner and on nothing else about the task', () => {
    const others = [
      { status: 'waiting_user' },
      { title: 'Another title' },
      { id: 'u1' },
      { currentStepId: 'module.alpha.x' },
    ];
    for (const over of others) {
      const html = renderToStaticMarkup(
        <ModuleTaskTitle task={{ ...own, ...over }} viewerId="someone-else" />,
      );
      expect(html).not.toContain('<a');
      const linked = renderToStaticMarkup(
        <ModuleTaskTitle task={{ ...own, ...over }} viewerId="u1" />,
      );
      expect(linked).toContain('<a ');
    }
  });
});

describe('ModuleTasksOpenDialog step badge', () => {
  const badgesByTitle = (over: Partial<ModuleTasksBlocked>) =>
    Object.fromEntries(
      rowsOf(render(blocked(over))).map((row) => [
        /Task [A-Z]/.exec(row)![0],
        BADGE.exec(row)?.[0] ?? null,
      ]),
    );

  it('badges a task in a step of this module, by the module name', () => {
    const html = render(
      blocked({ tasks: [task('t1', 'Task A', 'running', 'module.alpha.x')], name: 'Alpha Search' }),
    );
    expect(html).toContain('in a Alpha Search step');
  });

  it('falls back to the module id when the module has no name', () => {
    const html = render(
      blocked({ tasks: [task('t1', 'Task A', 'running', 'module.alpha.x')], name: null }),
    );
    expect(html).toContain('in a alpha step');
  });

  it('badges no task whose step belongs to another module, to a core step or to no step', () => {
    expect(
      badgesByTitle({
        tasks: [
          task('t1', 'Task A', 'running', 'module.alpha.x'),
          task('t2', 'Task B', 'running', 'module.beta.x'),
          task('t3', 'Task C', 'running', 'module.alpha-two.x'),
          task('t4', 'Task D', 'running', '07-phase-2-implement'),
          task('t5', 'Task E', 'running', 'custom.alpha.x'),
          task('t6', 'Task F', 'queued', null),
        ],
      }),
    ).toEqual({
      'Task A': 'in a Alpha Search step',
      'Task B': null,
      'Task C': null,
      'Task D': null,
      'Task E': null,
      'Task F': null,
    });
  });

  it('shows no badge at all for a step of module beta while turning off module alpha', () => {
    const html = render(
      blocked({ tasks: [task('t1', 'Task A', 'running', 'module.beta.x')], moduleId: 'alpha' }),
    );
    expect(html).not.toMatch(BADGE);
  });
});

describe('ModuleTasksOpenDialog cap note', () => {
  const NOTE = `Showing the first ${MODULE_DEPENDENTS_CAP}.`;
  const noteOf = (html: string) => /<p[^>]*>(Showing[^<]*)<\/p>/.exec(html)?.[1];

  it('says the list was cut only when the api said so', () => {
    expect(noteOf(render(blocked({ capped: true })))).toBe(NOTE);
    expect(render(blocked({ capped: false }))).not.toContain('Showing the first');
  });

  it('is the same note the purge dialog shows, built from the shared cap', () => {
    expect(noteOf(renderToStaticMarkup(<ModuleTasksCapNote />))).toBe(NOTE);
  });
});

describe('ModuleTasksOpenDialog copy', () => {
  const copyOf = (over: Partial<ModuleTasksBlocked>) => {
    const html = render(blocked(over));
    return /Turns[\s\S]*?restart\./.exec(html)?.[0].replace(/<\/?code>/g, '`') ?? '';
  };
  const inStep = (id: string) => task(id, `Task ${id}`, 'running', 'module.alpha.x');
  const elsewhere = (id: string) => task(id, `Task ${id}`, 'running', '07-phase-2-implement');

  const LEAD = 'Turns `Alpha Search` off now. ';
  const RULE =
    'A task in one of its steps is stopped unless that step is waiting on a form (Retry it once the module is on again); a task waiting on a form there, and every other task, fails when it next runs one of its steps. ';
  const NONE =
    'No listed task is in one of its steps now, so none is stopped; each fails when it next runs one of its steps. ';
  const TWO = LEAD + RULE + '2 listed tasks are in one of its steps now. ' + COPY_TAIL;

  it('says that a task in a step is stopped unless the step waits on a form, and counts the listed tasks in a step: 2', () => {
    expect(copyOf({ tasks: [inStep('a'), inStep('b'), elsewhere('c')] })).toBe(TWO);
  });

  it('counts the listed tasks in a step of this module and no other: 1', () => {
    const beta = task('b', 'Task b', 'running', 'module.beta.x');
    expect(copyOf({ tasks: [inStep('a'), beta, elsewhere('c')] })).toBe(
      LEAD + RULE + '1 listed task is in one of its steps now. ' + COPY_TAIL,
    );
  });

  it('says none is stopped when no listed task is in a step of the module: 0', () => {
    expect(copyOf({ tasks: [elsewhere('c'), elsewhere('d')] })).toBe(LEAD + NONE + COPY_TAIL);
  });

  const MORE = 'More tasks use it than are listed; the same applies to them. ';
  const NONE_CUT =
    'No listed task is in one of its steps now, but more tasks use it than are listed: any of those in one of its steps is stopped unless that step is waiting on a form, and every other task fails when it next runs one of its steps. ';

  it('adds that the tasks not listed are treated the same, after the count of listed ones: 2', () => {
    expect(copyOf({ tasks: [inStep('a'), inStep('b')], capped: true })).toBe(
      LEAD + RULE + '2 listed tasks are in one of its steps now. ' + MORE + COPY_TAIL,
    );
  });

  it('adds it after the count of one listed task as well: 1', () => {
    expect(copyOf({ tasks: [inStep('a'), elsewhere('c')], capped: true })).toBe(
      LEAD + RULE + '1 listed task is in one of its steps now. ' + MORE + COPY_TAIL,
    );
  });

  it('does not say none is stopped when the list was cut and no listed task is in a step: 0', () => {
    const beta = task('d', 'Task d', 'running', 'module.beta.x');
    const copy = copyOf({ tasks: [elsewhere('c'), beta], capped: true });
    expect(copy).toBe(LEAD + NONE_CUT + COPY_TAIL);
    expect(copy).not.toContain('none is stopped');
  });

  it('shows a name as text, never as markup', () => {
    const html = render(blocked({ name: 'Evil **bold** `tick`' }));
    expect(html).not.toContain('<strong>');
    expect(html).toContain('Evil **bold** `tick`');
  });
});

describe('moduleOffNotice', () => {
  const stopped = (id: string, title: string) => ({
    id,
    title,
    killed: 1,
    cancelled: 1,
    stopped: 1,
  });
  const left = (id: string, title: string) => ({
    id,
    title,
    status: 'running',
    currentStepId: '07-x',
  });
  const result = (over: Record<string, unknown> = {}) => ({
    moduleId: 'alpha',
    active: false as const,
    deactivatedAt: '2026-10-15T09:00:00.000Z',
    stopped: [stopped('t1', 'One'), stopped('t2', 'Two')],
    left: [left('t3', 'Three'), left('t4', 'Four'), left('t5', 'Five')],
    failed: [],
    capped: false,
    ...over,
  });
  const titles = new Map([
    ['t1', 'One'],
    ['t6', 'Six <b>'],
  ]);

  it('counts the tasks stopped, left and not stopped', () => {
    expect(moduleOffNotice('Alpha Search', result(), titles)).toBe(
      'Turned off Alpha Search: 2 tasks stopped, 3 left (they fail when they reach one of its steps), 0 could not be stopped.',
    );
  });

  it('says task, not tasks, for one stopped', () => {
    expect(moduleOffNotice('Alpha', result({ stopped: [stopped('t1', 'One')] }), titles)).toContain(
      ': 1 task stopped,',
    );
  });

  it('lists each task it could not stop by the title the dialog listed, else by the title the answer gives', () => {
    const failed = [
      { id: 't6', title: 'Six as answered', error: 'sandbox refused to die' },
      { id: 't9', title: 'Nine, unlisted', error: 'connection reset' },
    ];
    expect(moduleOffNotice('Alpha', result({ failed }), titles)).toBe(
      'Turned off Alpha: 2 tasks stopped, 3 left (they fail when they reach one of its steps), 2 could not be stopped.\n' +
        '- Six <b>: sandbox refused to die\n' +
        '- Nine, unlisted: connection reset',
    );
  });

  it('adds one sentence after the counts when more tasks use the module than were listed', () => {
    expect(moduleOffNotice('Alpha Search', result({ capped: true }), titles)).toBe(
      'Turned off Alpha Search: 2 tasks stopped, 3 left (they fail when they reach one of its steps), 0 could not be stopped. More tasks use it than were listed; those it did not stop fail when they reach one of its steps.',
    );
  });

  it('keeps that sentence ahead of the tasks it could not stop', () => {
    const failed = [{ id: 't6', title: 'Six', error: 'sandbox refused to die' }];
    expect(moduleOffNotice('Alpha', result({ capped: true, failed }), titles)).toBe(
      'Turned off Alpha: 2 tasks stopped, 3 left (they fail when they reach one of its steps), 1 could not be stopped. More tasks use it than were listed; those it did not stop fail when they reach one of its steps.\n' +
        '- Six <b>: sandbox refused to die',
    );
  });

  it('says nothing of more tasks when the list was not cut', () => {
    expect(moduleOffNotice('Alpha', result({ capped: false }), titles)).not.toContain('More tasks');
  });

  it('notes a stopped task whose sandbox kill or whose history record failed, after the ones it could not stop', () => {
    const failed = [{ id: 't9', title: 'Nine', error: 'connection reset' }];
    const stoppedWith = [
      { ...stopped('t1', 'One as answered'), killed: 0, killError: 'docker is not answering' },
      { ...stopped('t2', 'Two'), eventError: 'audit write refused' },
      stopped('t7', 'Seven'),
    ];
    expect(moduleOffNotice('Alpha', result({ stopped: stoppedWith, failed }), titles)).toBe(
      'Turned off Alpha: 3 tasks stopped, 3 left (they fail when they reach one of its steps), 1 could not be stopped.\n' +
        '- Nine: connection reset\n' +
        '- One: stopped, but its sandboxes may still be running (docker is not answering)\n' +
        '- Two: stopped, but the stop is missing from its history (audit write refused)',
    );
  });
});
