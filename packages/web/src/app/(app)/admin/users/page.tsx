'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { usePageTitle } from '@/lib/use-page-title';
import {
  api,
  type AdminCreateUserResponse,
  type AdminUser,
  type AdminUserAction,
  type AdminUserActionResponse,
} from '@/lib/api-client';
import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  FormError,
  Input,
  Label,
} from '@/components/ui';

/**
 * User management, lifted out of the admin console.
 *
 * The list and its four actions moved here unchanged from `admin/page.tsx`, which had grown past
 * 2,600 lines and loaded every one of them to render a page most visits use for one switch. The
 * console keeps the Users KPI card and links here.
 */
export default function AdminUsersPage() {
  usePageTitle('Users');
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [tempPassword, setTempPassword] = useState<{ userId: string; value: string } | null>(null);

  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState<'admin' | 'user'>('user');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ users: AdminUser[] }>('/admin/users');
      setUsers(data.users);
      setError(null);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to load users');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function runAction(user: AdminUser, action: AdminUserAction, role?: 'admin' | 'user') {
    const payload: { action: AdminUserAction; role?: 'admin' | 'user' } = { action };
    if (role) payload.role = role;

    const confirmMessages: Record<AdminUserAction, string> = {
      deactivate: `Deactivate ${user.email}? This revokes their active sessions.`,
      activate: `Reactivate ${user.email}?`,
      reset_password: `Reset password for ${user.email}? A new temporary password will be shown once.`,
      set_role: `Change role for ${user.email} to ${role}?`,
    };
    if (!confirm(confirmMessages[action])) return;

    setBusyUserId(user.id);
    try {
      const result = await api.post<AdminUserActionResponse>(
        `/admin/users/${user.id}/action`,
        payload,
      );
      if (result.temporaryPassword) {
        setTempPassword({ userId: user.id, value: result.temporaryPassword });
      }
      await load();
    } catch (err) {
      setError((err as Error).message ?? 'Action failed');
    } finally {
      setBusyUserId(null);
    }
  }

  async function createUser() {
    const email = newEmail.trim();
    if (!email) return;
    setCreating(true);
    try {
      const result = await api.post<AdminCreateUserResponse>('/admin/users', {
        email,
        role: newRole,
      });
      // Keyed on the new user's id, so the password appears on THEIR card — the same one-time
      // reveal a password reset uses, rather than a second place to look for the same secret.
      setTempPassword({ userId: result.user.id, value: result.temporaryPassword });
      setNewEmail('');
      setNewRole('user');
      setError(null);
      await load();
    } catch (err) {
      setError((err as Error).message ?? 'Failed to create the user');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-neutral-50">Users</h1>
          <p className="text-sm text-neutral-400">
            Everyone with an account on this instance. Requires an admin role.
          </p>
        </div>
        <Link href="/admin">
          <Button variant="secondary" size="sm">
            Back to admin
          </Button>
        </Link>
      </div>

      <FormError message={error} />

      <Card>
        <CardHeader>
          <CardTitle>Add a user</CardTitle>
          <CardDescription>
            Creates the account and mints a temporary password, shown once on the new user&apos;s
            card below. They are asked to replace it the first time they sign in. Use an invite
            instead when you would rather the person chose their own password.
          </CardDescription>
        </CardHeader>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-64 flex-1">
            <Label htmlFor="new-user-email">Email</Label>
            <Input
              id="new-user-email"
              type="email"
              value={newEmail}
              placeholder="person@example.com"
              onChange={(e) => setNewEmail(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="new-user-role">Role</Label>
            <select
              id="new-user-role"
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as 'admin' | 'user')}
              className="block rounded-md border border-neutral-800 bg-neutral-950 px-2 py-2 text-sm text-neutral-100 outline-none focus:border-indigo-500"
            >
              <option value="user">user</option>
              <option value="admin">admin</option>
            </select>
          </div>
          <Button
            disabled={creating || newEmail.trim().length === 0}
            onClick={() => void createUser()}
          >
            {creating ? 'Creating…' : 'Create user'}
          </Button>
        </div>
      </Card>

      <section>
        {users === null ? (
          <p className="text-sm text-neutral-500">Loading...</p>
        ) : users.length === 0 ? (
          <p className="text-sm text-neutral-500">No users.</p>
        ) : (
          <div className="grid gap-3">
            {users.map((user) => (
              <Card key={user.id}>
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate text-base font-semibold text-neutral-50">
                        {user.email}
                      </h3>
                      <Badge variant={user.role === 'admin' ? 'success' : 'default'}>
                        {user.role}
                      </Badge>
                      <Badge variant={user.status === 'active' ? 'success' : 'warning'}>
                        {user.status}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-neutral-500">
                      Created {new Date(user.createdAt).toLocaleString()} - token version{' '}
                      {user.tokenVersion}
                    </p>
                    {tempPassword?.userId === user.id && (
                      <div className="mt-2 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-200">
                        <div className="font-semibold">Temporary password (copy now):</div>
                        <code className="break-all">{tempPassword.value}</code>
                      </div>
                    )}
                  </div>
                  <div className="flex flex-shrink-0 flex-wrap gap-2">
                    {user.status === 'active' ? (
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={busyUserId === user.id}
                        onClick={() => runAction(user, 'deactivate')}
                      >
                        Deactivate
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busyUserId === user.id}
                        onClick={() => runAction(user, 'activate')}
                      >
                        Activate
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busyUserId === user.id}
                      onClick={() => runAction(user, 'reset_password')}
                    >
                      Reset password
                    </Button>
                    {user.role === 'admin' ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busyUserId === user.id}
                        onClick={() => runAction(user, 'set_role', 'user')}
                      >
                        Demote
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busyUserId === user.id}
                        onClick={() => runAction(user, 'set_role', 'admin')}
                      >
                        Promote
                      </Button>
                    )}
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
