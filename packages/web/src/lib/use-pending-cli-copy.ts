'use client';

import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import { createOsc52Clipboard, type Osc52Clipboard } from '@/lib/terminal-copy';

/**
 * Per-terminal OSC 52 clipboard, plus the state a "Copy from CLI" button needs.
 *
 * `provider` goes to `new ClipboardAddon(undefined, provider)`. `pendingChars`
 * is non-null exactly while there is something to show: either a write the
 * browser refused (see `createOsc52Clipboard`) or the brief flash after a
 * successful flush — the store clears itself on flush, so without the flash
 * count the button would vanish before it could confirm anything.
 */
export function usePendingCliCopy() {
  const clipboardRef = useRef<Osc52Clipboard | null>(null);
  if (!clipboardRef.current) clipboardRef.current = createOsc52Clipboard();
  const clipboard = clipboardRef.current;

  const pending = useSyncExternalStore(clipboard.subscribe, clipboard.getPending, () => null);

  const [flashChars, setFlashChars] = useState<number | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copyPending = useCallback(() => {
    const chars = clipboard.getPending()?.length ?? 0;
    if (!clipboard.flush()) return;
    setFlashChars(chars);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashChars(null), 1200);
  }, [clipboard]);

  return {
    provider: clipboard.provider,
    pendingChars: pending !== null ? pending.length : flashChars,
    copied: pending === null && flashChars !== null,
    copyPending,
  };
}
