'use client';

import { useCallback, useRef, useState } from 'react';
import type { Terminal as XTerm } from '@xterm/xterm';
import { copyTerminalSelection } from '@/lib/terminal-copy';

/**
 * Selection tracking + copy for an interactive terminal pane.
 *
 * The shell runs inside tmux with `mouse on`, so a plain drag is reported to
 * tmux as a mouse event and copies into tmux's OWN paste buffer — xterm never
 * sees a selection and nothing reaches the system clipboard (tmux emits no
 * OSC 52 for its own copies here, measured on tmux 3.4). A browser-side
 * selection needs Shift held, which xterm treats as "force selection"
 * regardless of what the app inside is doing. That is stock xterm behaviour
 * with no affordance anywhere, hence the button this hook drives.
 *
 * Ctrl+Shift+C stays wired but cannot be the only route: in Chrome that
 * chord opens the DevTools inspector, which a page cannot swallow.
 */
export function useTerminalCopy() {
  const termRef = useRef<XTerm | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hasSelection, setHasSelection] = useState(false);
  const [copied, setCopied] = useState(false);

  /** Bind a freshly created terminal. Returns the detach for effect cleanup. */
  const attach = useCallback((term: XTerm) => {
    termRef.current = term;
    setHasSelection(false);
    const disposable = term.onSelectionChange(() => setHasSelection(term.hasSelection()));
    return () => {
      disposable.dispose();
      termRef.current = null;
      setHasSelection(false);
    };
  }, []);

  const copy = useCallback(() => {
    const selection = termRef.current?.getSelection();
    if (!selection) return;
    copyTerminalSelection(selection);
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 1200);
  }, []);

  return { attach, copy, hasSelection, copied };
}
