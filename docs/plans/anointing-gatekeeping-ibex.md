# First-admin onboarding + registration gating

> Status: PROPOSED, 2026-08-25. Companion to `frictionless-bootstrapping-otter` (the one-line
> installer), which HANDS OFF to this flow but does not define it. This plan is the app-level
> user/registration/admin model and is valuable independently of the installer — even a manual
> `docker compose up` needs it.

## What exists today (verified against the tree, not assumed)

- `POST /auth/register` (`packages/api/src/routes/auth.ts:37`) is **open** — no auth, no gate. It
  inserts a user with NO explicit role, so the schema default applies:
  `role: 'user'`, `status: 'active'` (`packages/database/src/schema/auth.ts:36-37`). It auto-issues
  tokens (register = login).
- The web exposes it: `packages/web/src/app/(auth)/register/page.tsx`.
- There is **no first-user-becomes-admin logic anywhere** — no seed, no empty-users branch.
- Admin user MANAGEMENT exists and is complete: `GET /admin/users`, `POST /admin/users/:id/action`
  (activate / deactivate / role change) with self-guards and audit events
  (`packages/api/src/routes/admin.ts:71,184`). But every one of those routes is behind
  `requireAdmin`.

## The two problems

1. **Chicken-and-egg: no first admin.** A fresh install has zero users. You register → you are a
   `'user'` → you cannot reach any `/admin` route → the only way to get the first admin is a manual
   `UPDATE users SET role='admin'` in Postgres. That is the exact "no way in" trap a self-hosted
   product must not ship. (It is also literally how this dev install's admin was made.)
2. **Open registration is a security hole.** On any instance reachable beyond localhost, anyone can
   self-register today. For a single-tenant / small-team self-hosted product that is wrong by
   default; registration must be controllable.

Both are closed by the same small subsystem.

## Design

### A. First-run bootstrap — the first account is the admin

Make `register` first-run-aware rather than adding a parallel `/setup` endpoint (fewer moving
parts, one code path):

- On `register`, inside the same transaction that checks for a duplicate email, also read
  `count(users)`. If it is **zero**, this registration creates an **admin** (`role: 'admin'`) and
  is the ONLY registration that may do so. If it is non-zero, the request is subject to the
  registration mode in B.
- Do the count and the insert in one transaction with the appropriate isolation (or a
  `INSERT ... WHERE NOT EXISTS (SELECT 1 FROM users)` guard) so two simultaneous first-registers
  cannot both become admin. Exactly one admin is anointed.

**Decision — race protection (the one real choice):** first-user-becomes-admin has a known risk —
if the instance is exposed to the network before the operator registers, an attacker can register
first and own the instance. Two postures, and the plan supports both:

- **Local-first (default, recommended):** Haive is local-first (the installer opens `localhost`
  before any exposure — see the installer plan). First-user-becomes-admin with no token is fine and
  is the simplest UX: open the app, register, you are the admin. This is the GitLab/Sonarr pattern.
- **Hardened (installer-supplied, recommended when exposed):** the api, on first boot with empty
  users, writes a one-time `setup_token` (random, to a file the operator can read / the installer
  injects). When a `SETUP_TOKEN` is configured, the first-register MUST present it; without it, the
  first-register is refused. This closes the race on an exposed instance. The installer generates
  and supplies the token; the manual path can read it from the api log or a file.

**DECIDED 2026-08-25:** ship the local-first path as the mechanism and the setup-token as an OPT-IN
(`SETUP_TOKEN` set → enforced; unset → first-user-becomes-admin). One code path, one env toggle,
no separate wizard endpoint.

### B. Registration mode — close the open-signup hole

- `CONFIG_KEYS.REGISTRATION_MODE`: `'open' | 'invite' | 'closed'`. Needs the standard admin
  GET/PUT + toggle card (the global-config UI rule). Enforced in `register`:
  - `closed` → 403 (the default once an admin exists).
  - `invite` → the request must carry a valid, unconsumed invite token (C).
  - `open` → anyone may register as a `'user'`; the admin card states plainly this exposes
    self-signup.
- **Default value:** `'closed'`. This is the secure default for a self-hosted product. The
  first-run branch in A is exempt from the mode (it is what creates the admin who can then open it),
  so a fresh install still works with the default. State the one behavior change for EXISTING
  installs that relied on open signup: after this ships they must set the mode to `'open'` — a
  deliberate, logged admin action, which is the correct direction for a security default.

### C. Invites — how additional users join without opening registration

- New `user_invites` table (own numbered migration): `id`, `emailBlindIndex` (optional — an invite
  may be email-bound or a generic link), `tokenHash`, `role` (`'user'|'admin'`, default `'user'`),
  `createdBy`, `expiresAt`, `consumedAt`, `consumedByUserId`. Token hashed at rest exactly like
  `refresh_tokens.tokenHash` — the raw token is shown once to the admin and never stored.
- `POST /admin/invites` (requireAdmin, audited) creates one and returns the raw token/link once.
  `GET /admin/invites` lists outstanding, `DELETE` revokes.
- `register` accepts an optional `inviteToken`. In `invite` mode it is required: validate (exists,
  unexpired, unconsumed, email matches if bound), assign the invited `role`, and consume it in the
  same transaction as the user insert (so a token cannot be redeemed twice).
- This reuses the existing admin user-management for everything after join (activate/deactivate/
  role-change already exist).

### D. Setup detection + web wiring

- Cheap public `GET /auth/registration-status` returning `{ setupNeeded: boolean, mode }` —
  `setupNeeded` is `count(users) === 0`. No auth (a fresh install has no one to authenticate), and
  it leaks nothing an attacker could not learn by hitting `/register`.
- Web: when `setupNeeded`, the `(auth)` routes redirect to a `/setup` view — the SAME
  `auth-form.tsx`, relabelled "Create the admin account", posting to `register` (which the first-run
  branch turns into an admin). Optionally a second step to add the first CLI provider, reusing the
  existing provider forms. Once a user exists, `/setup` redirects to `/login` and the register page
  honors `mode` (hidden/closed unless `open`/valid invite).

## Migration / rollback (write the undo first)

- Additive: `user_invites` table (idempotent numbered migration), `CONFIG_KEYS.REGISTRATION_MODE`
  (+ admin card), the first-run branch in `register`, the `registration-status` route.
- Rollback: `git revert` restores open registration; drop `user_invites`; remove the config key. The
  first-admin promotion is a conditional in one route, not a data migration, so reverting is clean.
- No existing data is rewritten. Existing installs keep their users; only NEW registrations are
  gated, and only once the admin sets a non-`open` mode (default `closed`).

## Verification

1. Fresh DB (0 users): `/` redirects to `/setup`; the first registration creates an **admin**;
   `registration-status.setupNeeded` flips to false; a second attempt to first-register is refused
   (exactly one admin).
2. With `SETUP_TOKEN` set: first-register WITHOUT the token is refused; WITH it, succeeds as admin.
3. `mode = 'closed'` (default post-setup): a stranger's `register` is 403. An admin-created invite
   lets them in, once, with the invited role; the same token reused is refused.
4. `mode = 'open'`: self-signup works and lands as `'user'`; the admin card warns it is exposed.
5. Concurrent first-registers: exactly one becomes admin (the transactional guard holds).
6. Existing install (users present) is unaffected until an admin changes the mode; every admin
   action stays audited.

## Cross-reference

`frictionless-bootstrapping-otter` (installer) consumes this: its "first-run setup" hand-off IS the
flow above. The installer's job is to generate the `SETUP_TOKEN` (hardened path) or open `localhost`
before exposure (local-first path), and to open the browser at `/setup`. Keep the two plans in sync;
this one owns the auth/user model, the installer owns getting the stack running to the point this
flow can start.

---

# Amendment — 2026-08-25: a real user-management tab, manual add, and invite UX

*The sections above give the auth MODEL and the invite DATA/API. They do not give the admin a place
to USE any of it. Verified against the tree: user management today is a `users.map` list with four
per-user actions (deactivate / activate / reset_password / set_role) buried inline in the
2000-line `admin/page.tsx` (~line 2174), plus a summary "Users" card. There is `GET /admin/users`
and `POST /admin/users/:id/action`, but NO create-user endpoint, and nothing for invites. So an
admin cannot add a user manually and cannot send an invite — the `user_invites` table from section C
would be dead without this.*

## E. Dedicated user-management tab (move it out of the mega-page)

The admin tab pattern already exists as sub-routes: `admin/audit/page.tsx`, `admin/pricing/page.tsx`.
User management should be the same, not a section of the settings monolith.

- New `packages/web/src/app/(app)/admin/users/page.tsx`, linked next to the existing `admin/audit`
  and `admin/pricing` links. It OWNS the full user list — the `users.map` block and the four
  existing actions migrate here VERBATIM (they already work; this is a move, not a rewrite). The
  "Users" summary card on the main admin page stays as a KPI and links to the tab.
- The tab has three regions: the user list (existing actions), a "Add user" action (F), and an
  "Invites" panel (G). Load shape mirrors `admin/pricing` (fetch on mount, act, refetch).

## F. Manual add-user (the missing endpoint)

Admins need to create a user directly, not only send an invite — the common case of "make an account
for this teammate now."

- New `POST /admin/users` (requireAdmin, audited `user.create`): body `{ email, role }`. It creates
  the user and, reusing the EXISTING temp-password mechanism (the `reset_password` action already
  returns a one-time `temporaryPassword`), returns a temporary password shown once, which the user
  changes on first login. No admin-chosen passwords — same one-time-secret discipline as
  `reset_password`, so there is one place that mints and displays a temp credential.
- Duplicate-email is the same 409 the register path throws (shared blind-index check). Role defaults
  to `'user'`; creating an admin is allowed and audited.
- UX: an "Add user" form in the tab (email + role select), rendering the returned temp password in
  the same one-time reveal component the existing `reset_password` action already uses.

## G. Invite UX (surface the section-C API)

Section C defines `user_invites` and `POST/GET/DELETE /admin/invites`; this is the UI that makes it
usable.

- An "Invites" panel in the user tab: create (email optional + role + expiry) returns the one-time
  link/token shown once; list outstanding (email, role, expiry, created-by); revoke. Same one-time
  reveal component as F and reset_password.
- The panel states which registration mode is active (from B): in `closed`/`invite` mode invites are
  the way in; in `open` mode it notes that self-signup is also on.

## Ordering

E is a refactor-move (low risk, do first — it gives F and G a home). F and G are additive endpoints
plus forms in the new tab. All three are behind `requireAdmin` and audited, and none touches the
first-run/bootstrap path (A) — an admin already exists by the time this tab is reachable.

## Verification additions

1. The `admin/users` tab renders the full list with the four existing actions working unchanged
   (the move preserved behavior); the main-page summary card links to it.
2. `POST /admin/users` creates a user, returns a one-time temp password, rejects a duplicate email
   with 409, and audits `user.create`; the new user logs in with the temp password and is forced to
   change it.
3. An admin creates an invite, the token appears once, a stranger redeems it (once) and lands with
   the invited role; revoke makes a pending token unusable; every action is audited.
