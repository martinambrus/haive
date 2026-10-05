interface KeyboardLock {
  lock(): Promise<void>;
  unlock(): void;
}

/** noVNC already cancels and forwards canvas key events. Reserved browser shortcuts
 * need a fullscreen lock before the browser will deliver those events at all. */
export function createKeyboardFullscreen(
  element: HTMLElement,
  focus: () => void,
  update: (fullscreen: boolean, notice: string | null) => void,
) {
  const doc = element.ownerDocument;
  const keyboard = (
    doc.defaultView?.navigator as (Navigator & { keyboard?: KeyboardLock }) | undefined
  )?.keyboard;
  let disposed = false;
  let wantsFullscreen = false;
  let ownsLock = false;
  let revision = 0;

  const unlock = () => {
    revision += 1;
    if (ownsLock) {
      ownsLock = false;
      keyboard?.unlock();
    }
  };

  const onChange = () => {
    const fullscreen = doc.fullscreenElement === element;
    if (!fullscreen) {
      wantsFullscreen = false;
      unlock();
      if (!disposed) update(false, null);
      return;
    }
    if (disposed || !wantsFullscreen) {
      void doc.exitFullscreen().catch(() => {});
      return;
    }
    update(true, null);
    focus();
    // Firefox/Safari use the requestFullscreen option below; Chromium uses
    // navigator.keyboard. Keep input usable even when its permission is denied.
    if (keyboard?.lock) {
      ownsLock = true;
      const requestedRevision = ++revision;
      void keyboard.lock().catch(() => {
        if (!disposed && revision === requestedRevision && doc.fullscreenElement === element) {
          unlock();
          update(
            true,
            'Keyboard capture was denied. Allow it in your browser’s site permissions, then enter fullscreen again.',
          );
        }
      });
    }
  };
  doc.addEventListener('fullscreenchange', onChange);

  return {
    async enter() {
      if (disposed || wantsFullscreen || doc.fullscreenElement === element) return;
      if (!element.requestFullscreen) {
        update(
          false,
          'Fullscreen is unavailable in this browser. Reserved shortcuts may control the outer browser.',
        );
        return;
      }
      wantsFullscreen = true;
      try {
        // Unknown dictionary options are ignored by older browsers. TypeScript's
        // DOM declarations do not yet include Firefox 151's keyboardLock option.
        const options: FullscreenOptions & { keyboardLock: 'browser' } = {
          keyboardLock: 'browser',
        };
        await element.requestFullscreen(options);
        if ((disposed || !wantsFullscreen) && doc.fullscreenElement === element) {
          await doc.exitFullscreen();
        }
      } catch {
        wantsFullscreen = false;
        if (!disposed)
          update(false, 'Could not enter fullscreen. Try the Fullscreen button again.');
      }
    },
    async exit() {
      wantsFullscreen = false;
      unlock();
      if (doc.fullscreenElement === element) await doc.exitFullscreen().catch(() => {});
    },
    dispose() {
      disposed = true;
      wantsFullscreen = false;
      doc.removeEventListener('fullscreenchange', onChange);
      unlock();
      if (doc.fullscreenElement === element) void doc.exitFullscreen().catch(() => {});
    },
  };
}
