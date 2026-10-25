'use client';

import { useEffect, useState } from 'react';
import { API_BASE_URL } from '@/lib/api-client';
import { recoverBrowserSession } from '@/lib/browser-session';
import { MarkdownView } from '@/components/markdown/markdown-view';

const RECOVERY_STAMP = 'haive:session-recovery-at';

/** The failed server read is only a snapshot. Recheck with the browser's current cookie jar,
 * install replacements there, then render the original URL again with fresh role/prefs/modules. */
export function SessionRecovery() {
  const [attempt, setAttempt] = useState(0);
  const [waiting, setWaiting] = useState(true);
  useEffect(() => {
    let active = true;
    setWaiting(true);
    void recoverBrowserSession(API_BASE_URL).then((result) => {
      if (!active) return;
      if (result === 'rejected') {
        window.location.replace('/login?session=expired');
      } else if (result === 'authenticated') {
        try {
          const last = Number(window.sessionStorage.getItem(RECOVERY_STAMP) ?? 0);
          if (attempt === 0 && Date.now() - last < 30_000) {
            setWaiting(false);
            return;
          }
          window.sessionStorage.setItem(RECOVERY_STAMP, String(Date.now()));
          // No return URL input: reload exactly the page the browser was already visiting.
          window.location.reload();
        } catch {
          // Without a reload stamp, an inconsistent upstream could cause a reload loop.
          setWaiting(false);
        }
      } else {
        setWaiting(false);
      }
    });
    return () => {
      active = false;
    };
  }, [attempt]);

  return (
    <main className="mx-auto max-w-lg p-8" aria-live="polite">
      <MarkdownView
        body={
          waiting
            ? 'Checking your session…'
            : 'Your session could not be checked. Try again when the connection is available.'
        }
      />
      {!waiting && (
        <div className="mt-4 flex gap-4">
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            Try again
          </button>
          <a href="/login?session=expired">Sign in</a>
        </div>
      )}
    </main>
  );
}
