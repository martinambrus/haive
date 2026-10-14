export interface LeaveClick {
  button: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
  href: string;
  target: string;
  download: boolean;
}

/** The in-app path a click on another page would load, or null when the click stays on this path
 *  (the editor stays mounted, so nothing is lost) or the browser should handle it. */
export function leaveDestination(click: LeaveClick, currentHref: string): string | null {
  if (click.defaultPrevented || click.button !== 0) return null;
  if (click.ctrlKey || click.metaKey || click.shiftKey || click.altKey) return null;
  if (click.download || (click.target !== '' && click.target !== '_self')) return null;
  const here = new URL(currentHref);
  const there = new URL(click.href, here);
  if (there.origin !== here.origin) return null;
  if (there.pathname === here.pathname) return null;
  return `${there.pathname}${there.search}${there.hash}`;
}

export interface Leaving {
  path: string;
  link: { isConnected: boolean; click(): void };
}

/** Leaves the way the intercepted click would have, once the guard is released: the link's own
 *  handlers run (an origin it records, the router's). A link gone from the page leaves by path. */
export function leaveThrough(
  leaving: Leaving,
  release: () => void,
  push: (path: string) => void,
): void {
  release();
  if (leaving.link.isConnected) leaving.link.click();
  else push(leaving.path);
}

export function guardLeaving(win: Window, onLeave: (leaving: Leaving) => void): () => void {
  const confirmUnload = (event: BeforeUnloadEvent) => {
    event.preventDefault();
    event.returnValue = '';
  };
  const interceptClick = (event: MouseEvent) => {
    const link = (event.target as Element | null)?.closest?.<HTMLAnchorElement>('a[href]');
    if (!link) return;
    const path = leaveDestination(
      {
        button: event.button,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        defaultPrevented: event.defaultPrevented,
        href: link.href,
        target: link.target,
        download: link.hasAttribute('download'),
      },
      win.location.href,
    );
    if (path === null) return;
    event.preventDefault();
    event.stopPropagation();
    onLeave({ path, link });
  };
  win.addEventListener('beforeunload', confirmUnload);
  // Capture phase, so the router's own link handler never sees the click.
  win.document.addEventListener('click', interceptClick, { capture: true });
  return () => {
    win.removeEventListener('beforeunload', confirmUnload);
    win.document.removeEventListener('click', interceptClick, { capture: true });
  };
}
