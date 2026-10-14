import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { ToastStack, type AttentionToast } from './toast-stack';

// No DOM environment in this package and a click has to change state: ToastStack's two hooks run
// on a plain slot list, the portal and document are faked as in module-tasks-open-dialog.test.tsx.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], next: 0, dirty: false, mounting: true }));

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useState: (initial: unknown) => {
    const at = hooks.next++;
    if (!(at in hooks.slots)) hooks.slots[at] = initial;
    const set = (update: unknown) => {
      const value = typeof update === 'function' ? update(hooks.slots[at]) : update;
      if (!Object.is(value, hooks.slots[at])) {
        hooks.slots[at] = value;
        hooks.dirty = true;
      }
    };
    return [hooks.slots[at], set];
  },
  useEffect: (effect: () => void) => {
    if (hooks.mounting) effect();
  },
}));
vi.mock('react-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-dom')>()),
  createPortal: (children: unknown) => children,
}));
beforeAll(() => vi.stubGlobal('document', { body: {} }));
afterAll(() => vi.unstubAllGlobals());

type El = ReactElement<{
  children?: ReactNode;
  className?: string;
  type?: string;
  tabIndex?: number;
  role?: string;
  'aria-label'?: string;
  onClick?: (event: { stopPropagation: () => void }) => void;
}>;

const flatten = (node: ReactNode): El[] =>
  Array.isArray(node)
    ? node.flatMap(flatten)
    : isValidElement<El['props']>(node)
      ? [node, ...flatten(node.props.children)]
      : [];

const textOf = (node: ReactNode): string =>
  Array.isArray(node)
    ? node.map(textOf).join('')
    : isValidElement<El['props']>(node)
      ? textOf(node.props.children)
      : typeof node === 'string' || typeof node === 'number'
        ? String(node)
        : '';

const nameOf = (el: El) => el.props['aria-label'] ?? textOf(el);
const classesOf = (el: El) => el.props.className?.split(/\s+/) ?? [];
const buttonsIn = (node: ReactNode) => flatten(node).filter((el) => el.type === 'button');

function mount(initial: AttentionToast[]) {
  const onOpen = vi.fn();
  const onDismiss = vi.fn();
  let toasts = initial;
  let tree: ReactNode = null;
  hooks.slots = [];
  hooks.mounting = true;

  const draw = () => {
    for (let pass = 0; pass < 10; pass++) {
      hooks.next = 0;
      hooks.dirty = false;
      tree = ToastStack({ toasts, onOpen, onDismiss });
      hooks.mounting = false;
      if (!hooks.dirty) return;
    }
    throw new Error('ToastStack kept updating its own state');
  };
  draw();

  const button = (name: string) => buttonsIn(tree).find((el) => nameOf(el) === name);
  return {
    onOpen,
    onDismiss,
    button,
    update: (next: AttentionToast[]) => {
      toasts = next;
      draw();
    },
    click: (name: string) => {
      const target = button(name);
      if (!target?.props.onClick) throw new Error(`no "${name}" button to click`);
      target.props.onClick({ stopPropagation: vi.fn() });
      draw();
    },
    root: () => {
      if (!isValidElement<El['props']>(tree)) throw new Error('nothing rendered');
      return tree as El;
    },
    cards: () => flatten(tree).filter((el) => el.key !== null),
    controls: () =>
      buttonsIn(tree)
        .map(nameOf)
        .filter((name) => name !== 'Dismiss notification'),
  };
}

const toast = (n: number): AttentionToast => ({
  key: `t${n}`,
  taskId: `task-${n}`,
  title: `Task ${n}`,
  status: 'waiting_user',
  message: 'Waiting for your input',
});
const toasts = (count: number) => Array.from({ length: count }, (_, i) => toast(i + 1));
const keys = (count: number) => toasts(count).map((t) => t.key);

describe('ToastStack', () => {
  it('shows the newest three of ten and folds the other seven into one "+7 more" control', () => {
    const view = mount(toasts(10));
    expect(view.cards().map((card) => card.key)).toEqual(['t8', 't9', 't10']);
    expect(view.controls()).toEqual(['+7 more', 'Dismiss all']);
  });

  it('expands the whole list in place and collapses it again', () => {
    const view = mount(toasts(10));
    view.click('+7 more');
    expect(view.cards().map((card) => card.key)).toEqual(keys(10));
    expect(view.controls()).toEqual(['Show less', 'Dismiss all']);
    view.click('Show less');
    expect(view.cards().map((card) => card.key)).toEqual(['t8', 't9', 't10']);
    expect(view.controls()).toEqual(['+7 more', 'Dismiss all']);
  });

  it('caps the stack height at the lower half of the viewport', () => {
    expect(classesOf(mount(toasts(10)).root())).toContain('max-h-[calc(50dvh-1rem)]');
  });

  it('scrolls the cards inside that cap and keeps the controls outside the scroll', () => {
    const view = mount(toasts(10));
    const scrolled = () =>
      flatten(view.root()).find((el) => classesOf(el).includes('overflow-y-auto'))?.props.children;
    expect(buttonsIn(scrolled()).map(nameOf)).toEqual(Array(3).fill('Dismiss notification'));
    view.click('+7 more');
    expect(buttonsIn(scrolled()).map(nameOf)).toEqual(Array(10).fill('Dismiss notification'));
  });

  it('leaves room inside the scroll for the focus ring of a card at its edge', () => {
    const root = mount(toasts(1)).root();
    const scroller = flatten(root).find((el) => classesOf(el).includes('overflow-y-auto'));
    expect(scroller).toBeDefined();
    expect(classesOf(scroller!)).toEqual(expect.arrayContaining(['p-1', '-m-1']));
  });

  it('keeps the width it had, so a phone still gets the viewport minus the gutters', () => {
    const classes = classesOf(mount(toasts(10)).root());
    expect(classes).toContain('w-80');
    expect(classes).toContain('max-w-[calc(100vw-2rem)]');
  });

  it('dismisses every toast, the folded ones too, when "Dismiss all" is clicked', () => {
    const view = mount(toasts(10));
    view.click('Dismiss all');
    expect(view.onDismiss.mock.calls.map(([key]) => key)).toEqual(keys(10));
    expect(view.onOpen).not.toHaveBeenCalled();
  });

  it('adds no control at all for a single toast', () => {
    const view = mount(toasts(1));
    expect(view.cards().map((card) => card.key)).toEqual(['t1']);
    expect(view.controls()).toEqual([]);
  });

  it.each([2, 3])('adds only "Dismiss all" for %i toasts, with every card shown', (count) => {
    const view = mount(toasts(count));
    expect(view.cards().map((card) => card.key)).toEqual(keys(count));
    expect(view.controls()).toEqual(['Dismiss all']);
  });

  it('folds exactly the toasts beyond the newest three', () => {
    const view = mount(toasts(4));
    expect(view.cards().map((card) => card.key)).toEqual(['t2', 't3', 't4']);
    expect(view.controls()).toEqual(['+1 more', 'Dismiss all']);
  });

  it('makes every control a real button that stays in the tab order', () => {
    const view = mount(toasts(10));
    for (const name of ['+7 more', 'Dismiss all']) {
      const control = view.button(name);
      expect(control, name).toBeDefined();
      expect(control!.props.type).toBe('button');
      expect(control!.props.tabIndex).toBeUndefined();
    }
  });

  it('starts collapsed again once the stack has emptied', () => {
    const view = mount(toasts(10));
    view.click('+7 more');
    view.update([]);
    view.update(toasts(5));
    expect(view.cards().map((card) => card.key)).toEqual(['t3', 't4', 't5']);
    expect(view.controls()).toEqual(['+2 more', 'Dismiss all']);
  });

  it('keeps each card as it was: click opens the task, the X dismisses without opening', () => {
    const usage: AttentionToast = {
      key: 'usage:claude',
      title: '12% left on the 5h window',
      status: 'usage_low',
      message: 'Claude usage low',
    };
    const view = mount([toast(1), usage]);
    const [task, inert] = view.cards();
    expect(task!.props.role).toBe('button');
    expect(task!.props.tabIndex).toBe(0);
    expect(inert!.props.role).toBeUndefined();
    expect(inert!.props.onClick).toBeUndefined();

    task!.props.onClick!({ stopPropagation: vi.fn() });
    expect(view.onOpen).toHaveBeenCalledWith(toast(1));

    const stopPropagation = vi.fn();
    buttonsIn(task!.props.children)[0]!.props.onClick!({ stopPropagation });
    expect(view.onDismiss).toHaveBeenCalledWith('t1');
    expect(stopPropagation).toHaveBeenCalled();
    expect(view.onOpen).toHaveBeenCalledTimes(1);
  });
});
