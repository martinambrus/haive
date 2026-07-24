'use client';

import { useEffect, useRef, useState } from 'react';
import { api, API_BASE_URL, type ApiError, type NotificationSettings } from '@/lib/api-client';
import { usePageTitle } from '@/lib/use-page-title';
import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  FormError,
} from '@/components/ui';
import { playChime } from '@/components/notifications/chime';

function notifySettingsChanged(): void {
  window.dispatchEvent(new CustomEvent('haive:notification-settings-changed'));
}

/** The api-client wrapper always sends JSON — multipart needs a raw fetch so
 *  the browser sets the boundary (precedent: postUserActive). */
async function uploadSound(file: File): Promise<NotificationSettings> {
  const fd = new FormData();
  fd.append('sound', file);
  const res = await fetch(`${API_BASE_URL}/user-settings/notifications/sound`, {
    method: 'POST',
    credentials: 'include',
    body: fd,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as NotificationSettings;
}

async function playCustomSound(): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/user-settings/notifications/sound`, {
    credentials: 'include',
  });
  if (!res.ok) throw new Error('Sound not available');
  const url = URL.createObjectURL(await res.blob());
  const audio = new Audio(url);
  audio.addEventListener('ended', () => URL.revokeObjectURL(url));
  await audio.play();
}

export default function NotificationsPage() {
  usePageTitle('Notifications');
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported' | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .get<NotificationSettings>('/user-settings/notifications')
      .then(setSettings)
      .catch((err) =>
        setLoadError((err as ApiError).message ?? 'Failed to load notification settings'),
      );
    setPermission(typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');
  }, []);

  async function toggleSound(enabled: boolean) {
    if (!settings) return;
    setError(null);
    setSettings({ ...settings, soundEnabled: enabled });
    try {
      await api.put('/user-settings/notifications', { soundEnabled: enabled });
      notifySettingsChanged();
    } catch (err) {
      setSettings({ ...settings, soundEnabled: !enabled });
      setError((err as ApiError).message ?? 'Failed to save');
    }
  }

  async function toggleUsageAlert(enabled: boolean) {
    if (!settings) return;
    setError(null);
    setSettings({ ...settings, usageAlertEnabled: enabled });
    try {
      await api.put('/user-settings/notifications', {
        soundEnabled: settings.soundEnabled,
        usageAlertEnabled: enabled,
      });
      notifySettingsChanged();
    } catch (err) {
      setSettings({ ...settings, usageAlertEnabled: !enabled });
      setError((err as ApiError).message ?? 'Failed to save');
    }
  }

  async function handleUpload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const next = await uploadSound(file);
      setSettings(next);
      notifySettingsChanged();
    } catch (err) {
      setError((err as Error).message ?? 'Upload failed');
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function removeSound() {
    setBusy(true);
    setError(null);
    try {
      await api.delete('/user-settings/notifications/sound');
      const next = await api.get<NotificationSettings>('/user-settings/notifications');
      setSettings(next);
      notifySettingsChanged();
    } catch (err) {
      setError((err as ApiError).message ?? 'Failed to remove sound');
    } finally {
      setBusy(false);
    }
  }

  async function requestPermission() {
    if (typeof Notification === 'undefined') return;
    const result = await Notification.requestPermission();
    setPermission(result);
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold text-neutral-50">Notifications</h2>
        <p className="text-sm text-neutral-400">
          Sound and browser alerts when a task needs your input, fails, or completes.
        </p>
      </div>
      <FormError message={loadError} />
      {settings && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Sound</CardTitle>
              <CardDescription>
                Played when a task starts waiting for your input or fails — for any task except the
                one you are actively viewing.
              </CardDescription>
            </CardHeader>
            <div className="flex flex-col gap-3">
              <label className="flex items-center gap-2 text-sm text-neutral-100">
                <input
                  type="checkbox"
                  checked={settings.soundEnabled}
                  onChange={(e) => void toggleSound(e.target.checked)}
                  className="h-4 w-4 rounded border-neutral-700 bg-neutral-950"
                />
                Play a sound when a task needs attention
              </label>

              {settings.hasCustomSound ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm text-neutral-300">
                    {settings.soundFilename ?? 'custom sound'}
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void playCustomSound().catch(() => setError('Playback failed'))}
                  >
                    Test
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void removeSound()}
                  >
                    Remove
                  </Button>
                </div>
              ) : (
                <p className="text-xs text-neutral-500">
                  No custom sound uploaded — a short built-in chime plays.{' '}
                  <button
                    type="button"
                    onClick={() => playChime()}
                    className="text-indigo-400 underline hover:text-indigo-300"
                  >
                    Test chime
                  </button>
                </p>
              )}

              <div className="flex flex-col gap-1.5">
                <input
                  ref={fileInputRef}
                  id="notification-sound"
                  type="file"
                  accept="audio/*"
                  disabled={busy}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void handleUpload(file);
                  }}
                  className="text-sm text-neutral-300 file:mr-3 file:rounded-md file:border file:border-neutral-700 file:bg-neutral-900 file:px-3 file:py-1.5 file:text-xs file:text-neutral-200"
                />
                <p className="text-xs text-neutral-500">
                  MP3, WAV, OGG, WebM, M4A, AAC, or FLAC — up to 2 MiB.
                </p>
              </div>
              <FormError message={error} />
            </div>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Browser notifications</CardTitle>
              <CardDescription>
                Operating-system notifications when a task needs input, fails, or completes while
                this tab is unfocused. Click one to jump to the task.
              </CardDescription>
            </CardHeader>
            <div className="flex flex-col gap-3">
              {permission === 'unsupported' ? (
                <p className="text-sm text-neutral-400">
                  This browser does not support notifications.
                </p>
              ) : (
                <div className="flex items-center gap-3">
                  <Badge
                    variant={
                      permission === 'granted'
                        ? 'success'
                        : permission === 'denied'
                          ? 'error'
                          : 'default'
                    }
                  >
                    {permission === 'granted'
                      ? 'Enabled'
                      : permission === 'denied'
                        ? 'Blocked'
                        : 'Not enabled'}
                  </Badge>
                  {permission === 'default' && (
                    <Button size="sm" onClick={() => void requestPermission()}>
                      Enable browser notifications
                    </Button>
                  )}
                </div>
              )}
              {permission === 'denied' && (
                <p className="text-xs text-neutral-500">
                  Notifications are blocked for this site. Re-enable them in your browser&apos;s
                  site settings.
                </p>
              )}
              <p className="text-xs text-neutral-500">
                OS notifications fire only while a Haive tab is open, and only when the tab is
                unfocused.
              </p>
            </div>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Subscription usage alerts</CardTitle>
              <CardDescription>
                A heads-up when a CLI subscription window (5-hour, weekly or daily) is nearly used
                up, so a long task does not stop on a rate limit unannounced. Silent and
                informational: a toast while you are here, a browser notification while you are not.
                Fires once per provider per window until that window resets. Your administrator sets
                the percentage.
              </CardDescription>
            </CardHeader>
            <label className="flex items-center gap-2 text-sm text-neutral-100">
              <input
                type="checkbox"
                checked={settings.usageAlertEnabled}
                onChange={(e) => void toggleUsageAlert(e.target.checked)}
                className="h-4 w-4 rounded border-neutral-700 bg-neutral-950"
              />
              Warn me when a CLI subscription is nearly used up
            </label>
          </Card>
        </>
      )}
    </div>
  );
}
