'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePageTitle } from '@/lib/use-page-title';
import {
  api,
  type AdminCreateUserResponse,
  type AdminInvite,
  type AdminInviteCreated,
  type AdminUser,
  type AdminUserAction,
  type AdminUserActionResponse,
} from '@/lib/api-client';
import { inviteStatus, inviteStatusVariant, isRevocable } from '@/lib/invite-status';
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
/** Mirrors REGISTRATION_MODES in @haive/shared. Declared locally because web must not import the
 *  shared barrel — the same reason the admin console re-declares it. */
type RegistrationMode = 'open' | 'invite' | 'closed';

/** What the active mode means for the people this page invites. `open` is the one case where an
 *  invitation is a convenience rather than the only way in. */
const MODE_NOTE: Record<RegistrationMode, string> = {
  open: 'Anyone can register themselves right now, so an invitation is only a shortcut — though it is still the only way to hand someone the admin role at sign-up.',
  invite: 'Registration is by invitation, so a link from here is the only way in.',
  closed:
    'Registration is closed, but an invitation still admits its holder — that is what makes closed a usable default rather than a wall.',
};

const selectClass =
  'block rounded-md border border-neutral-800 bg-neutral-950 px-2 py-2 text-sm text-neutral-100 outline-none focus:border-indigo-500';

export default function AdminUsersPage() {
  usePageTitle('Users');
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [tempPassword, setTempPassword] = useState<{ userId: string; value: string } | null>(null);

  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState<'admin' | 'user'>('user');
  const [creating, setCreating] = useState(false);

  const [invites, setInvites] = useState<AdminInvite[] | null>(null);
  const [mode, setMode] = useState<RegistrationMode | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'admin' | 'user'>('user');
  const [inviteHours, setInviteHours] = useState('168');
  const [invitingBusy, setInvitingBusy] = useState(false);
  const [freshInvite, setFreshInvite] = useState<AdminInviteCreated | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const [usersData, invitesData, modeData] = await Promise.all([
        api.get<{ users: AdminUser[] }>('/admin/users'),
        api.get<{ invites: AdminInvite[] }>('/admin/invites'),
        api.get<{ mode: RegistrationMode }>('/admin/config/registration-mode'),
      ]);
      setUsers(usersData.users);
      setInvites(invitesData.invites);
      setMode(modeData.mode);
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

  async function createInvite() {
    const hours = Number.parseInt(inviteHours, 10);
    if (!Number.isInteger(hours) || hours < 1) {
      setError('Expiry must be a whole number of hours, 1 or more.');
      return;
    }
    setInvitingBusy(true);
    try {
      const email = inviteEmail.trim();
      const created = await api.post<AdminInviteCreated>('/admin/invites', {
        ...(email ? { email } : {}),
        role: inviteRole,
        expiresInHours: hours,
      });
      setFreshInvite(created);
      setCopied(false);
      setInviteEmail('');
      setError(null);
      await load();
    } catch (err) {
      setError((err as Error).message ?? 'Failed to create the invitation');
    } finally {
      setInvitingBusy(false);
    }
  }

  async function revokeInvite(id: string) {
    if (!confirm('Revoke this invitation? Anyone holding the link will be refused.')) return;
    try {
      await api.delete(`/admin/invites/${id}`);
      // The revealed link is the one thing a reload cannot bring back, so it is cleared only when
      // it is the invite being revoked.
      if (freshInvite?.id === id) setFreshInvite(null);
      await load();
    } catch (err) {
      setError((err as Error).message ?? 'Failed to revoke the invitation');
    }
  }

  const inviteLink = freshInvite
    ? `${typeof window === 'undefined' ? '' : window.location.origin}/register?invite=${freshInvite.token}`
    : null;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold text-neutral-50">Users</h2>
        <p className="text-sm text-neutral-400">
          Everyone with an account on this instance. Requires an admin role.
        </p>
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
              className={selectClass}
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

      <Card>
        <CardHeader>
          <CardTitle>Invitations</CardTitle>
          <CardDescription>
            A one-time link that lets someone create their own account, with the role the invite
            carries. The token is shown once here and stored only as a hash, so a link that is lost
            is replaced rather than recovered.
            {mode && <> {MODE_NOTE[mode]}</>}
          </CardDescription>
        </CardHeader>

        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-56 flex-1">
            <Label htmlFor="invite-email">Bind to an email (optional)</Label>
            <Input
              id="invite-email"
              type="email"
              value={inviteEmail}
              placeholder="anyone with the link"
              onChange={(e) => setInviteEmail(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="invite-role">Role</Label>
            <select
              id="invite-role"
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as 'admin' | 'user')}
              className={selectClass}
            >
              <option value="user">user</option>
              <option value="admin">admin</option>
            </select>
          </div>
          <div className="w-32">
            <Label htmlFor="invite-hours">Expires in (h)</Label>
            <Input
              id="invite-hours"
              type="number"
              min={1}
              value={inviteHours}
              onChange={(e) => setInviteHours(e.target.value)}
            />
          </div>
          <Button disabled={invitingBusy} onClick={() => void createInvite()}>
            {invitingBusy ? 'Creating…' : 'Create invitation'}
          </Button>
        </div>

        {inviteLink && (
          <div className="mt-3 rounded border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
            <div className="font-semibold">Invitation link (copy now — shown once):</div>
            <code className="mt-1 block break-all">{inviteLink}</code>
            <Button
              size="sm"
              variant="secondary"
              className="mt-2"
              onClick={() => {
                // Best effort: a browser that refuses the clipboard still leaves the link
                // selectable above, which is the thing that must not be lost.
                void navigator.clipboard?.writeText(inviteLink).then(
                  () => setCopied(true),
                  () => setCopied(false),
                );
              }}
            >
              {copied ? 'Copied' : 'Copy link'}
            </Button>
          </div>
        )}

        {invites !== null && invites.length > 0 && (
          <div className="mt-4 flex flex-col gap-2">
            {invites.map((invite) => {
              const status = inviteStatus(invite);
              return (
                <div
                  key={invite.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-neutral-800 px-3 py-2 text-xs"
                >
                  <Badge variant={inviteStatusVariant(status)}>{status}</Badge>
                  <Badge variant={invite.role === 'admin' ? 'success' : 'default'}>
                    {invite.role}
                  </Badge>
                  <span className="text-neutral-400">
                    {invite.bound ? 'bound to one address' : 'anyone with the link'}
                  </span>
                  <span className="text-neutral-500">
                    created {new Date(invite.createdAt).toLocaleString()} - expires{' '}
                    {new Date(invite.expiresAt).toLocaleString()}
                  </span>
                  {isRevocable(status) && (
                    <Button
                      size="sm"
                      variant="secondary"
                      className="ml-auto"
                      onClick={() => void revokeInvite(invite.id)}
                    >
                      Revoke
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {invites !== null && invites.length === 0 && (
          <p className="mt-3 text-xs text-neutral-500">No invitations yet.</p>
        )}
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
