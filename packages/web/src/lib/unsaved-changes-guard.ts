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

/** The in-app path the click would load, or null when the browser should handle the click itself. */
export function leaveDestination(click: LeaveClick, currentHref: string): string | null {
  if (click.defaultPrevented || click.button !== 0) return null;
  if (click.ctrlKey || click.metaKey || click.shiftKey || click.altKey) return null;
  if (click.download || (click.target !== '' && click.target !== '_self')) return null;
  const here = new URL(currentHref);
  const there = new URL(click.href, here);
  if (there.origin !== here.origin) return null;
  if (there.pathname === here.pathname && there.search === here.search) return null;
  return `${there.pathname}${there.search}${there.hash}`;
}

export function guardLeaving(win: Window, onLeave: (path: string) => void): () => void {
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
    onLeave(path);
  };
  win.addEventListener('beforeunload', confirmUnload);
  // Capture phase, so the router's own link handler never sees the click.
  win.document.addEventListener('click', interceptClick, { capture: true });
  return () => {
    win.removeEventListener('beforeunload', confirmUnload);
    win.document.removeEventListener('click', interceptClick, { capture: true });
  };
}
