'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { api, API_BASE_URL, type NotificationSettings, type Task } from '@/lib/api-client';
import { playChime } from './chime';
import { ToastStack, type AttentionToast } from './toast-stack';
import { detectTransitions, snapshotStatuses, type TaskTransitionEvent } from './transitions';

const POLL_MS = 5_000;
const SETTINGS_CHANGED_EVENT = 'haive:notification-settings-changed';

function sessionKey(e: TaskTransitionEvent): string {
  return `haive:notified:${e.taskId}:${e.status}`;
}

function hasSessionFlag(e: TaskTransitionEvent): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.sessionStorage.getItem(sessionKey(e)) !== null;
  } catch {
    return false;
  }
}

function setSessionFlag(e: TaskTransitionEvent): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(sessionKey(e), '1');
  } catch {
    // storage disabled — baseline dedupe degrades to per-page-load
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
      // '/tasks/new' yields 'new', which never equals a task uuid — safe.
      const m = /^\/tasks\/([^/]+)$/.exec(pathRef.current ?? '');
      const currentTaskId = m?.[1] ?? null;
      const isCurrent = e.taskId === currentTaskId;
      const focused = document.visibilityState === 'visible' && document.hasFocus();

      if (e.baseline && hasSessionFlag(e)) return;
      if (e.status === 'waiting_user') setSessionFlag(e);

      if (isCurrent && focused) return;

      if (!isCurrent) {
        const toast: AttentionToast = {
          key: `${e.taskId}:${e.status}`,
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
      if (
        typeof Notification !== 'undefined' &&
        Notification.permission === 'granted' &&
        !focused
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
    },
    [playSound, router],
  );

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const data = await api.get<{ tasks: Task[] }>('/tasks');
        if (cancelled) return;
        const events = detectTransitions(prevRef.current, data.tasks);
        prevRef.current = snapshotStatuses(data.tasks);
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
