'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { api, API_BASE_URL, type NotificationSettings, type Task } from '@/lib/api-client';
import { playChime } from './chime';
import { ToastStack, type AttentionToast } from './toast-stack';
import { detectTransitions, snapshotIdentities, type TaskTransitionEvent } from './transitions';

const POLL_MS = 5_000;
const SETTINGS_CHANGED_EVENT = 'haive:notification-settings-changed';

const SEEN_PREFIX = 'haive:notif-seen:';
const SEEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Per-episode dedupe key: (task, status, step, occurrence). localStorage (not
 *  sessionStorage) so a handled episode stays handled across tabs AND sessions
 *  — opening a new tab never re-fires an already-seen waiting notification.
 *  currentStepId distinguishes gates; updatedAt distinguishes wait OCCURRENCES
 *  so the same gate re-notifies after a restart/retry (a new wait carries a new
 *  updatedAt), while a new tab on the still-ongoing wait shares the key and
 *  stays deduped. */
function seenKey(e: TaskTransitionEvent): string {
  return `${SEEN_PREFIX}${e.taskId}:${e.status}:${e.currentStepId ?? ''}:${e.updatedAt}`;
}

function hasSeen(e: TaskTransitionEvent): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(seenKey(e)) !== null;
  } catch {
    return false;
  }
}

function markSeen(e: TaskTransitionEvent): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(seenKey(e), String(Date.now()));
  } catch {
    // storage disabled — dedupe degrades to per-poll (fires on each transition)
  }
}

/** Drop seen-entries past the TTL so the store can't grow unbounded (a handled
 *  episode never needs its flag once the task has moved on). Runs once on mount. */
function pruneSeen(): void {
  if (typeof window === 'undefined') return;
  try {
    const now = Date.now();
    const stale: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (!k || !k.startsWith(SEEN_PREFIX)) continue;
      const ts = Number(window.localStorage.getItem(k));
      if (!Number.isFinite(ts) || now - ts > SEEN_TTL_MS) stale.push(k);
    }
    for (const k of stale) window.localStorage.removeItem(k);
  } catch {
    // ignore
  }
}

function bodyFor(status: TaskTransitionEvent['status']): string {
  switch (status) {
    case 'waiting_user':
      return 'Waiting for your input';
    case 'failed':
      return 'Task failed';
    case 'completed':
      return 'Task completed';
  }
}

/** Global task-attention watcher, mounted once in the authed (app) layout.
 *  Polls the task list, diffs statuses, and surfaces attention events as
 *  persistent toasts, a notification sound, and OS browser notifications per
 *  the behavior matrix:
 *    - current task route + focused: nothing (the user is looking at it)
 *    - current task route + unfocused: sound (+ OS notif), no toast
 *    - other route: toast + sound (+ OS notif when hidden/unfocused)
 *    - completed: never plays a sound (it is not waiting on anyone)
 *  Best-effort by design: every network/audio failure is swallowed. */
export function NotificationProvider() {
  const router = useRouter();
  const pathname = usePathname();
  const pathRef = useRef(pathname);
  pathRef.current = pathname;

  const [toasts, setToasts] = useState<AttentionToast[]>([]);
  const prevRef = useRef<Map<string, string> | null>(null);
  const settingsRef = useRef<{ soundEnabled: boolean; hasCustomSound: boolean }>({
    soundEnabled: true,
    hasCustomSound: false,
  });
  const soundUrlRef = useRef<string | null>(null);

  const fetchSoundBlob = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/user-settings/notifications/sound`, {
        credentials: 'include',
      });
      if (!res.ok) return;
      const url = URL.createObjectURL(await res.blob());
      if (soundUrlRef.current) URL.revokeObjectURL(soundUrlRef.current);
      soundUrlRef.current = url;
    } catch {
      // keep the chime fallback
    }
  }, []);

  const loadSettings = useCallback(
    async (refetchBlob: boolean) => {
      try {
        const prevHadCustom = settingsRef.current.hasCustomSound;
        const data = await api.get<NotificationSettings>('/user-settings/notifications');
        settingsRef.current = {
          soundEnabled: data.soundEnabled,
          hasCustomSound: data.hasCustomSound,
        };
        if (!data.hasCustomSound && soundUrlRef.current) {
          URL.revokeObjectURL(soundUrlRef.current);
          soundUrlRef.current = null;
        } else if (data.hasCustomSound && (refetchBlob || !prevHadCustom)) {
          await fetchSoundBlob();
        }
      } catch {
        // offline / logged out — keep last known settings
      }
    },
    [fetchSoundBlob],
  );

  useEffect(() => {
    void loadSettings(true);
    const onChanged = () => void loadSettings(true);
    // Window focus only re-reads the JSON; the blob is refetched when
    // hasCustomSound flips so an alt-tab never re-downloads up to 2 MiB.
    const onFocus = () => void loadSettings(false);
    window.addEventListener(SETTINGS_CHANGED_EVENT, onChanged);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener(SETTINGS_CHANGED_EVENT, onChanged);
      window.removeEventListener('focus', onFocus);
      if (soundUrlRef.current) URL.revokeObjectURL(soundUrlRef.current);
    };
  }, [loadSettings]);

  const playSound = useCallback(() => {
    if (soundUrlRef.current) {
      void new Audio(soundUrlRef.current).play().catch(() => {});
    } else {
      playChime();
    }
  }, []);

  const handleEvent = useCallback(
    (e: TaskTransitionEvent) => {
      // Already surfaced/handled (in any tab or a prior session) — never repeat.
      if (hasSeen(e)) return;

      // '/tasks/new' yields 'new', which never equals a task uuid — safe.
      const m = /^\/tasks\/([^/]+)$/.exec(pathRef.current ?? '');
      const currentTaskId = m?.[1] ?? null;
      const isCurrent = e.taskId === currentTaskId;
      // Tab VISIBILITY (not hasFocus): focus inside the embedded cross-origin
      // VNC/browser iframe at a gate makes hasFocus() false, which would defeat
      // the "you're looking at it" suppression — visibilityState has no such hole.
      const viewing = isCurrent && document.visibilityState === 'visible';
      if (viewing) {
        markSeen(e); // looking at it now → don't nag for this episode anywhere
        return;
      }

      if (!isCurrent) {
        const toast: AttentionToast = {
          key: `${e.taskId}:${e.status}:${e.currentStepId ?? ''}`,
          taskId: e.taskId,
          title: e.title,
          status: e.status,
          message: bodyFor(e.status),
        };
        setToasts((prev) => [...prev.filter((t) => t.key !== toast.key), toast]);
      }
      if (e.status !== 'completed' && settingsRef.current.soundEnabled) {
        playSound();
      }
      // OS notification only when the browser window isn't focused (the user is
      // elsewhere). hasFocus() is the right signal here — distinct from the
      // visibility check above that gates the "viewing this task" suppression.
      if (
        typeof Notification !== 'undefined' &&
        Notification.permission === 'granted' &&
        !document.hasFocus()
      ) {
        try {
          const n = new Notification(`Haive — ${e.title}`, {
            body: bodyFor(e.status),
            tag: e.taskId,
          });
          n.onclick = () => {
            window.focus();
            router.push(`/tasks/${e.taskId}`);
            n.close();
          };
        } catch {
          // notification construction can throw on some platforms — ignore
        }
      }
      markSeen(e); // surfaced once — other tabs/sessions skip it from here on
    },
    [playSound, router],
  );

  useEffect(() => {
    pruneSeen();
    let cancelled = false;
    const poll = async () => {
      try {
        const data = await api.get<{ tasks: Task[] }>('/tasks');
        if (cancelled) return;
        const events = detectTransitions(prevRef.current, data.tasks);
        prevRef.current = snapshotIdentities(data.tasks);
        for (const event of events) handleEvent(event);
      } catch {
        // offline or auth refresh in flight — try again next tick
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [handleEvent]);

  return (
    <ToastStack
      toasts={toasts}
      onOpen={(toast) => {
        setToasts((prev) => prev.filter((t) => t.key !== toast.key));
        router.push(`/tasks/${toast.taskId}`);
      }}
      onDismiss={(key) => setToasts((prev) => prev.filter((t) => t.key !== key))}
    />
  );
}
