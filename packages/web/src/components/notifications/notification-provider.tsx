'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { api, API_BASE_URL, type NotificationSettings, type Task } from '@/lib/api-client';
import { playChime } from './chime';
import { ToastStack, type AttentionToast } from './toast-stack';
import {
  detectTransitions,
  detectAllowanceReplenished,
  detectAutoResumed,
  snapshotIdentities,
  snapshotAllowance,
  snapshotAutoResumed,
  type TaskTransitionEvent,
} from './transitions';

const POLL_MS = 5_000;
const SETTINGS_CHANGED_EVENT = 'haive:notification-settings-changed';

const SEEN_PREFIX = 'haive:notif-seen:';
const SEEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Cross-tab "actively viewing" registry. A tab that is the visible, focused
 *  viewer of /tasks/:id heartbeats haive:viewing:<id> every VIEWING_HEARTBEAT_MS.
 *  Every tab consults it before alerting, so a transition for a task the user is
 *  watching in a SIBLING tab fires nothing — no toast, no sound, no OS notif. The
 *  local `viewing` check below only sees the tab it runs in, and whichever tab
 *  polls a transition first is arbitrary, so the viewing tab's knowledge has to
 *  be shared. Heartbeat (1s) < stale window (3s) so an actively-viewed task is
 *  always fresh at poll time; a clean blur/visibility/route change drops the
 *  claim immediately, so alerts resume the instant the user looks away. */
const VIEWING_PREFIX = 'haive:viewing:';
const VIEWING_HEARTBEAT_MS = 1_000;
const VIEWING_STALE_MS = 3_000;

/** Per-episode dedupe key: (task, status, step, wait-occurrence). localStorage
 *  (not sessionStorage) so a handled episode stays handled across tabs AND
 *  sessions — opening a new tab never re-fires an already-seen waiting
 *  notification. currentStepId distinguishes gates; currentWaitStartedAt
 *  distinguishes wait OCCURRENCES so the same gate re-notifies after a
 *  restart/retry (the new wait carries a fresh waitingStartedAt), while a new
 *  tab on the still-ongoing wait shares the key and stays deduped. */
function seenKey(e: TaskTransitionEvent): string {
  return `${SEEN_PREFIX}${e.taskId}:${e.status}:${e.currentStepId ?? ''}:${e.currentWaitStartedAt ?? ''}`;
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
      if (!k) continue;
      const ts = Number(window.localStorage.getItem(k));
      if (k.startsWith(SEEN_PREFIX)) {
        if (!Number.isFinite(ts) || now - ts > SEEN_TTL_MS) stale.push(k);
      } else if (k.startsWith(VIEWING_PREFIX)) {
        // viewing keys are normally cleared on blur/unmount; only a hard
        // crash leaves one behind. Drop it once past the stale window.
        if (!Number.isFinite(ts) || now - ts > VIEWING_STALE_MS) stale.push(k);
      }
    }
    for (const k of stale) window.localStorage.removeItem(k);
  } catch {
    // ignore
  }
}

function viewingKey(taskId: string): string {
  return `${VIEWING_PREFIX}${taskId}`;
}

/** True when SOME tab is the visible, focused viewer of this task right now
 *  (a fresh heartbeat exists). Missing key → Number(null) is 0 → far past the
 *  stale window → false. */
function isViewedElsewhere(taskId: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const ts = Number(window.localStorage.getItem(viewingKey(taskId)));
    return Number.isFinite(ts) && Date.now() - ts < VIEWING_STALE_MS;
  } catch {
    return false;
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
    case 'allowance_replenished':
      return 'Allowance is back — ready to retry';
    case 'auto_resumed':
      return 'Auto-resumed — allowance is back';
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
  // Separate prev-map for the allowance-back channel (taskId -> replenished stamp), diffed
  // independently of the status channel so the two never clobber each other's baseline.
  const prevAllowanceRef = useRef<Map<string, string> | null>(null);
  // Separate prev-map for the auto-resume channel (taskId -> auto-resumed stamp), diffed
  // independently so it never clobbers the status/allowance baselines.
  const prevAutoResumedRef = useRef<Map<string, string> | null>(null);
  const settingsRef = useRef<{ soundEnabled: boolean; hasCustomSound: boolean }>({
    soundEnabled: true,
    hasCustomSound: false,
  });
  const soundUrlRef = useRef<string | null>(null);
  const swRegRef = useRef<ServiceWorkerRegistration | null>(null);

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

  // Register the notification service worker once. It owns OS-notification
  // display and click routing (see public/sw.js). `ready` resolves with an
  // ACTIVE registration — required by showNotification — so swRegRef only ever
  // holds a usable worker; until then the OS-notif branch in handleEvent skips
  // (toast + sound still fire). register() is idempotent under StrictMode.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    let cancelled = false;
    navigator.serviceWorker.register('/sw.js').catch(() => {});
    navigator.serviceWorker.ready
      .then((reg) => {
        if (!cancelled) swRegRef.current = reg;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Answer the service worker's "which route are you on?" probe (public/sw.js).
  // On a notification click the worker asks every open tab for its LIVE
  // pathname — it cannot observe client-side (App Router) navigations via
  // WindowClient.url — so the tab that pushed to /tasks/:id reports it here and
  // gets focused instead of a duplicate tab being opened.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string } | null;
      if (data?.type === 'query-route' && event.ports[0]) {
        event.ports[0].postMessage({ path: window.location.pathname });
      }
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, []);

  // Maintain this tab's cross-tab "viewing" claim. Only a visible, focused tab on
  // a /tasks/:id route claims that task; the claim refreshes on a heartbeat and is
  // dropped the moment focus/visibility/route changes so sibling tabs resume
  // alerting as soon as the user looks away. Read back by isViewedElsewhere().
  useEffect(() => {
    let claimed: string | null = null;
    const viewedTask = (): string | null => {
      if (document.visibilityState !== 'visible' || !document.hasFocus()) return null;
      const m = /^\/tasks\/([^/]+)$/.exec(pathRef.current ?? '');
      return m?.[1] ?? null;
    };
    const tick = () => {
      const next = viewedTask();
      if (claimed && claimed !== next) {
        try {
          window.localStorage.removeItem(viewingKey(claimed));
        } catch {
          // ignore
        }
        claimed = null;
      }
      if (next) {
        try {
          window.localStorage.setItem(viewingKey(next), String(Date.now()));
        } catch {
          // ignore
        }
        claimed = next;
      }
    };
    tick();
    const timer = setInterval(tick, VIEWING_HEARTBEAT_MS);
    const onChange = () => tick();
    document.addEventListener('visibilitychange', onChange);
    window.addEventListener('focus', onChange);
    window.addEventListener('blur', onChange);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onChange);
      window.removeEventListener('focus', onChange);
      window.removeEventListener('blur', onChange);
      if (claimed) {
        try {
          window.localStorage.removeItem(viewingKey(claimed));
        } catch {
          // ignore
        }
      }
    };
  }, []);

  // Prune live toasts the user has since opened. Once SOME focused tab becomes the
  // viewer of a toast's task — this tab via in-tab nav, or a sibling tab/window —
  // its haive:viewing:<id> heartbeat goes fresh and the toast is redundant: the
  // user has seen the task even without clicking the toast. Checked at heartbeat
  // cadence; the guarded functional update returns the same array reference when
  // nothing is pruned so idle tabs never re-render.
  useEffect(() => {
    const timer = setInterval(() => {
      setToasts((prev) => {
        if (prev.length === 0) return prev;
        const next = prev.filter((t) => !isViewedElsewhere(t.taskId));
        return next.length === prev.length ? prev : next;
      });
    }, VIEWING_HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, []);

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
      // "Viewing" = the user is genuinely looking at THIS task: its tab is
      // rendered AND its window has focus. visibilityState alone is `visible` for
      // a task left open in a SEPARATE window/monitor while another window is on
      // top — which wrongly suppressed the very alert the user is waiting for
      // (their reported case: restart a task in window A, work in window B, never
      // get notified). Require hasFocus() too. At a waiting_user gate the focused
      // element is the same-origin form, so the cross-origin VNC-iframe focus
      // quirk (which only matters during a running terminal, not a gate) does not
      // apply; and the OS-notification branch below already pivots on hasFocus(),
      // so the two stay consistent.
      const viewing = isCurrent && document.visibilityState === 'visible' && document.hasFocus();
      if (viewing) {
        markSeen(e); // looking at it now → don't nag for this episode anywhere
        return;
      }

      // A SIBLING tab may be the focused viewer even when this tab isn't: whichever
      // tab polls a transition first is arbitrary, so before firing anything (toast,
      // sound, OS notif) consult the cross-tab heartbeat. Without this, a hidden tab
      // on the wrong route alerts for a task the user is already reading in another
      // tab, just because it processed the event before the viewing tab did.
      if (isViewedElsewhere(e.taskId)) {
        markSeen(e); // read in another tab → suppress everywhere for this episode
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
        !document.hasFocus() &&
        swRegRef.current
      ) {
        // Display + click routing live in the service worker (public/sw.js): a
        // shared worker can focus the tab already showing the task — or open a
        // new one — whereas a page-scoped Notification click only reaches the
        // arbitrary tab that built it. Fire-and-forget; failures are non-fatal.
        void swRegRef.current
          .showNotification(`Haive — ${e.title}`, {
            body: bodyFor(e.status),
            tag: e.taskId,
            data: { url: `/tasks/${e.taskId}` },
          })
          .catch(() => {});
      }
      markSeen(e); // surfaced once — other tabs/sessions skip it from here on
    },
    [playSound],
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
        // Separate channel: fire once when a rate-limit-failed task's CLI allowance returns.
        const allowanceEvents = detectAllowanceReplenished(prevAllowanceRef.current, data.tasks);
        prevAllowanceRef.current = snapshotAllowance(data.tasks);
        for (const event of allowanceEvents) handleEvent(event);
        // Separate channel: fire once when the poller AUTO-resumes a task after its allowance
        // returned (only when AUTO_RESUME_ON_ALLOWANCE is on). No baseline — see detectAutoResumed.
        const autoResumedEvents = detectAutoResumed(prevAutoResumedRef.current, data.tasks);
        prevAutoResumedRef.current = snapshotAutoResumed(data.tasks);
        for (const event of autoResumedEvents) handleEvent(event);
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
