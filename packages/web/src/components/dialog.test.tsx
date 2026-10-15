import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, StrictMode, type ReactNode } from 'react';
import type { Root } from 'react-dom/client';

// This package has no DOM library, so this is the smallest DOM that react-dom/client and focus need.
type Listener = (event: FakeEvent) => void;
type ListenerOptions = boolean | { capture?: boolean };

class FakeEvent {
  defaultPrevented = false;
  stopped = false;
  immediate = false;
  target: unknown = null;
  currentTarget: unknown = null;
  key = '';
  shiftKey = false;
  constructor(
    readonly type: string,
    init: { key?: string; shiftKey?: boolean } = {},
  ) {
    Object.assign(this, init);
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
  stopPropagation() {
    this.stopped = true;
  }
  stopImmediatePropagation() {
    this.stopped = this.immediate = true;
  }
}

class FakeTarget {
  private listeners: { type: string; listener: Listener; capture: boolean }[] = [];
  addEventListener(type: string, listener: Listener, options?: ListenerOptions) {
    const capture = typeof options === 'boolean' ? options : !!options?.capture;
    this.removeEventListener(type, listener, options);
    this.listeners.push({ type, listener, capture });
  }
  removeEventListener(type: string, listener: Listener, options?: ListenerOptions) {
    const capture = typeof options === 'boolean' ? options : !!options?.capture;
    this.listeners = this.listeners.filter(
      (l) => !(l.type === type && l.listener === listener && l.capture === capture),
    );
  }
  protected parentTarget(): FakeTarget | null {
    return null;
  }
  dispatchEvent(event: FakeEvent) {
    event.target = this;
    for (let at: FakeTarget | null = this; at && !event.stopped; at = at.parentTarget()) {
      event.currentTarget = at;
      for (const l of [...at.listeners]) {
        if (l.type === event.type && !l.capture) l.listener(event);
        if (event.immediate) break;
      }
    }
    return !event.defaultPrevented;
  }
}

type Compound = { tag: string; attrs: string[]; disabled: boolean };

function parseSelector(selector: string): Compound[] {
  return selector.split(',').map((part) => {
    const text = part.trim();
    const compound: Compound = { tag: '*', attrs: [], disabled: false };
    let at = 0;
    const tag = /^[a-z*][\w-]*/i.exec(text);
    if (tag) {
      compound.tag = tag[0].toLowerCase();
      at = tag[0].length;
    }
    const token = /\[([\w-]+)\]|:(disabled)/y;
    while (at < text.length) {
      token.lastIndex = at;
      const m = token.exec(text);
      if (!m) throw new Error(`the test DOM does not support the selector "${selector}"`);
      if (m[2]) compound.disabled = true;
      else compound.attrs.push(m[1]!);
      at = token.lastIndex;
    }
    return compound;
  });
}

class FakeNode extends FakeTarget {
  parentNode: FakeNode | null = null;
  childNodes: FakeNode[] = [];
  nodeValue: string | null = null;
  constructor(
    readonly nodeType: number,
    readonly nodeName: string,
    public ownerDocument: FakeDocument | null,
  ) {
    super();
  }
  protected override parentTarget(): FakeTarget | null {
    return this.parentNode;
  }
  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }
  get lastChild(): FakeNode | null {
    return this.childNodes.at(-1) ?? null;
  }
  get isConnected() {
    let at: FakeNode = this;
    while (at.parentNode) at = at.parentNode;
    return at.nodeType === 9;
  }
  contains(other: FakeNode | null) {
    for (let at = other; at; at = at.parentNode) if (at === this) return true;
    return false;
  }
  insertBefore(child: FakeNode, before: FakeNode | null) {
    child.parentNode?.removeChild(child);
    const at = before ? this.childNodes.indexOf(before) : this.childNodes.length;
    this.childNodes.splice(at, 0, child);
    child.parentNode = this;
    return child;
  }
  appendChild(child: FakeNode) {
    return this.insertBefore(child, null);
  }
  removeChild(child: FakeNode) {
    const at = this.childNodes.indexOf(child);
    if (at < 0) throw new Error('the node to remove is not a child of this node');
    this.childNodes.splice(at, 1);
    child.parentNode = null;
    return child;
  }
  set textContent(text: string) {
    for (const child of [...this.childNodes]) this.removeChild(child);
    if (text) this.appendChild(this.ownerDocument!.createTextNode(text));
  }
}

const NATIVE = ['button', 'input', 'select', 'textarea'];
const tabindexOf = (el: FakeElement) => Number.parseInt(el.getAttribute('tabindex') ?? '', 10);

class FakeElement extends FakeNode {
  attrs = new Map<string, string>();
  style = {};
  constructor(
    readonly localName: string,
    doc: FakeDocument,
  ) {
    super(1, localName.toUpperCase(), doc);
  }
  get tagName() {
    return this.nodeName;
  }
  setAttribute(name: string, value: unknown) {
    this.attrs.set(name.toLowerCase(), String(value));
  }
  getAttribute(name: string) {
    return this.attrs.get(name.toLowerCase()) ?? null;
  }
  hasAttribute(name: string) {
    return this.attrs.has(name.toLowerCase());
  }
  removeAttribute(name: string) {
    this.attrs.delete(name.toLowerCase());
  }
  get id() {
    return this.getAttribute('id') ?? '';
  }
  get disabled() {
    return this.hasAttribute('disabled');
  }
  get parentElement(): FakeElement | null {
    return this.parentNode instanceof FakeElement ? this.parentNode : null;
  }
  get children() {
    return this.childNodes.filter((c): c is FakeElement => c instanceof FakeElement);
  }
  private get native() {
    return (
      NATIVE.includes(this.localName) ||
      (this.localName === 'a' && this.hasAttribute('href')) ||
      this.getAttribute('contenteditable') === 'true'
    );
  }
  get tabIndex() {
    const given = tabindexOf(this);
    return Number.isNaN(given) ? (this.native ? 0 : -1) : given;
  }
  getClientRects() {
    for (let at: FakeNode | null = this; at; at = at.parentNode) {
      if (at instanceof FakeElement && at.hasAttribute('hidden')) return [];
    }
    return this.isConnected ? [{}] : [];
  }
  get focusable() {
    const listed = this.native || !Number.isNaN(tabindexOf(this));
    return listed && !this.disabled && this.getClientRects().length > 0;
  }
  compareDocumentPosition(other: FakeElement) {
    if (other === this) return 0;
    if (this.contains(other)) return 20;
    if (other.contains(this)) return 10;
    const all = [doc.documentElement, ...doc.documentElement.descendants()];
    return all.indexOf(other) > all.indexOf(this) ? 4 : 2;
  }
  focus() {
    if (!this.focusable) return;
    this.ownerDocument!.focused = this;
    focusLog.push(nameOf(this));
  }
  matches(selector: string) {
    return parseSelector(selector).some(
      (c) =>
        (c.tag === '*' || c.tag === this.localName) &&
        (!c.disabled || this.disabled) &&
        c.attrs.every((name) => this.hasAttribute(name)),
    );
  }
  descendants(): FakeElement[] {
    return this.children.flatMap((c) => [c, ...c.descendants()]);
  }
  querySelectorAll(selector: string) {
    return this.descendants().filter((el) => el.matches(selector));
  }
}

class FakeDocument extends FakeNode {
  focused: FakeElement | null = null;
  documentElement: FakeElement;
  body: FakeElement;
  constructor(readonly defaultView: FakeWindow) {
    super(9, '#document', null);
    this.documentElement = this.createElement('html');
    this.body = this.createElement('body');
    this.appendChild(this.documentElement);
    this.documentElement.appendChild(this.body);
  }
  protected override parentTarget(): FakeTarget | null {
    return this.defaultView;
  }
  get activeElement() {
    return this.focused?.isConnected ? this.focused : this.body;
  }
  createElement(tag: string) {
    return new FakeElement(tag, this);
  }
  createTextNode(text: string) {
    const node = new FakeNode(3, '#text', this);
    node.nodeValue = text;
    return node;
  }
}

class FakeWindow extends FakeTarget {
  document: FakeDocument = new FakeDocument(this);
  HTMLIFrameElement = class {};
}

const win = new FakeWindow();
const doc = win.document;
const focusLog: string[] = [];

const byId = (id: string) => {
  const found = doc.documentElement.descendants().find((el) => el.id === id);
  if (!found) throw new Error(`no element #${id}`);
  return found;
};
const panels = () => doc.documentElement.querySelectorAll('[data-haive-dialog]');

function nameOf(el: FakeElement) {
  const at = panels().findIndex((overlay) => overlay === el.parentElement);
  if (at >= 0) return `panel ${at + 1}`;
  return el === doc.body ? 'body' : `${el.localName}#${el.id}`;
}
const where = () => nameOf(doc.activeElement);
const panel = (n = 1) => panels()[n - 1]!.children.at(-1)!;

function press(key: string, init: { shiftKey?: boolean } = {}) {
  const event = new FakeEvent('keydown', { key, ...init });
  act(() => {
    doc.activeElement.dispatchEvent(event);
  });
  if (key === 'Tab' && !event.defaultPrevented) {
    const all = [doc.documentElement, ...doc.documentElement.descendants()];
    const from = all.indexOf(doc.activeElement);
    const order = doc.documentElement
      .descendants()
      .filter((el) => el.focusable && el.tabIndex >= 0);
    const after = order.filter((el) => all.indexOf(el) > from);
    const before = order.filter((el) => all.indexOf(el) < from);
    (init.shiftKey ? (before.at(-1) ?? order.at(-1)) : (after[0] ?? order[0]))?.focus();
  }
  return event;
}

let root: Root;
let container: FakeElement;
let Dialog: typeof import('./dialog').Dialog;
let strict = false;

beforeAll(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('Node', { DOCUMENT_POSITION_PRECEDING: 2, DOCUMENT_POSITION_FOLLOWING: 4 });
  const { createRoot } = await import('react-dom/client');
  ({ Dialog } = await import('./dialog'));
  container = doc.createElement('div');
  doc.body.appendChild(container);
  root = createRoot(container as unknown as Element);
});
afterAll(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});
afterEach(() => {
  strict = false;
  act(() => root.render(null));
  doc.focused = null;
  focusLog.length = 0;
});

const show = (tree: ReactNode) => {
  act(() => root.render(strict ? <StrictMode>{tree}</StrictMode> : tree));
};

interface SceneProps {
  open?: boolean;
  mounted?: boolean;
  opener?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: ReactNode;
}

function Scene({
  open = false,
  mounted = true,
  opener = true,
  onOpenChange,
  children,
}: SceneProps) {
  return (
    <>
      <button id="before">before</button>
      {opener && <button id="opener">opener</button>}
      <button id="after">after</button>
      {mounted && (
        <Dialog open={open} onOpenChange={onOpenChange ?? (() => {})}>
          {children}
        </Dialog>
      )}
    </>
  );
}

function openDialog(children: ReactNode, props: SceneProps = {}) {
  show(<Scene {...props}>{children}</Scene>);
  byId('opener').focus();
  show(
    <Scene {...props} open>
      {children}
    </Scene>,
  );
}

const buttons = (
  <>
    <button id="ok">ok</button>
    <button id="cancel">cancel</button>
  </>
);

const withField = (
  <>
    <input id="name" autoFocus />
    <button id="cancel">cancel</button>
  </>
);

const mixed = (
  <>
    <button id="x1" disabled>
      disabled
    </button>
    <button id="x2" tabIndex={-1}>
      skipped
    </button>
    <a id="x3">no href</a>
    <a id="link" href="#x">
      link
    </a>
    <input id="field" />
    <select id="choice" />
    <textarea id="notes" />
    <div id="custom" tabIndex={0}>
      custom
    </div>
    <button id="x4" disabled>
      disabled
    </button>
    <button id="x5" tabIndex={-1}>
      skipped
    </button>
    <a id="x6">no href</a>
    <div id="x7" tabIndex={-1}>
      inert
    </div>
  </>
);

const editorInTheMiddle = (
  <>
    <button id="top">top</button>
    <div id="editor" contentEditable suppressContentEditableWarning />
    <button id="save">save</button>
  </>
);

const editorLast = (
  <>
    <button id="top">top</button>
    <button id="save">save</button>
    <div id="editor" contentEditable suppressContentEditableWarning />
  </>
);

const editorFirst = (
  <>
    <div id="editor" contentEditable suppressContentEditableWarning />
    <button id="top">top</button>
    <button id="save">save</button>
  </>
);

const swallowsTab = (
  <>
    <button id="top">top</button>
    <input
      id="swallow"
      onKeyDown={(e) => {
        if (e.key === 'Tab') e.preventDefault();
      }}
    />
  </>
);

const hiddenAtTheEnds = (
  <>
    <button id="h1" hidden>
      hidden
    </button>
    <button id="p">p</button>
    <button id="q">q</button>
    <button id="h2" hidden>
      hidden
    </button>
  </>
);

function Stack({ top }: { top: boolean }) {
  return (
    <Scene open>
      <button id="a1">a1</button>
      <button id="a2">a2</button>
      <Dialog open={top} onOpenChange={() => {}}>
        <button id="b1">b1</button>
        <button id="b2">b2</button>
      </Dialog>
    </Scene>
  );
}

function Pair({ below, above }: { below: boolean; above: boolean }) {
  return (
    <>
      <button id="before">before</button>
      <Dialog open={below} onOpenChange={() => {}}>
        <button id="a1">a1</button>
        <button id="a2">a2</button>
      </Dialog>
      <Dialog open={above} onOpenChange={() => {}}>
        <button id="b1">b1</button>
        <button id="b2">b2</button>
      </Dialog>
    </>
  );
}

function openSecond() {
  show(<Stack top={false} />);
  byId('a2').focus();
  focusLog.length = 0;
  show(<Stack top />);
}

describe('Dialog focus', () => {
  it('C1 opening focuses the panel, not the first control', () => {
    openDialog(buttons);
    expect(where()).toBe('panel 1');
  });

  it('C2 a child with autoFocus keeps the focus it took', () => {
    openDialog(withField);
    expect(where()).toBe('input#name');
  });

  it('C3 Tab from the last tabbable element goes to the first', () => {
    openDialog(mixed);
    byId('custom').focus();
    press('Tab');
    expect(where()).toBe('a#link');
    press('Tab');
    expect(where()).toBe('input#field');
  });

  it('C3 Shift+Tab from the first tabbable element goes to the last', () => {
    openDialog(mixed);
    byId('link').focus();
    press('Tab', { shiftKey: true });
    expect(where()).toBe('div#custom');
    press('Tab', { shiftKey: true });
    expect(where()).toBe('textarea#notes');
  });

  it('C3 from the panel itself Tab goes to the first and Shift+Tab to the last', () => {
    openDialog(mixed);
    expect(where()).toBe('panel 1');
    press('Tab');
    expect(where()).toBe('a#link');
    panel().focus();
    press('Tab', { shiftKey: true });
    expect(where()).toBe('div#custom');
  });

  it('C3 with nothing tabbable inside, Tab keeps focus on the panel', () => {
    openDialog(<p>nothing to press</p>);
    press('Tab');
    expect(where()).toBe('panel 1');
    press('Tab', { shiftKey: true });
    expect(where()).toBe('panel 1');
  });

  it('C3 an element the dialog does not list is left alone in the middle', () => {
    openDialog(editorInTheMiddle);
    byId('editor').focus();
    press('Tab');
    expect(where()).toBe('button#save');
    byId('editor').focus();
    press('Tab', { shiftKey: true });
    expect(where()).toBe('button#top');
  });

  it('C3 an element the dialog does not list still wraps at either end', () => {
    openDialog(editorLast);
    byId('editor').focus();
    press('Tab');
    expect(where()).toBe('button#top');
    openDialog(editorFirst);
    byId('editor').focus();
    press('Tab', { shiftKey: true });
    expect(where()).toBe('button#save');
  });

  it('C3 hidden elements are not taken for the first or the last', () => {
    openDialog(hiddenAtTheEnds);
    byId('q').focus();
    press('Tab');
    expect(where()).toBe('button#p');
    press('Tab', { shiftKey: true });
    expect(where()).toBe('button#q');
  });

  it('C3 a Tab that something inside already handled is left alone', () => {
    openDialog(swallowsTab);
    byId('swallow').focus();
    press('Tab');
    expect(where()).toBe('input#swallow');
  });

  it('C4 opening a second dialog moves focus into it and nowhere else', () => {
    openSecond();
    expect(where()).toBe('panel 2');
    expect(focusLog).toEqual(['panel 2']);
  });

  it('C4 Tab in the top dialog wraps inside it and moves on in the middle', () => {
    openSecond();
    byId('b1').focus();
    focusLog.length = 0;
    press('Tab');
    expect(where()).toBe('button#b2');
    press('Tab');
    expect(where()).toBe('button#b1');
    press('Tab', { shiftKey: true });
    expect(where()).toBe('button#b2');
    expect(focusLog.filter((name) => /#a\d/.test(name) || name === 'panel 1')).toEqual([]);
  });

  it('C4 the dialog below traps Tab again once the top one closes', () => {
    openSecond();
    show(<Stack top={false} />);
    expect(where()).toBe('button#a2');
    press('Tab');
    expect(where()).toBe('button#a1');
    press('Tab', { shiftKey: true });
    expect(where()).toBe('button#a2');
  });

  it('C4 closing the dialog below leaves the top one trapping Tab', () => {
    show(<Pair below above={false} />);
    show(<Pair below above />);
    show(<Pair below={false} above />);
    byId('b2').focus();
    press('Tab');
    expect(where()).toBe('button#b1');
    press('Tab', { shiftKey: true });
    expect(where()).toBe('button#b2');
  });

  it('C5 closing restores focus to the opener', () => {
    openDialog(buttons);
    byId('cancel').focus();
    show(<Scene>{buttons}</Scene>);
    expect(where()).toBe('button#opener');
  });

  it('C5 unmounting an open dialog restores focus to the opener', () => {
    openDialog(buttons);
    byId('cancel').focus();
    show(<Scene mounted={false} />);
    expect(where()).toBe('button#opener');
  });

  it('C5 closing restores the opener even when an autoFocus child took focus on open', () => {
    openDialog(withField);
    show(<Scene>{withField}</Scene>);
    expect(where()).toBe('button#opener');
  });

  it('C5 a dialog that mounts already open takes focus and gives it back when it unmounts', () => {
    show(<Scene mounted={false} />);
    byId('opener').focus();
    show(<Scene open>{buttons}</Scene>);
    expect(where()).toBe('panel 1');
    show(<Scene mounted={false} />);
    expect(where()).toBe('button#opener');
  });

  it('C5 reopening remembers the new opener', () => {
    openDialog(buttons);
    byId('cancel').focus();
    show(<Scene>{buttons}</Scene>);
    byId('after').focus();
    show(<Scene open>{buttons}</Scene>);
    byId('cancel').focus();
    show(<Scene>{buttons}</Scene>);
    expect(where()).toBe('button#after');
  });

  it('C6 closing after the opener was removed throws nothing and focuses nothing in particular', () => {
    openDialog(buttons);
    show(
      <Scene open opener={false}>
        {buttons}
      </Scene>,
    );
    expect(() => show(<Scene opener={false}>{buttons}</Scene>)).not.toThrow();
    expect(where()).toBe('body');
  });

  it('C7 Escape closes and does not reach a window keydown listener', () => {
    const onOpenChange = vi.fn();
    const onWindow = vi.fn();
    win.addEventListener('keydown', onWindow);
    try {
      openDialog(buttons, { onOpenChange });
      press('Escape');
      expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
      expect(onWindow).not.toHaveBeenCalled();
    } finally {
      win.removeEventListener('keydown', onWindow);
    }
  });

  it('C10 Escape closes only the top dialog of a stack', () => {
    const below = vi.fn();
    const above = vi.fn();
    const stack = (top: boolean) => (
      <>
        <Dialog open onOpenChange={below}>
          <button id="a1">a1</button>
        </Dialog>
        <Dialog open={top} onOpenChange={above}>
          <button id="b1">b1</button>
        </Dialog>
      </>
    );
    show(stack(false));
    show(stack(true));
    press('Escape');
    expect(above).toHaveBeenCalledExactlyOnceWith(false);
    expect(below).not.toHaveBeenCalled();
  });

  it('C8 re-rendering an open dialog does not move focus', () => {
    openDialog(buttons);
    byId('cancel').focus();
    show(
      <Scene open onOpenChange={() => {}}>
        {buttons}
      </Scene>,
    );
    expect(where()).toBe('button#cancel');
  });

  it('C9 under Strict Mode an autoFocus child keeps focus and closing restores the opener', () => {
    strict = true;
    show(<Scene mounted={false} />);
    byId('opener').focus();
    show(<Scene open>{withField}</Scene>);
    expect(where()).toBe('input#name');
    show(<Scene>{withField}</Scene>);
    expect(where()).toBe('button#opener');
  });
});
