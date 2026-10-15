import { describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Button } from '@/components/ui';
import type { PlanNode } from '@/lib/api-client';
import { PlanCardGrid } from './plan-card-grid';

// No DOM in this package: PlanCardGrid has no hooks, so it is called as a function and its element
// tree walked. Clicks and keys are dispatched over it with the bubbling and native activation.
type Ev = {
  key?: string;
  target: { checked: boolean };
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
  checked?: boolean;
  'aria-label'?: string;
  onClick?: Handler;
  onDoubleClick?: Handler;
  onKeyDown?: Handler;
  onChange?: Handler;
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

const VOID = new Set(['input', 'br', 'hr', 'img']);
const nestedInHtml = (html: string) => {
  const open: { tag: string; interactive: boolean }[] = [];
  const found: string[] = [];
  for (const [, closing, tag, attrs] of html.matchAll(/<(\/?)([a-z][a-z0-9-]*)([^>]*)>/gi)) {
    if (closing) {
      const at = open.findLastIndex((o) => o.tag === tag);
      if (at >= 0) open.length = at;
      continue;
    }
    const interactive =
      TAGS.has(tag!) ||
      /\brole="(button|link|checkbox|switch|tab|menuitem|radio)"/.test(attrs!) ||
      /\btabindex="\d+"/.test(attrs!);
    const outer = open.findLast((o) => o.interactive);
    if (interactive && outer) found.push(`<${tag}> inside <${outer.tag}>`);
    if (!VOID.has(tag!) && !attrs!.endsWith('/')) open.push({ tag: tag!, interactive });
  }
  return found;
};

function fire(
  tree: ReactNode,
  target: El,
  name: 'onClick' | 'onDoubleClick' | 'onKeyDown',
  key?: string,
) {
  const chain = pathTo(tree, target);
  if (!chain) throw new Error('the target is not in the tree');
  let stopped = false;
  let prevented = false;
  const event: Ev = {
    key,
    target: { checked: !target.props.checked },
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
  return { stopped, prevented, event };
}

const isCheckbox = (el: El) => el.type === 'input' && el.props.type === 'checkbox';

function click(tree: ReactNode, target: El) {
  const result = fire(tree, target, 'onClick');
  if (isCheckbox(target) && !result.prevented) target.props.onChange?.(result.event);
  return result;
}

function press(tree: ReactNode, target: El, key: string) {
  const { prevented } = fire(tree, target, 'onKeyDown', key);
  const native = target.type === 'button' || target.type === Button;
  const activates = native ? key === 'Enter' || key === ' ' : isCheckbox(target) && key === ' ';
  if (!prevented && activates) click(tree, target);
}

const node = (over: Pick<PlanNode, 'id' | 'title'> & Partial<PlanNode>): PlanNode => ({
  parentId: 'root',
  path: '/root/',
  ordinal: 0,
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
  ...over,
});
const parent = node({
  id: 'n1',
  title: 'Auth service',
  sequence: 3,
  directChildren: 3,
  totalDescendants: 12,
  body: 'See [the spec](https://example.com/spec) first.',
});
const leaf = node({ id: 'n2', title: 'Billing', sequence: 4 });
const decision = node({ id: 'n3', title: 'Pick a vendor', kind: 'decision', taskable: false });

type Props = Parameters<typeof PlanCardGrid>[0];

function mount(over: Partial<Props> = {}) {
  const onSelect = vi.fn();
  const onDescend = vi.fn();
  const onPick = vi.fn();
  const props: Props = {
    nodes: [parent, leaf],
    selectedId: null,
    onSelect,
    onDescend,
    onPick,
    emptyMessage: 'Nothing here',
    ...over,
  };
  const tree = PlanCardGrid(props);
  const cards = [(tree as El).props.children].flat() as El[];
  const controls = (card: El) => [card, ...flatten(card.props.children)].filter(isInteractive);
  const kindOf = (el: El) =>
    isCheckbox(el) ? 'tick' : nameOf(el) === 'Open →' ? 'open' : 'select';
  const pick = (card: El, kind: string) => controls(card).find((el) => kindOf(el) === kind)!;
  return {
    tree,
    props,
    onSelect,
    onDescend,
    onPick,
    cards,
    controls,
    kinds: (card: El) => controls(card).map(kindOf),
    select: (card: El) => pick(card, 'select'),
    tick: (card: El) => pick(card, 'tick'),
    open: (card: El) => pick(card, 'open'),
  };
}

describe('PlanCardGrid nesting', () => {
  it('holds no control inside another control', () => {
    expect(nested(mount().tree)).toEqual([]);
  });

  it('holds none in the rendered markup either, a link in a node body included', () => {
    const view = mount();
    const html = renderToStaticMarkup(<PlanCardGrid {...view.props} />);
    expect(html).toContain('<a ');
    expect(html).toContain('type="checkbox"');
    expect(nestedInHtml(html)).toEqual([]);
  });

  describe('the checker', () => {
    const nests: [string, ReactNode][] = [
      [
        'a checkbox in a div with the button role',
        <div role="button" tabIndex={0}>
          <input type="checkbox" aria-label="Tick" />
        </div>,
      ],
      [
        'a role=button span in a button',
        <button type="button">
          <span role="button" tabIndex={0} aria-label="Add" />
        </button>,
      ],
      [
        'a button in a div with the button role',
        <div role="button" tabIndex={0}>
          <button type="button">Open</button>
        </div>,
      ],
      [
        'a link in a div with the button role',
        <div role="button" tabIndex={0}>
          <a href="/spec">Spec</a>
        </div>,
      ],
      [
        'a Button in a link',
        <a href="/new">
          <Button>New</Button>
        </a>,
      ],
    ];

    it.each(nests)('flags %s', (_, fixture) => {
      expect(nested(fixture)).toHaveLength(1);
      expect(nestedInHtml(renderToStaticMarkup(fixture))).toHaveLength(1);
    });

    it('does not flag controls that are siblings', () => {
      const siblings = (
        <div>
          <button type="button">Select</button>
          <input type="checkbox" aria-label="Tick" />
          <a href="/spec">Spec</a>
        </div>
      );
      expect(nested(siblings)).toEqual([]);
      expect(nestedInHtml(renderToStaticMarkup(siblings))).toEqual([]);
    });
  });
});

describe('PlanCardGrid controls', () => {
  it('names the select control after the node and the others after themselves', () => {
    const view = mount();
    const [card] = view.cards;
    expect(nameOf(view.select(card!))).toContain('Auth service');
    expect(nameOf(view.tick(card!))).toBe('Include "Auth service" in one task');
    expect(nameOf(view.open(card!))).toBe('Open →');
  });

  it('keeps the name of the other controls out of the name of the select control', () => {
    const view = mount();
    const name = nameOf(view.select(view.cards[0]!));
    expect(name).not.toContain('Include');
    expect(name).not.toContain('Open →');
  });

  it('keeps the tab order: select, tick, Open', () => {
    const view = mount({ nodes: [parent, leaf, decision] });
    expect(view.cards.map(view.kinds)).toEqual([
      ['select', 'tick', 'open'],
      ['select', 'tick'],
      ['select'],
    ]);
    const noTick = mount({ onPick: undefined });
    expect(noTick.kinds(noTick.cards[0]!)).toEqual(['select', 'open']);
  });

  it('leaves every control reachable by Tab: none is taken out of the order', () => {
    const view = mount();
    for (const control of view.controls(view.cards[0]!)) {
      expect(control.props.tabIndex ?? 0).toBe(0);
    }
  });

  it('selects the node once when its select control is clicked, and does nothing else', () => {
    const view = mount();
    click(view.tree, view.select(view.cards[0]!));
    expect(view.onSelect).toHaveBeenCalledTimes(1);
    expect(view.onSelect).toHaveBeenCalledWith(parent);
    expect(view.onPick).not.toHaveBeenCalled();
    expect(view.onDescend).not.toHaveBeenCalled();
  });

  it('ticks the node once when the tick is clicked, without selecting or descending', () => {
    const view = mount();
    click(view.tree, view.tick(view.cards[0]!));
    expect(view.onPick).toHaveBeenCalledTimes(1);
    expect(view.onPick).toHaveBeenCalledWith(parent, true);
    expect(view.onSelect).not.toHaveBeenCalled();
    expect(view.onDescend).not.toHaveBeenCalled();
  });

  it('descends once when Open is clicked, without selecting', () => {
    const view = mount();
    click(view.tree, view.open(view.cards[0]!));
    expect(view.onDescend).toHaveBeenCalledTimes(1);
    expect(view.onDescend).toHaveBeenCalledWith(parent);
    expect(view.onSelect).not.toHaveBeenCalled();
    expect(view.onPick).not.toHaveBeenCalled();
  });

  it('needs no stopPropagation: the tick and Open are not inside anything that listens', () => {
    const view = mount();
    const [card] = view.cards;
    expect(click(view.tree, view.tick(card!)).stopped).toBe(false);
    expect(click(view.tree, view.open(card!)).stopped).toBe(false);
  });

  it('selects once on Enter', () => {
    const view = mount();
    press(view.tree, view.select(view.cards[0]!), 'Enter');
    expect(view.onSelect).toHaveBeenCalledTimes(1);
    expect(view.onSelect).toHaveBeenCalledWith(parent);
  });

  it('selects once on Space too, as a real button does', () => {
    const view = mount();
    press(view.tree, view.select(view.cards[0]!), ' ');
    expect(view.onSelect).toHaveBeenCalledTimes(1);
  });

  it('descends on ArrowRight only a node that has children', () => {
    const view = mount();
    press(view.tree, view.select(view.cards[0]!), 'ArrowRight');
    expect(view.onDescend).toHaveBeenCalledTimes(1);
    expect(view.onDescend).toHaveBeenCalledWith(parent);
    press(view.tree, view.select(view.cards[1]!), 'ArrowRight');
    expect(view.onDescend).toHaveBeenCalledTimes(1);
    expect(view.onSelect).not.toHaveBeenCalled();
  });

  it('descends once on Enter at Open, without selecting', () => {
    const view = mount();
    press(view.tree, view.open(view.cards[0]!), 'Enter');
    expect(view.onDescend).toHaveBeenCalledTimes(1);
    expect(view.onSelect).not.toHaveBeenCalled();
  });

  it('ticks once on Space at the tick, without selecting', () => {
    const view = mount();
    press(view.tree, view.tick(view.cards[0]!), ' ');
    expect(view.onPick).toHaveBeenCalledTimes(1);
    expect(view.onSelect).not.toHaveBeenCalled();
  });

  it('descends on a double click of the card, only for a node that has children', () => {
    const view = mount();
    fire(view.tree, view.select(view.cards[0]!), 'onDoubleClick');
    expect(view.onDescend).toHaveBeenCalledTimes(1);
    expect(view.onDescend).toHaveBeenCalledWith(parent);
    fire(view.tree, view.select(view.cards[1]!), 'onDoubleClick');
    expect(view.onDescend).toHaveBeenCalledTimes(1);
  });

  it('does not descend when the tick is double-clicked', () => {
    const view = mount();
    fire(view.tree, view.tick(view.cards[0]!), 'onDoubleClick');
    expect(view.onDescend).not.toHaveBeenCalled();
  });

  it('shows the selected card with its ring and an unselected one with its hover border', () => {
    const [selected, other] = mount({ selectedId: 'n1' }).cards;
    expect(classesOf(selected!)).toEqual(expect.arrayContaining(['border-indigo-500', 'ring-1']));
    expect(classesOf(other!)).toContain('hover:border-neutral-700');
    expect(classesOf(other!)).not.toContain('border-indigo-500');
  });
});

describe('PlanCardGrid stretched target', () => {
  it('keeps no role, tab stop or handler on the card itself', () => {
    const [card] = mount().cards;
    expect(card!.type).toBe('div');
    for (const prop of ['role', 'tabIndex', 'onClick', 'onDoubleClick', 'onKeyDown'] as const) {
      expect(card!.props[prop], prop).toBeUndefined();
    }
  });

  it('makes the select control a real button that stretches over the whole card', () => {
    const view = mount();
    const [card] = view.cards;
    const select = view.select(card!);
    expect(select.type).toBe('button');
    expect(select.props.type).toBe('button');
    expect(classesOf(card!)).toContain('relative');
    expect(classesOf(select)).toEqual(
      expect.arrayContaining(['after:absolute', 'after:inset-0', 'cursor-pointer']),
    );
    expect(classesOf(select)).not.toContain('relative');
  });

  it('raises the tick, Open and any link in the body above the stretched target', () => {
    const view = mount();
    const [card] = view.cards;
    for (const raised of [view.tick(card!), view.open(card!)]) {
      expect(classesOf(raised), nameOf(raised)).toEqual(
        expect.arrayContaining(['relative', 'z-10']),
      );
    }
    const body = flatten(card!.props.children).find((el) => classesOf(el).includes('line-clamp-2'));
    expect(classesOf(body!)).toEqual(expect.arrayContaining(['[&_a]:relative', '[&_a]:z-10']));
  });

  it('raises every titled span above the stretched target, so its title still shows', () => {
    const view = mount();
    const [card] = view.cards;
    const titleOf = (el: El) => (el.props as { title?: unknown }).title;
    const titled = flatten(card!.props.children).filter(
      (el) => el.type === 'span' && typeof titleOf(el) === 'string',
    );
    expect(titled.length).toBeGreaterThanOrEqual(3);
    for (const el of titled) {
      expect(classesOf(el), String(titleOf(el))).toEqual(
        expect.arrayContaining(['relative', 'z-10']),
      );
    }
  });

  it('keeps the tick ahead of the title on screen while the select button stays first to Tab', () => {
    const view = mount();
    const [card] = view.cards;
    expect(classesOf(view.select(card!))).toContain('order-1');
    expect(classesOf(view.tick(card!)).filter((name) => name.startsWith('order-'))).toEqual([]);
  });

  it('shows the keyboard focus of the select button as a ring around the whole card', () => {
    const view = mount();
    expect(classesOf(view.select(view.cards[0]!))).toEqual(
      expect.arrayContaining(['focus-visible:outline-none', 'focus-visible:after:outline-2']),
    );
  });
});
