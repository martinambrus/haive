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

/**
 * OSC 52 clipboard provider for `ClipboardAddon`.
 *
 * The addon's own provider hands the raw `navigator.clipboard` promise back to
 * the addon, which chains `.then(() => true)` and never catches. OSC 52 is
 * driven by CLI output rather than by a keystroke, so Firefox always refuses the
 * write — no user activation, and no synchronous `execCommand` route exists
 * outside a user-input handler either — and the rejection surfaces as the same
 * page-level `NotAllowedError`. Nothing can grant the access from here, so the
 * honest behaviour is a silent no-op: the CLI's copy request is dropped and the
 * page stays up.
 */
export const osc52ClipboardProvider: IClipboardProvider = {
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
    } catch {
      // Clipboard denied without a user gesture — drop the OSC 52 copy.
    }
  },
};

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
