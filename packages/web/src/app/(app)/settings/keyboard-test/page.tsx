'use client';

import { useEffect, useRef, useState } from 'react';
import { InlineMarkdown } from '@/components/markdown/inline-markdown';
import { useKeyboardFullscreen } from '@/lib/use-keyboard-fullscreen';

interface KeySample {
  id: number;
  type: string;
  key: string;
  code: string;
  modifiers: string;
  cancelable: boolean;
  prevented: boolean;
  repeat: boolean;
}

/** Uses the same fullscreen request as VNC, without a runtime or remote browser.
 * No global key listeners: leaving the capture area restores normal page input. */
export default function KeyboardTestPage() {
  const panel = useRef<HTMLDivElement | null>(null);
  const capture = useRef<HTMLDivElement | null>(null);
  const nextId = useRef(0);
  const [samples, setSamples] = useState<KeySample[]>([]);
  const [focused, setFocused] = useState(false);
  const [environment, setEnvironment] = useState('');
  const keyboardFullscreen = useKeyboardFullscreen(panel, () => {
    capture.current?.focus({ preventScroll: true });
  });

  useEffect(() => {
    setEnvironment(`${navigator.userAgent} · Secure context: ${window.isSecureContext}`);
    const target = capture.current;
    if (!target) return;
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const sample: KeySample = {
        id: ++nextId.current,
        type: event.type,
        key: event.key,
        code: event.code,
        modifiers: [
          event.ctrlKey && 'Ctrl',
          event.altKey && 'Alt',
          event.shiftKey && 'Shift',
          event.metaKey && 'Meta',
        ]
          .filter(Boolean)
          .join('+'),
        cancelable: event.cancelable,
        prevented: event.defaultPrevented,
        repeat: event.repeat,
      };
      setSamples((previous) => [sample, ...previous].slice(0, 80));
    };
    target.addEventListener('keydown', onKey);
    target.addEventListener('keyup', onKey);
    return () => {
      target.removeEventListener('keydown', onKey);
      target.removeEventListener('keyup', onKey);
    };
  }, []);

  return (
    <div
      ref={panel}
      className="flex h-full min-h-[480px] flex-col gap-4 overflow-auto rounded-lg bg-neutral-950 p-6 text-neutral-200"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Keyboard capture test</h2>
        <div className="flex gap-4">
          <button
            type="button"
            onClick={() => setSamples([])}
            className="text-sm text-indigo-400 underline"
          >
            Clear events
          </button>
          <button
            type="button"
            onClick={
              keyboardFullscreen.fullscreen ? keyboardFullscreen.exit : keyboardFullscreen.enter
            }
            className="text-sm text-indigo-400 underline"
          >
            {keyboardFullscreen.fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          </button>
        </div>
      </div>
      <InlineMarkdown
        className="text-sm text-neutral-400"
        body="Click the capture area, then try ordinary typing and Ctrl+W, Ctrl+Tab, Ctrl+Shift+Tab and Ctrl+L **in fullscreen**. This uses the VNC viewer’s keyboard capture. Hold Esc or click **Exit fullscreen** to leave. Outside fullscreen, reserved shortcuts may close or switch this Firefox tab."
      />
      <InlineMarkdown
        className="text-sm text-neutral-400"
        body="Compare the results through RustDesk and directly at the PC, if available. If a combination works directly but produces no event through RustDesk, input is being intercepted before it reaches this page. Events stay in this page and disappear on reload."
      />
      {keyboardFullscreen.notice && (
        <InlineMarkdown className="text-sm text-amber-400" body={keyboardFullscreen.notice} />
      )}
      <div
        ref={capture}
        tabIndex={0}
        role="region"
        aria-label="Keyboard capture area"
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className="rounded-md border border-neutral-700 bg-neutral-900 p-6 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-400"
      >
        {focused ? 'Capturing keys here' : 'Click here to capture keys'}
      </div>
      <div className="overflow-auto">
        <table className="w-full text-left font-mono text-xs">
          <thead>
            <tr>
              {['Event', 'Key', 'Code', 'Modifiers', 'Cancelable', 'Prevented', 'Repeat'].map(
                (label) => (
                  <th key={label} className="px-2 py-1">
                    {label}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {samples.map((sample) => (
              <tr key={sample.id} className="border-t border-neutral-800">
                {[
                  sample.type,
                  sample.key,
                  sample.code,
                  sample.modifiers,
                  String(sample.cancelable),
                  String(sample.prevented),
                  String(sample.repeat),
                ].map((value, index) => (
                  <td key={index} className="px-2 py-1">
                    {value || '—'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="break-all font-mono text-xs text-neutral-500">{environment}</div>
    </div>
  );
}
