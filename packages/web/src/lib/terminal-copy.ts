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
/**
 * Cap on a clipboard call made from inside the OSC 52 handler.
 *
 * xterm SUSPENDS its write queue while a parser handler's promise is pending, so an
 * unsettled clipboard call does not merely lose a copy — it freezes the terminal, and
 * nothing after it renders. MEASURED on Chrome: `readText()` from an automated page sat
 * unsettled past 120s on the permission prompt, and a `writeText()` that never settled
 * left a live shell's tmux status bar three minutes stale while output queued behind it.
 * A real write on the same page resolves in 1ms, so this bound costs nothing and only
 * ever fires when the call was never going to answer. A timed-out write is treated as
 * refused, which is already the honest outcome: the text is parked for the button.
 */
const CLIPBOARD_CALL_TIMEOUT_MS = 2000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('clipboard call timed out')), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

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
      async readText(selection) {
        if (!isSystemSelection(selection)) return '';
        try {
          return await withTimeout(navigator.clipboard.readText(), CLIPBOARD_CALL_TIMEOUT_MS);
        } catch {
          return '';
        }
      },
      async writeText(selection, text) {
        if (!isSystemSelection(selection)) return;
        try {
          await withTimeout(navigator.clipboard.writeText(text), CLIPBOARD_CALL_TIMEOUT_MS);
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

/**
 * Does this OSC 52 target the system clipboard?
 *
 * `selection` is a const enum that cannot be imported as a value under
 * isolatedModules, so compare its string value: 'c' is SYSTEM.
 *
 * EMPTY counts too, and that is the case that matters here rather than an edge
 * one: tmux REWRITES the selection field when it forwards an application's copy
 * — MEASURED, `ESC ]52;c;<b64>BEL` emitted inside a pane reaches the outer
 * terminal as `ESC ]52;;<b64>BEL`, and the addon hands that on as ''. Matching
 * 'c' alone therefore dropped every copy made inside tmux, which is every copy
 * this product's terminals carry. The spec defaults an omitted target to `s0`,
 * but an emitter that omits it is asking the terminal for its clipboard; 'p'
 * (PRIMARY) stays ignored, since a browser cannot write that selection.
 */
function isSystemSelection(selection: unknown): boolean {
  const s = String(selection);
  return s === 'c' || s === '';
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
