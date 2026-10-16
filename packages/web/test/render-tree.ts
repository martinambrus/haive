// A small stand-in for a DOM renderer: hooks keep their state per position in the tree, and host elements come back as plain nodes.
type Props = Record<string, unknown>;

export interface Host {
  tag: string;
  props: Props;
  kids: Array<Host | string>;
  parent: Host | null;
}

interface Instance {
  slots: unknown[];
  at: number;
}

interface ElementLike {
  $$typeof: symbol;
  type: unknown;
  key: string | null;
  props: Props;
}

interface Tagged {
  $$typeof?: symbol;
  type?: unknown;
  render?: (props: Props, ref: unknown) => unknown;
  _currentValue?: unknown;
  displayName?: string;
}

const ELEMENT_TAGS = [Symbol.for('react.transitional.element'), Symbol.for('react.element')];
const PASS_THROUGH = new Set<unknown>([
  Symbol.for('react.fragment'),
  Symbol.for('react.suspense'),
  Symbol.for('react.strict_mode'),
]);
const FORWARD_REF = Symbol.for('react.forward_ref');
const MEMO = Symbol.for('react.memo');
const CONTEXT = Symbol.for('react.context');
const PORTAL = Symbol.for('react.portal');

let current: Instance | null = null;
let dirty = false;
let queued: Array<() => void> = [];
let sequence = 0;

const isObject = (value: unknown): value is Tagged => typeof value === 'object' && value !== null;
const isElement = (value: unknown): value is ElementLike =>
  isObject(value) && ELEMENT_TAGS.includes(value.$$typeof as symbol);

function slot<T>(make: () => T): T {
  if (current === null) throw new Error('a hook ran outside the test renderer');
  const at = current.at++;
  if (!(at in current.slots)) current.slots[at] = make();
  return current.slots[at] as T;
}

const sameDeps = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined) =>
  a !== undefined &&
  b !== undefined &&
  a.length === b.length &&
  a.every((value, i) => Object.is(value, b[i]));

interface MemoCell {
  has: boolean;
  deps: readonly unknown[] | undefined;
  value: unknown;
}

function memo<T>(make: () => T, deps: readonly unknown[] | undefined): T {
  const cell = slot<MemoCell>(() => ({ has: false, deps: undefined, value: undefined }));
  if (!cell.has || !sameDeps(deps, cell.deps)) {
    cell.value = make();
    cell.deps = deps;
    cell.has = true;
  }
  return cell.value as T;
}

interface EffectCell {
  has: boolean;
  deps: readonly unknown[] | undefined;
  cleanup: (() => void) | undefined;
}

function effect(run: () => void | (() => void), deps: readonly unknown[] | undefined) {
  const cell = slot<EffectCell>(() => ({ has: false, deps: undefined, cleanup: undefined }));
  if (cell.has && sameDeps(deps, cell.deps)) return;
  cell.has = true;
  cell.deps = deps;
  queued.push(() => {
    cell.cleanup?.();
    const out = run();
    cell.cleanup = typeof out === 'function' ? out : undefined;
  });
}

interface StateCell {
  value: unknown;
  set: (update: unknown) => void;
}

export const reactHooks = {
  useState(initial: unknown) {
    const cell = slot<StateCell>(() => {
      const made: StateCell = {
        value: typeof initial === 'function' ? (initial as () => unknown)() : initial,
        set: () => {},
      };
      made.set = (update) => {
        const next =
          typeof update === 'function' ? (update as (v: unknown) => unknown)(made.value) : update;
        if (!Object.is(next, made.value)) {
          made.value = next;
          dirty = true;
        }
      };
      return made;
    });
    return [cell.value, cell.set];
  },
  useReducer(
    reducer: (state: unknown, action: unknown) => unknown,
    initial: unknown,
    init?: (arg: unknown) => unknown,
  ) {
    const cell = slot(() => {
      const made = {
        value: init ? init(initial) : initial,
        reducer,
        dispatch: (action: unknown) => {
          const next = made.reducer(made.value, action);
          if (!Object.is(next, made.value)) {
            made.value = next;
            dirty = true;
          }
        },
      };
      return made;
    });
    cell.reducer = reducer;
    return [cell.value, cell.dispatch];
  },
  useRef: (initial: unknown) => slot(() => ({ current: initial })),
  useMemo: (make: () => unknown, deps?: readonly unknown[]) => memo(make, deps),
  useCallback: (fn: unknown, deps?: readonly unknown[]) => memo(() => fn, deps),
  useEffect: effect,
  useLayoutEffect: effect,
  useInsertionEffect: effect,
  useId: () => slot(() => `:r${++sequence}:`),
  useContext: (context: Tagged) => context._currentValue,
  useTransition: () => [false, (run: () => void) => run()],
  useDeferredValue: (value: unknown) => value,
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  useImperativeHandle: () => {},
  useDebugValue: () => {},
};

const nameOfType = (type: unknown): string => {
  if (typeof type === 'string') return type;
  if (typeof type === 'function') return type.name || 'anonymous';
  if (isObject(type)) {
    const inner = type.type ?? type.render;
    return type.displayName ?? (typeof inner === 'function' ? inner.name : 'wrapped');
  }
  return String(type);
};

export interface Renderer {
  tree: () => Host;
  draw: () => Host;
  flush: () => Promise<Host>;
}

/** Draws what `root` returns on hooks that keep their state per position in the tree. */
export function createRenderer(root: () => unknown): Renderer {
  const instances = new Map<string, Instance>();
  let seen = new Set<string>();
  let tree: Host = { tag: '#root', props: {}, kids: [], parent: null };

  function run(path: string, render: () => unknown): unknown {
    let instance = instances.get(path);
    if (!instance) {
      instance = { slots: [], at: 0 };
      instances.set(path, instance);
    }
    seen.add(path);
    const outer = current;
    current = instance;
    instance.at = 0;
    try {
      return render();
    } finally {
      current = outer;
    }
  }

  function buildElement(el: ElementLike, path: string, parent: Host): void {
    let type = el.type;
    const { props } = el;
    while (isObject(type) && type.$$typeof === MEMO) type = type.type;
    if (typeof type === 'string') {
      const host: Host = { tag: type, props, kids: [], parent };
      parent.kids.push(host);
      buildChildren(props.children, path, host);
    } else if (PASS_THROUGH.has(type)) {
      buildChildren(props.children, path, parent);
    } else if (typeof type === 'function') {
      if ((type as { prototype?: { isReactComponent?: unknown } }).prototype?.isReactComponent) {
        throw new Error(`the test renderer does not draw the class component ${nameOfType(type)}`);
      }
      buildChildren(
        run(path, () => (type as (p: Props) => unknown)(props)),
        path,
        parent,
      );
    } else if (isObject(type) && type.$$typeof === FORWARD_REF && type.render) {
      const render = type.render;
      buildChildren(
        run(path, () => render(props, props.ref ?? null)),
        path,
        parent,
      );
    } else if (isObject(type) && type.$$typeof === CONTEXT) {
      const prior = type._currentValue;
      type._currentValue = props.value;
      try {
        buildChildren(props.children, path, parent);
      } finally {
        type._currentValue = prior;
      }
    } else {
      throw new Error(`the test renderer cannot draw ${nameOfType(type)}`);
    }
  }

  function place(child: unknown, path: string, index: number, parent: Host): void {
    if (child === null || child === undefined || typeof child === 'boolean') return;
    if (typeof child === 'string' || typeof child === 'number' || typeof child === 'bigint') {
      parent.kids.push(String(child));
    } else if (Array.isArray(child)) {
      buildChildren(child, `${path}[${index}]`, parent);
    } else if (isElement(child)) {
      const id = child.key === null ? `[${index}]` : `#${child.key}`;
      buildElement(child, `${path}${id}:${nameOfType(child.type)}`, parent);
    } else if (isObject(child) && (child as Tagged).$$typeof === PORTAL) {
      buildChildren((child as { children?: unknown }).children, `${path}[${index}]`, parent);
    }
  }

  function buildChildren(node: unknown, path: string, parent: Host): void {
    const list = Array.isArray(node) ? node : [node];
    list.forEach((child, index) => place(child, path, index, parent));
  }

  function draw(): Host {
    for (let pass = 0; pass < 25; pass += 1) {
      dirty = false;
      queued = [];
      seen = new Set();
      const fresh: Host = { tag: '#root', props: {}, kids: [], parent: null };
      buildChildren(root(), '', fresh);
      tree = fresh;
      for (const [path, instance] of instances) {
        if (seen.has(path)) continue;
        for (const cell of instance.slots) (cell as EffectCell | null)?.cleanup?.();
        instances.delete(path);
      }
      for (const flushEffect of queued) flushEffect();
      if (!dirty) return tree;
    }
    throw new Error('the component kept updating its own state');
  }

  draw();
  return {
    tree: () => tree,
    draw,
    flush: async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      return draw();
    },
  };
}

export function textOf(node: Host | string, skip?: Host): string {
  if (typeof node === 'string') return node;
  if (node === skip) return '';
  return node.kids.map((kid) => textOf(kid, skip)).join('');
}

export function findAll(node: Host, test: (host: Host) => boolean): Host[] {
  const found = test(node) ? [node] : [];
  for (const kid of node.kids) if (typeof kid !== 'string') found.push(...findAll(kid, test));
  return found;
}

export const contains = (outer: Host, inner: Host): boolean => {
  for (let at: Host | null = inner; at; at = at.parent) if (at === outer) return true;
  return false;
};

export const norm = (text: string): string =>
  text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[:*]+$/, '')
    .trim()
    .toLowerCase();

/** The name a person would read for a control or button: aria-label, a wrapping or `for` label, or the text inside. */
export function nameOf(host: Host, root: Host): string {
  const aria = host.props['aria-label'];
  if (typeof aria === 'string') return norm(aria);
  const by = host.props['aria-labelledby'];
  if (typeof by === 'string') {
    const text = findAll(root, (h) => h.props.id === by)
      .map((h) => textOf(h))
      .join(' ');
    if (text !== '') return norm(text);
  }
  if (host.tag === 'button') return norm(textOf(host));
  for (let at = host.parent; at; at = at.parent) {
    if (at.tag === 'label') return norm(textOf(at, host));
  }
  const id = host.props.id;
  if (typeof id === 'string') {
    const label = findAll(root, (h) => h.tag === 'label' && h.props.htmlFor === id)[0];
    if (label) return norm(textOf(label));
  }
  return '';
}

export const isControl = (host: Host): boolean =>
  host.tag === 'input' || host.tag === 'select' || host.tag === 'textarea';

export const matches = (name: string, spec: string | RegExp): boolean =>
  typeof spec === 'string' ? name === spec : spec.test(name);

/** Every control whose name matches, in document order. */
export function controls(root: Host, spec: string | RegExp, within: Host = root): Host[] {
  return findAll(within, (h) => isControl(h) && matches(nameOf(h, root), spec));
}

/** Every button whose name matches, in document order. */
export function buttons(root: Host, spec: string | RegExp, within: Host = root): Host[] {
  return findAll(within, (h) => h.tag === 'button' && matches(nameOf(h, root), spec));
}

export const isDisabled = (host: Host): boolean =>
  host.props.disabled === true ||
  host.props['aria-disabled'] === true ||
  host.props['aria-disabled'] === 'true';

export const valueOf = (host: Host): string => {
  const value = host.props.value ?? host.props.defaultValue;
  return value === undefined || value === null ? '' : String(value);
};

function event(host: Host, extra: Props): Props {
  const target = {
    id: host.props.id,
    name: host.props.name,
    type: host.props.type,
    value: valueOf(host),
    checked: host.props.checked,
    ...extra,
  };
  return { target, currentTarget: target, preventDefault: () => {}, stopPropagation: () => {} };
}

function handler(host: Host, name: 'onClick' | 'onChange'): (e: Props) => unknown {
  if (isDisabled(host)) throw new Error(`the ${host.tag} is disabled`);
  const fn = host.props[name];
  if (typeof fn !== 'function') throw new Error(`the ${host.tag} has no ${name}`);
  return fn as (e: Props) => unknown;
}

export const fire = {
  click: (host: Host) => handler(host, 'onClick')(event(host, {})),
  type: (host: Host, value: string) =>
    handler(host, 'onChange')(event(host, { value, valueAsNumber: Number(value) })),
  check: (host: Host, checked: boolean) => handler(host, 'onChange')(event(host, { checked })),
};
