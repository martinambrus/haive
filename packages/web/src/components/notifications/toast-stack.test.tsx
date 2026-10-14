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
  'aria-live'?: string;
  onClick?: (event: { stopPropagation: () => void }) => void;
  onKeyDown?: unknown;
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
  const cards = () => flatten(tree).filter((el) => el.type === 'div' && el.key !== null);
  const region = () => flatten(tree).find((el) => el.props.role === 'status');
  const lineKey = () => {
    const line = region()?.props.children;
    return isValidElement(line) ? line.key : null;
  };
  return {
    onOpen,
    onDismiss,
    button,
    cards,
    region,
    tree: () => tree,
    announced: () => textOf(region()?.props.children),
    lineKey,
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
    controls: () => {
      const inCards = cards().flatMap((card) => buttonsIn(card.props.children));
      return buttonsIn(tree)
        .filter((el) => !inCards.includes(el))
        .map(nameOf);
    },
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
const usage: AttentionToast = {
  key: 'usage:claude',
  title: '12% left on the 5h window',
  status: 'usage_low',
  message: 'Claude usage low',
};
const openName = (n: number) => `Waiting for your inputTask ${n}Click to open the task`;
const announcement = (n: number) => `Waiting for your input: Task ${n}`;
const cardButtons = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => [
    openName(from + i),
    `Dismiss notification: Task ${from + i}`,
  ]).flat();

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
    expect(buttonsIn(scrolled()).map(nameOf)).toEqual(cardButtons(8, 10));
    view.click('+7 more');
    expect(buttonsIn(scrolled()).map(nameOf)).toEqual(cardButtons(1, 10));
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
    const view = mount([toast(1), usage]);
    const [task, inert] = view.cards();
    expect(task!.props.role).toBeUndefined();
    expect(task!.props.tabIndex).toBeUndefined();
    expect(task!.props.onClick).toBeUndefined();
    expect(inert!.props.role).toBeUndefined();
    expect(inert!.props.onClick).toBeUndefined();

    const [open, dismiss] = buttonsIn(task!.props.children);
    expect([open, dismiss].map((el) => nameOf(el!))).toEqual([
      openName(1),
      'Dismiss notification: Task 1',
    ]);
    open!.props.onClick!({ stopPropagation: vi.fn() });
    expect(view.onOpen).toHaveBeenCalledWith(toast(1));
    expect(view.onDismiss).not.toHaveBeenCalled();

    const stopPropagation = vi.fn();
    dismiss!.props.onClick!({ stopPropagation });
    expect(view.onDismiss).toHaveBeenCalledWith('t1');
    expect(stopPropagation).not.toHaveBeenCalled();
    expect(view.onOpen).toHaveBeenCalledTimes(1);
  });

  it('gives nothing the button role and nests no button in a button', () => {
    const isButton = (el: El) => el.type === 'button' || el.props.role === 'button';
    const view = mount([...toasts(5), usage]);
    for (const expand of [false, true]) {
      if (expand) view.click('+3 more');
      const all = flatten(view.tree());
      expect(all.filter((el) => el.props.role === 'button')).toEqual([]);
      expect(all.filter((el) => el.props.tabIndex !== undefined)).toEqual([]);
      expect(all.filter((el) => el.props.onKeyDown !== undefined)).toEqual([]);
      for (const outer of all.filter(isButton)) {
        expect(flatten(outer.props.children).filter(isButton), nameOf(outer)).toEqual([]);
      }
    }
  });

  it('holds the text and the hint in the open button, and gives a toast with no task a plain card', () => {
    const [task, inert] = mount([toast(1), usage]).cards();
    const [open] = buttonsIn(task!.props.children);
    expect(open!.props.type).toBe('button');
    expect(textOf(open!)).toBe('Waiting for your inputTask 1Click to open the task');
    expect(buttonsIn(inert!.props.children).map(nameOf)).toEqual([
      'Dismiss notification: 12% left on the 5h window',
    ]);
    expect(textOf(inert!.props.children)).toBe('Claude usage low12% left on the 5h window');
  });

  it('keeps the whole card clickable for the mouse: the open button stretches over it, the X sits above', () => {
    const [card] = mount([toast(1)]).cards();
    const [open, dismiss] = buttonsIn(card!.props.children);
    expect(classesOf(card!)).toContain('relative');
    expect(classesOf(open!)).toEqual(expect.arrayContaining(['after:absolute', 'after:inset-0']));
    expect(classesOf(dismiss!)).toEqual(expect.arrayContaining(['relative', 'z-10']));
  });

  it('shows the keyboard focus of the open button as a ring around the whole card', () => {
    const [card] = mount([toast(1)]).cards();
    const [open] = buttonsIn(card!.props.children);
    expect(classesOf(open!)).toEqual(
      expect.arrayContaining(['focus-visible:outline-none', 'focus-visible:after:outline-2']),
    );
  });

  it('keeps a polite live region while no toast shows, so one exists before the first toast', () => {
    const view = mount([]);
    const region = view.region();
    expect(region?.props.role).toBe('status');
    expect(region?.props['aria-live']).toBe('polite');
    expect(classesOf(region!)).toContain('sr-only');
    expect(view.announced()).toBe('');
    expect(view.cards()).toEqual([]);
    expect(view.controls()).toEqual([]);
  });

  it('renders the live region in the same place with and without toasts, so it is never recreated', () => {
    const slotOfRegion = (node: ReactNode) => {
      const parts = isValidElement<El['props']>(node) ? [node.props.children].flat() : [];
      return parts.findIndex(
        (part) => isValidElement<El['props']>(part) && part.props.role === 'status',
      );
    };
    const view = mount([]);
    const empty = slotOfRegion(view.tree());
    view.update(toasts(2));
    expect(empty).toBeGreaterThanOrEqual(0);
    expect(slotOfRegion(view.tree())).toBe(empty);
  });

  it('announces "<message>: <title>" of a toast that was not in the list before', () => {
    const view = mount([]);
    view.update([toast(1)]);
    expect(view.announced()).toBe(announcement(1));
    view.update([toast(1), usage]);
    expect(view.announced()).toBe('Claude usage low: 12% left on the 5h window');
  });

  it('keeps the text when the newest of two is dismissed, and when the list empties', () => {
    const view = mount([]);
    view.update(toasts(2));
    const heard = [view.announced(), view.lineKey()];
    expect(heard[0]).toBe(announcement(2));
    view.update(toasts(1));
    expect([view.announced(), view.lineKey()]).toEqual(heard);
    view.update([]);
    expect([view.announced(), view.lineKey()]).toEqual(heard);
  });

  it('keeps the text when the list is expanded and collapsed', () => {
    const view = mount([]);
    view.update(toasts(5));
    const heard = [view.announced(), view.lineKey()];
    expect(heard[0]).toBe(announcement(5));
    view.click('+2 more');
    expect([view.announced(), view.lineKey()]).toEqual(heard);
    view.click('Show less');
    expect([view.announced(), view.lineKey()]).toEqual(heard);
  });

  it('replaces the text with the newest of the keys that are new', () => {
    const view = mount([]);
    view.update(toasts(2));
    view.update(toasts(3));
    expect(view.announced()).toBe(announcement(3));
    view.update([...toasts(3), toast(4), toast(5)]);
    expect(view.announced()).toBe(announcement(5));
  });

  it('counts a key that left and came back as new, but not one that only moved', () => {
    const view = mount([]);
    view.update(toasts(2));
    const heard = [view.announced(), view.lineKey()];
    view.update([toast(2), toast(1)]);
    expect([view.announced(), view.lineKey()]).toEqual(heard);
    view.update([toast(2)]);
    view.update([toast(2), toast(1)]);
    expect(view.announced()).toBe(announcement(1));
  });

  it('announces a toast that comes back with the very same text as a new line', () => {
    const view = mount([]);
    view.update([toast(1)]);
    const first = view.lineKey();
    view.update([]);
    expect(view.lineKey()).toBe(first);
    view.update([toast(1)]);
    expect(view.announced()).toBe(announcement(1));
    expect(view.lineKey()).not.toBe(first);
  });
});
