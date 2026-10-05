'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { createKeyboardFullscreen } from './keyboard-fullscreen';

export function useKeyboardFullscreen(element: RefObject<HTMLElement | null>, focus: () => void) {
  const [fullscreen, setFullscreen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const session = useRef<ReturnType<typeof createKeyboardFullscreen> | null>(null);

  useEffect(() => {
    if (!element.current) return;
    const current = createKeyboardFullscreen(
      element.current,
      () => focusRef.current(),
      (active, note) => {
        setFullscreen(active);
        setNotice(note);
        setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
      },
    );
    session.current = current;
    return () => {
      session.current = null;
      current.dispose();
    };
  }, [element]);

  const enter = useCallback(() => {
    void session.current?.enter();
  }, []);
  const exit = useCallback(() => {
    void session.current?.exit();
  }, []);
  return { fullscreen, notice, enter, exit };
}
