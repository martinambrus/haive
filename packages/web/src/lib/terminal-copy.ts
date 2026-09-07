import type { IClipboardProvider } from '@xterm/addon-clipboard';

/**
 * Copy a terminal selection to the clipboard from inside a key handler.
 *
 * `navigator.clipboard.writeText` is unusable on this path: Firefox gates it on
 * transient user activation, and a keydown with Ctrl held is not an activating
 * event, so the promise rejects with `NotAllowedError: Clipboard write is not
 * allowed` — the rejection surfaces as a page-level error and nothing reaches
 * the clipboard. Letting the browser's own copy run instead is not a fallback
 * either: xterm's helper textarea is `readonly` in a read-only viewer
 * (`disableStdin`) and the xterm selection is not a DOM selection, so Firefox
 * fires no `copy` event at all and xterm's built-in copy handler never runs.
 * `document.execCommand('copy')` is gated on "is handling user input" rather
 * than on transient activation, so it still works inside the same handler; the
 * async API stays as the fallback for a browser that drops execCommand.
 */
export function copyTerminalSelection(text: string): void {
  if (execCommandCopy(text)) return;
  void navigator.clipboard?.writeText(text).catch(() => {});
}

/** Per-terminal OSC 52 bridge, handed to `ClipboardAddon` as its provider. */
export interface Osc52Clipboard {
  provider: IClipboardProvider;
  /** Subscribe to pending-copy changes; returns the unsubscribe. */
  subscribe: (cb: () => void) => () => void;
  /** The text a refused write is holding, or null. Stable snapshot. */
  getPending: () => string | null;
  /** Write the pending text. Call ONLY from inside a user gesture. */
  flush: () => boolean;
}

/**
 * OSC 52 is a copy the CLI asked for, so it arrives in a WebSocket message with
 * no user activation behind it — and Firefox requires transient activation to
 * write, with no `clipboard-write` permission to grant instead (MDN Clipboard
 * API, Security considerations). `execCommandCopy` is no escape hatch either:
 * it is gated on "is handling user input", which a socket callback is not. The
 * write genuinely cannot happen at the moment it is requested, so the text is
 * PARKED and the caller renders a button for it — clicking that button is the
 * gesture, and `flush` then takes the synchronous route. Deliberately not
 * flushed on the next click anywhere in the terminal: that would replace a
 * clipboard the user filled for something else, on a click they never meant as
 * a copy.
 *
 * One store per terminal, never a module singleton — a task page mounts many
 * CliStreamViewers at once and one terminal's refused copy must not raise a
 * button on all of them.
 *
 * The other half of this bug lives in the sandbox, not here: tmux 3.3a defaults
 * `set-clipboard` to `external`, which drops an application's OSC 52 outright
 * (MEASURED — forwarded only under `on`), so the bytes never reached any
 * browser. See `worker/src/terminal/terminal-container.ts`.
 */
export function createOsc52Clipboard(): Osc52Clipboard {
  let pending: string | null = null;
  const listeners = new Set<() => void>();

  const setPending = (next: string | null): void => {
    if (pending === next) return;
    pending = next;
    for (const cb of listeners) cb();
  };

  return {
    provider: {
      // `selection` is a const enum that cannot be imported as a value under
      // isolatedModules; compare its string value instead ('c' is SYSTEM).
      async readText(selection) {
        if (String(selection) !== 'c') return '';
        try {
          return await navigator.clipboard.readText();
        } catch {
          return '';
        }
      },
      async writeText(selection, text) {
        if (String(selection) !== 'c') return;
        try {
          await navigator.clipboard.writeText(text);
          setPending(null);
        } catch {
          setPending(text);
        }
      },
    },
    subscribe: (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    getPending: () => pending,
    flush: () => {
      if (pending === null) return false;
      if (!execCommandCopy(pending)) return false;
      setPending(null);
      return true;
    },
  };
}

/** Synchronous copy through a throwaway off-screen textarea. Focus is handed
 *  back to whatever held it (the terminal) so the selection survives the copy. */
function execCommandCopy(text: string): boolean {
  const restore = document.activeElement as HTMLElement | null;
  const scratch = document.createElement('textarea');
  scratch.value = text;
  scratch.setAttribute('readonly', '');
  scratch.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
  document.body.appendChild(scratch);
  try {
    scratch.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    scratch.remove();
    restore?.focus();
  }
}
