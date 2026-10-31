import { describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui';
import type { PlanNode, PlanNodeDetail, PlanTreeNode } from '@/lib/api-client';
import { PlanDetailPanel } from './plan-detail-panel';

// No DOM in this package and a header folds through state: the hooks run on a plain slot list, as
// in task-type-editor.test.tsx, and clicks and keys are dispatched with bubbling and activation.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], next: 0, dirty: false, mounting: true }));
const api = vi.hoisted(() => ({ getPlanNode: vi.fn() }));

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
  useMemo: (fn: () => unknown) => fn(),
  useRef: (initial: unknown) => {
    const at = hooks.next++;
    if (!(at in hooks.slots)) hooks.slots[at] = { current: initial };
    return hooks.slots[at];
  },
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  ...api,
}));

type Ev = {
  key?: string;
  stopPropagation: () => void;
  preventDefault: () => void;
};
type Handler = (event: Ev) => void;
type El = ReactElement<{
  children?: ReactNode;
  className?: string;
  type?: string;
  role?: string;
  tabIndex?: number;
  title?: string;
  'aria-label'?: string;
  'aria-expanded'?: boolean;
  onClick?: Handler;
  onKeyDown?: Handler;
}>;

const flatten = (node: ReactNode): El[] =>
  Array.isArray(node)
    ? node.flatMap(flatten)
    : isValidElement<El['props']>(node)
      ? [node, ...flatten(node.props.children)]
      : [];

const pathTo = (node: ReactNode, target: El): El[] | null => {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = pathTo(child, target);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement<El['props']>(node)) return null;
  if (node === target) return [node];
  const below = pathTo(node.props.children, target);
  return below && [node, ...below];
};

// What a screen reader announces: an aria-label wins, else the content, nested controls included.
const nameOf = (node: ReactNode): string =>
  Array.isArray(node)
    ? node.map(nameOf).join('')
    : isValidElement<El['props']>(node)
      ? (node.props['aria-label'] ?? nameOf(node.props.children))
      : typeof node === 'string' || typeof node === 'number'
        ? String(node)
        : '';

const classesOf = (el: El) => el.props.className?.split(/\s+/) ?? [];

const TAGS = new Set(['button', 'a', 'input', 'select', 'textarea', 'summary']);
const ROLES = new Set(['button', 'link', 'checkbox', 'switch', 'tab', 'menuitem', 'radio']);
const isInteractive = (el: El) =>
  TAGS.has(el.type as string) ||
  el.type === Button ||
  el.type === Link ||
  ROLES.has(el.props.role ?? '') ||
  (el.props.tabIndex ?? -1) >= 0;

const label = (el: El) =>
  `<${typeof el.type === 'string' ? el.type : 'Button'}${el.props.role ? ` role=${el.props.role}` : ''}> "${nameOf(el).slice(0, 30)}"`;

const nested = (tree: ReactNode) =>
  flatten(tree)
    .filter(isInteractive)
    .flatMap((outer) =>
      flatten(outer.props.children)
        .filter(isInteractive)
        .map((inner) => `${label(outer)} holds ${label(inner)}`),
    );

function fire(tree: ReactNode, target: El, name: 'onClick' | 'onKeyDown', key?: string) {
  const chain = pathTo(tree, target);
  if (!chain) throw new Error('the target is not in the tree');
  let stopped = false;
  let prevented = false;
  const event: Ev = {
    key,
    stopPropagation: () => {
      stopped = true;
    },
    preventDefault: () => {
      prevented = true;
    },
  };
  for (const el of chain.toReversed()) {
    el.props[name]?.(event);
    if (stopped) break;
  }
  return { stopped, prevented };
}

const click = (tree: ReactNode, target: El) => fire(tree, target, 'onClick');

function press(tree: ReactNode, target: El, key: string) {
  const { prevented } = fire(tree, target, 'onKeyDown', key);
  const native = target.type === 'button' || target.type === Button;
  if (!prevented && native && (key === 'Enter' || key === ' ')) click(tree, target);
}

const node = (id: string, title: string): PlanNode => ({
  id,
  parentId: null,
  path: `/${id}/`,
  ordinal: 0,
  title,
  kind: 'component',
  body: null,
  status: 'todo',
  taskable: true,
  version: 1,
  createdBy: 'user',
  sourceTaskId: null,
  directChildren: 0,
  totalDescendants: 0,
  rolledStatus: 'todo',
  sequence: 1,
  blockedBy: [],
  driftedTasks: 0,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
});
const treeNode = (id: string, title: string): PlanTreeNode => ({
  id,
  parentId: null,
  title,
  kind: 'component',
  status: 'todo',
  rolledStatus: 'todo',
  taskable: true,
  directChildren: 0,
  totalDescendants: 0,
  sequence: 1,
  blockedCount: 0,
  driftedTasks: 0,
});
const DETAIL: PlanNodeDetail = {
  node: node('n0', 'Checkout'),
  ancestry: [],
  children: [],
  edges: [
    {
      id: 'e1',
      fromNodeId: 'n0',
      toNodeId: 'n1',
      kind: 'depends_on',
      note: null,
      fromTitle: 'Checkout',
      toTitle: 'Auth service',
    },
    {
      id: 'e2',
      fromNodeId: 'n2',
      toNodeId: 'n0',
      kind: 'depends_on',
      note: null,
      fromTitle: 'Billing',
      toTitle: 'Checkout',
    },
  ],
  codeLinks: [],
  tasks: [],
};
const OPEN = 'depends_on:out';
const OPEN_TOO = 'depends_on:in';
const FOLDED = 'affects:out';
const FOLDED_TOO = 'implements:out';
const LABELS: Record<string, string> = {
  [OPEN]: 'Depends on',
  [OPEN_TOO]: 'Depended on by',
  [FOLDED]: 'Affects',
  [FOLDED_TOO]: 'Implements',
};

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function mount() {
  hooks.slots = [];
  hooks.mounting = true;
  api.getPlanNode.mockReset();
  api.getPlanNode.mockResolvedValue(DETAIL);
  const props = {
    repositoryId: 'r1',
    chatDrafts: new Map<string, string>(),
    nodeId: 'n0',
    tree: [treeNode('n0', 'Checkout'), treeNode('n1', 'Auth service'), treeNode('n2', 'Billing')],
    tab: 'links' as const,
    onTabChange: vi.fn(),
    unreadCount: 0,
    onRead: vi.fn(),
    onChanged: vi.fn(),
    onNavigate: vi.fn(),
    onClose: vi.fn(),
  };
  let tree: ReactNode = null;
  const draw = () => {
    for (let pass = 0; pass < 10; pass++) {
      hooks.next = 0;
      hooks.dirty = false;
      tree = PlanDetailPanel(props);
      hooks.mounting = false;
      if (!hooks.dirty) return;
    }
    throw new Error('the panel kept updating its own state');
  };
  draw();
  await flush();
  draw();

  const group = (id: string) => {
    const found = flatten(tree).find((el) => el.key === id);
    if (!found) throw new Error(`no group ${id}`);
    return found;
  };
  const inside = (id: string) => flatten(group(id).props.children);
  const fold = (id: string) => inside(id).find((el) => el.props['aria-expanded'] !== undefined)!;
  const add = (id: string) =>
    inside(id).find((el) => el.props['aria-label']?.startsWith('Add to '))!;
  const kindOf = (el: El) =>
    el.props['aria-expanded'] !== undefined
      ? 'fold'
      : el.props['aria-label']?.startsWith('Add to ')
        ? 'add'
        : nameOf(el);
  return {
    tree: () => tree,
    group,
    fold,
    add,
    kinds: (id: string) => inside(id).filter(isInteractive).map(kindOf),
    expanded: (id: string) => fold(id).props['aria-expanded'],
    adding: (id: string) => inside(id).some((el) => el.type === 'select'),
    click: (target: El) => {
      const result = click(tree, target);
      draw();
      return result;
    },
    press: (target: El, key: string) => {
      press(tree, target, key);
      draw();
    },
  };
}

describe('PlanDetailPanel link groups nesting', () => {
  it('holds no control inside another control', async () => {
    const view = await mount();
    expect(nested(view.tree())).toEqual([]);
  });

  describe('the checker', () => {
    const header = (
      <button type="button" aria-expanded>
        <span>Depends on</span>
        <span role="button" tabIndex={0} aria-label="Add to depends on" />
      </button>
    );

    it('flags a header whose add control sits inside its fold button', () => {
      expect(nested(header)).toHaveLength(1);
    });

    it('flags a link that wraps a button', () => {
      expect(
        nested(
          <Link href="/tasks/new">
            <Button>Create</Button>
          </Link>,
        ),
      ).toHaveLength(1);
    });

    it('does not flag a header whose controls are siblings', () => {
      expect(
        nested(
          <div>
            <button type="button" aria-expanded>
              Depends on
            </button>
            <button type="button" aria-label="Add to depends on" />
          </div>,
        ),
      ).toEqual([]);
    });
  });
});

describe('PlanDetailPanel link group controls', () => {
  it('shows a group with links open and an empty one folded, as it did', async () => {
    const view = await mount();
    expect([OPEN, OPEN_TOO, FOLDED, FOLDED_TOO].map(view.expanded)).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });

  it('names the fold button after its group and the add control after the group it adds to', async () => {
    const view = await mount();
    for (const id of [OPEN, OPEN_TOO, FOLDED, FOLDED_TOO]) {
      expect(nameOf(view.fold(id)), id).toContain(LABELS[id]);
      expect(nameOf(view.add(id)), id).toBe(`Add to ${LABELS[id]!.toLowerCase()}`);
    }
  });

  it('keeps the name of the add control out of the name of the fold button', async () => {
    const view = await mount();
    expect(nameOf(view.fold(OPEN))).not.toContain('Add to');
  });

  it('keeps the tab order: fold, add, then the rows of the group', async () => {
    const view = await mount();
    expect(view.kinds(OPEN)).toEqual(['fold', 'add', 'Auth service', 'remove']);
    expect(view.kinds(OPEN_TOO)).toEqual(['fold', 'add', 'Billing', 'remove']);
    expect(view.kinds(FOLDED)).toEqual(['fold', 'add']);
    expect(view.kinds(FOLDED_TOO)).toEqual(['fold', 'add']);
  });

  it('leaves both controls reachable by Tab', async () => {
    const view = await mount();
    for (const control of [view.fold(OPEN), view.add(OPEN)]) {
      expect(control.props.tabIndex ?? 0).toBe(0);
    }
  });

  it('folds and unfolds once per click on the fold button, and opens no add row', async () => {
    const view = await mount();
    view.click(view.fold(OPEN));
    expect(view.expanded(OPEN)).toBe(false);
    view.click(view.fold(OPEN));
    expect(view.expanded(OPEN)).toBe(true);
    view.click(view.fold(FOLDED));
    expect(view.expanded(FOLDED)).toBe(true);
    expect(view.adding(FOLDED)).toBe(false);
  });

  it('opens the add row on a click of the +, and a group that was open stays open', async () => {
    const view = await mount();
    view.click(view.add(OPEN));
    expect(view.expanded(OPEN)).toBe(true);
    expect(view.adding(OPEN)).toBe(true);
    expect(view.adding(OPEN_TOO)).toBe(false);
  });

  it('unfolds a folded group on a click of its +, and opens the add row in it', async () => {
    const view = await mount();
    view.click(view.add(FOLDED));
    expect(view.expanded(FOLDED)).toBe(true);
    expect(view.adding(FOLDED)).toBe(true);
  });

  it('closes the add row on a second click of the +, and the group stays open', async () => {
    const view = await mount();
    view.click(view.add(OPEN));
    view.click(view.add(OPEN));
    expect(view.adding(OPEN)).toBe(false);
    expect(view.expanded(OPEN)).toBe(true);
  });

  it('needs no stopPropagation: the + is not inside anything that listens', async () => {
    const view = await mount();
    expect(view.click(view.add(OPEN)).stopped).toBe(false);
  });

  it('folds once on Enter and once on Space at the fold button', async () => {
    const view = await mount();
    view.press(view.fold(OPEN), 'Enter');
    expect(view.expanded(OPEN)).toBe(false);
    view.press(view.fold(OPEN), ' ');
    expect(view.expanded(OPEN)).toBe(true);
    expect(view.adding(OPEN)).toBe(false);
  });

  it('opens the add row once on Enter and closes it once on Space at the + of an open group', async () => {
    const view = await mount();
    view.press(view.add(OPEN), 'Enter');
    expect(view.adding(OPEN)).toBe(true);
    expect(view.expanded(OPEN)).toBe(true);
    view.press(view.add(OPEN), ' ');
    expect(view.adding(OPEN)).toBe(false);
    expect(view.expanded(OPEN)).toBe(true);
  });

  it.each(['Enter', ' '])(
    'does with %j at the + of a folded group what a click does: unfolds it and opens the row',
    async (key) => {
      const view = await mount();
      view.press(view.add(FOLDED), key);
      expect(view.expanded(FOLDED)).toBe(true);
      expect(view.adding(FOLDED)).toBe(true);
    },
  );
});

describe('PlanDetailPanel link group stretched target', () => {
  it('makes both controls real buttons and keeps the + tooltip', async () => {
    const view = await mount();
    const [fold, add] = [view.fold(OPEN), view.add(OPEN)];
    expect([fold.type, fold.props.type]).toEqual(['button', 'button']);
    expect([add.type, add.props.type]).toEqual(['button', 'button']);
    expect(add.props.role).toBeUndefined();
    expect(add.props.title).toBe('Add to depends on');
  });

  it('keeps the whole header clickable for the mouse: the fold button stretches over it, the + sits above', async () => {
    const view = await mount();
    const fold = view.fold(OPEN);
    const header = pathTo(view.group(OPEN), fold)!.at(-2)!;
    expect(header.type).toBe('div');
    expect(classesOf(header)).toEqual(
      expect.arrayContaining(['relative', 'flex', 'items-center', 'gap-1.5', 'px-2', 'py-1.5']),
    );
    expect(classesOf(fold)).toEqual(expect.arrayContaining(['after:absolute', 'after:inset-0']));
    expect(classesOf(fold)).not.toContain('relative');
    expect(classesOf(view.add(OPEN))).toEqual(expect.arrayContaining(['relative', 'z-10']));
  });

  it('shows the keyboard focus of the fold button as a ring around the whole header', async () => {
    const view = await mount();
    expect(classesOf(view.fold(OPEN))).toEqual(
      expect.arrayContaining(['focus-visible:outline-none', 'focus-visible:after:outline-2']),
    );
  });

  it('keeps the link count at the right end of the header', async () => {
    const view = await mount();
    const fold = view.fold(OPEN);
    const header = pathTo(view.group(OPEN), fold)!.at(-2)!;
    const count = flatten(header.props.children).find((el) => classesOf(el).includes('ml-auto'));
    expect(nameOf(count)).toBe('1');
  });

  it('draws a down chevron on an open group and a right one on a folded group', async () => {
    const view = await mount();
    const chevron = (id: string) =>
      flatten(view.fold(id).props.children).find(
        (el) => el.type === ChevronDown || el.type === ChevronRight,
      )?.type;
    expect(chevron(OPEN)).toBe(ChevronDown);
    expect(chevron(FOLDED)).toBe(ChevronRight);
  });
});
