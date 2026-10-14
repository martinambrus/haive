import { describe, expect, it, vi } from 'vitest';
import { guardLeaving, leaveDestination, type LeaveClick } from './unsaved-changes-guard';

const HERE = 'http://localhost:3000/admin/task-types/spec-check';

function click(over: Partial<LeaveClick> = {}): LeaveClick {
  return {
    button: 0,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    href: 'http://localhost:3000/admin/users',
    target: '',
    download: false,
    ...over,
  };
}

describe('leaveDestination', () => {
  it('sends a plain click on a same-origin link to its in-app path', () => {
    expect(leaveDestination(click(), HERE)).toBe('/admin/users');
    expect(
      leaveDestination(click({ href: 'http://localhost:3000/tasks?status=open#top' }), HERE),
    ).toBe('/tasks?status=open#top');
    expect(leaveDestination(click({ target: '_self' }), HERE)).toBe('/admin/users');
    expect(leaveDestination(click({ href: '/admin/users' }), HERE)).toBe('/admin/users');
  });

  it('leaves a click that opens elsewhere or does not navigate to the browser', () => {
    const untouched: Partial<LeaveClick>[] = [
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
      { altKey: true },
      { button: 1 },
      { target: '_blank' },
      { target: 'preview' },
      { download: true },
      { defaultPrevented: true },
    ];
    for (const over of untouched) {
      expect(leaveDestination(click(over), HERE), JSON.stringify(over)).toBeNull();
    }
  });

  it('ignores a link to another origin or a scheme that is not a page of this app', () => {
    expect(leaveDestination(click({ href: 'https://example.com/admin/users' }), HERE)).toBeNull();
    expect(leaveDestination(click({ href: 'http://localhost:3001/admin/users' }), HERE)).toBeNull();
    expect(leaveDestination(click({ href: 'mailto:ops@example.com' }), HERE)).toBeNull();
    expect(leaveDestination(click({ href: 'javascript:void(0)' }), HERE)).toBeNull();
  });

  it('does not count a hash on the same page as leaving it', () => {
    expect(leaveDestination(click({ href: `${HERE}#steps` }), HERE)).toBeNull();
    expect(leaveDestination(click({ href: '#steps' }), HERE)).toBeNull();
    expect(leaveDestination(click({ href: HERE }), HERE)).toBeNull();
    expect(leaveDestination(click({ href: `${HERE}?tab=2` }), HERE)).toBe(
      '/admin/task-types/spec-check?tab=2',
    );
  });
});

function fakeWindow(href = HERE) {
  const doc = new EventTarget();
  const addListener = vi.spyOn(doc, 'addEventListener');
  const win = Object.assign(new EventTarget(), { document: doc, location: { href } });
  return { win: win as unknown as Window, doc, addListener };
}

function anchor(href: string, over: { target?: string; download?: boolean } = {}) {
  const link = {
    href,
    target: over.target ?? '',
    hasAttribute: (name: string) => name === 'download' && over.download === true,
    closest: (_selector: string) => link,
  };
  return link;
}

function clickEvent(target: unknown, over: Record<string, unknown> = {}) {
  const event = Object.assign(new Event('click', { cancelable: true }), {
    button: 0,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...over,
  });
  Object.defineProperty(event, 'target', { value: target });
  return event;
}

describe('guardLeaving', () => {
  it('stops a click on an in-app link and reports where it was going', () => {
    const { win, doc } = fakeWindow();
    const onLeave = vi.fn();
    guardLeaving(win, onLeave);
    const inner = { closest: () => anchor('http://localhost:3000/admin/users') };
    const event = clickEvent(inner);
    const stop = vi.spyOn(event, 'stopPropagation');
    doc.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(stop).toHaveBeenCalled();
    expect(onLeave).toHaveBeenCalledExactlyOnceWith('/admin/users');
  });

  it('leaves alone a click that is not on a link, opens a tab, or stays on the page', () => {
    const { win, doc } = fakeWindow();
    const onLeave = vi.fn();
    guardLeaving(win, onLeave);
    const untouched = [
      clickEvent({ closest: () => null }),
      clickEvent(anchor('http://localhost:3000/admin/users'), { ctrlKey: true }),
      clickEvent(anchor('http://localhost:3000/admin/users', { target: '_blank' })),
      clickEvent(anchor(`${HERE}#steps`)),
      clickEvent(anchor('https://example.com/')),
      clickEvent(doc),
    ];
    for (const event of untouched) {
      doc.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(onLeave).not.toHaveBeenCalled();
  });

  it('listens in the capture phase, ahead of the router link handler', () => {
    const { win, addListener } = fakeWindow();
    guardLeaving(win, vi.fn());
    expect(addListener).toHaveBeenCalledWith('click', expect.any(Function), { capture: true });
  });

  it('asks the browser to confirm a reload or a tab close', () => {
    const { win } = fakeWindow();
    guardLeaving(win, vi.fn());
    const event = new Event('beforeunload', { cancelable: true });
    win.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('stands down once released, which is what a form that is clean again does', () => {
    const { win, doc } = fakeWindow();
    const onLeave = vi.fn();
    const release = guardLeaving(win, onLeave);
    release();
    const event = clickEvent(anchor('http://localhost:3000/admin/users'));
    doc.dispatchEvent(event);
    const unload = new Event('beforeunload', { cancelable: true });
    win.dispatchEvent(unload);
    expect(event.defaultPrevented).toBe(false);
    expect(unload.defaultPrevented).toBe(false);
    expect(onLeave).not.toHaveBeenCalled();
  });

  it('reads the current address when the click lands, not when the guard was armed', () => {
    const { win, doc } = fakeWindow();
    const onLeave = vi.fn();
    guardLeaving(win, onLeave);
    (win.location as { href: string }).href = 'http://localhost:3000/admin/users';
    doc.dispatchEvent(clickEvent(anchor('http://localhost:3000/admin/users#x')));
    expect(onLeave).not.toHaveBeenCalled();
  });
});
