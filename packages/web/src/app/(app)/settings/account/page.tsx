'use client';

import { useEffect, useState } from 'react';
import { api, type ApiError } from '@/lib/api-client';
import {
  Button,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  Input,
  Label,
  FormError,
} from '@/components/ui';

interface AccountData {
  name: string | null;
  phone: string | null;
  email: string;
}

export default function AccountPage() {
  const [account, setAccount] = useState<AccountData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileSuccess, setProfileSuccess] = useState<string | null>(null);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<AccountData>('/user-settings/account')
      .then((data) => {
        setAccount(data);
        setName(data.name ?? '');
        setPhone(data.phone ?? '');
      })
      .catch((err) => setLoadError((err as ApiError).message ?? 'Failed to load account'));
  }, []);

  async function handleProfileSave() {
    setProfileSaving(true);
    setProfileError(null);
    setProfileSuccess(null);
    try {
      await api.put<{ ok: boolean }>('/user-settings/account', { name, phone });
      setAccount((prev) =>
        prev ? { ...prev, name: name.trim() || null, phone: phone.trim() || null } : prev,
      );
      setProfileSuccess('Profile saved.');
    } catch (err) {
      setProfileError((err as ApiError).message ?? 'Failed to save profile');
    } finally {
      setProfileSaving(false);
    }
  }

  async function handlePasswordSave() {
    setPasswordError(null);
    setPasswordSuccess(null);
    if (newPassword.length < 12) {
      setPasswordError('New password must be at least 12 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('New password and confirmation do not match.');
      return;
    }
    setPasswordSaving(true);
    try {
      await api.put<{ ok: boolean }>('/user-settings/password', {
        currentPassword,
        newPassword,
      });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordSuccess('Password changed. Other devices have been signed out.');
    } catch (err) {
      setPasswordError((err as ApiError).message ?? 'Failed to change password');
    } finally {
      setPasswordSaving(false);
    }
  }

  if (account === null && !loadError) {
    return <p className="text-sm text-neutral-400">Loading account...</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold text-neutral-50">Account</h2>
        <p className="text-sm text-neutral-400">Manage your personal profile and password.</p>
      </div>

      <FormError message={loadError} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Profile</CardTitle>
          <CardDescription>
            Your display name and contact phone. Email is shown for reference and cannot be changed
            here.
          </CardDescription>
        </CardHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-email">Email</Label>
            <Input id="account-email" type="email" value={account?.email ?? ''} readOnly disabled />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-name">Name</Label>
            <Input
              id="account-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your display name"
              maxLength={80}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-phone">Phone</Label>
            <Input
              id="account-phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+1 555 555 5555"
              maxLength={32}
            />
          </div>
          <FormError message={profileError} />
          {profileSuccess && (
            <div className="rounded-md border border-emerald-900 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-200">
              {profileSuccess}
            </div>
          )}
          <div>
            <Button size="sm" onClick={handleProfileSave} disabled={profileSaving}>
              {profileSaving ? 'Saving...' : 'Save profile'}
            </Button>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Password</CardTitle>
          <CardDescription>
            Changing your password signs out all other devices. The current device stays signed in.
          </CardDescription>
        </CardHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-current-password">Current password</Label>
            <Input
              id="account-current-password"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-new-password">New password</Label>
            <Input
              id="account-new-password"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              placeholder="At least 12 characters"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-confirm-password">Confirm new password</Label>
            <Input
              id="account-confirm-password"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
            />
          </div>
          <FormError message={passwordError} />
          {passwordSuccess && (
            <div className="rounded-md border border-emerald-900 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-200">
              {passwordSuccess}
            </div>
          )}
          <div>
            <Button
              size="sm"
              onClick={handlePasswordSave}
              disabled={passwordSaving || !currentPassword || !newPassword || !confirmPassword}
            >
              {passwordSaving ? 'Saving...' : 'Change password'}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
