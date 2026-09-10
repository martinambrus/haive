import { createHash, randomBytes } from 'node:crypto';
import { expect, type APIRequestContext } from '@playwright/test';
import type postgres from 'postgres';

/**
 * Minting a user for a spec, through the product's real registration gate.
 *
 * `REGISTRATION_MODE` defaults to `closed` and only the very first account on an install is
 * exempt, so a plain `POST /auth/register` answers 403 on every install that already has a user.
 * An invite is the way in — `decideRegistration` admits its holder even while registration is
 * closed, deliberately, so that `closed` is a usable default rather than a wall.
 *
 * The invite is seeded straight into the table rather than created through the admin API: the
 * decision under test in almost every spec is not "can an admin issue an invite", and going
 * through the API would couple every setup to the admin session. A generic invite needs no pepper
 * and no blind index either — `checkInvite` treats a null `email_blind_index` as a link that
 * matches anyone.
 */

export const API_BASE = process.env.PLAYWRIGHT_API_BASE ?? 'http://localhost:3001';

export const PASSWORD = 'e2e-password-12345';

/** Unique per call, so parallel workers never collide on the users table's blind index. */
export function uniqueEmail(prefix: string): string {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${stamp}-${rand}@haive-e2e.test`;
}

/** Same shape the api stores: the raw token exists only in the request that redeems it. */
function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface RegisteredUser {
  userId: string;
  email: string;
}

/**
 * Register a user and leave `request` carrying its session cookies.
 *
 * `role: 'admin'` mints an administrator, because the register route applies the invite's own role
 * rather than the mode's default — which is the only way a spec can reach the admin-only pages.
 */
export async function registerUser(
  sql: postgres.Sql,
  request: APIRequestContext,
  opts: { prefix: string; role?: 'admin' | 'user' },
): Promise<RegisteredUser> {
  const email = uniqueEmail(opts.prefix);
  const token = randomBytes(32).toString('base64url');

  // id and created_at default; email_blind_index stays null so the link is not bound to one
  // address. An hour is far longer than any run and short enough to be self-cleaning if a
  // teardown is ever missed.
  const inserted = await sql<{ id: string }[]>`
    insert into user_invites (token_hash, role, expires_at)
    values (
      ${hashInviteToken(token)},
      ${opts.role ?? 'user'},
      ${new Date(Date.now() + 60 * 60 * 1000)}
    )
    returning id
  `;
  const inviteId = inserted[0]!.id;

  const res = await request.post(`${API_BASE}/auth/register`, {
    data: { email, password: PASSWORD, inviteToken: token },
  });
  if (res.status() !== 201) {
    // The invite is still unconsumed, and nothing else will ever reclaim it.
    await sql`delete from user_invites where id = ${inviteId}`;
    expect(res.status(), `register for ${email} failed: ${await res.text()}`).toBe(201);
  }

  const body = (await res.json()) as { user: { id: string } };
  return { userId: body.user.id, email };
}

/** Log an existing account in on `request`, for specs that test the login path itself. */
export async function loginUser(
  request: APIRequestContext,
  email: string,
  password = PASSWORD,
): Promise<string> {
  const res = await request.post(`${API_BASE}/auth/login`, { data: { email, password } });
  expect(res.status(), `login for ${email} failed: ${await res.text()}`).toBe(200);
  const body = (await res.json()) as { user: { id: string } };
  return body.user.id;
}
