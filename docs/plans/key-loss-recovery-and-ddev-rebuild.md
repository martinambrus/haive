# Rebuild DDEV  and key-loss account recovery

> Status 2026-11-13: A in review (#1132); B1 shipped (#1131); B2 in progress; B3, B4 planned.

## Context

- **DDEV rebuild.** Since #1128 a failed DDEV warm start keeps the runner and its database; the error tells the user to remove the container by hand, and the failed-task reaper (180 min) is the only other rebuild. The owner decided: add an in-app "Rebuild DDEV" action that confirms the loss.
- **Key-loss recovery.** After `HAIVE_DISCARD_UNREADABLE_SECRETS=1`, every user row stays, but the email ciphertext (config key) and the blind-index pepper are gone, so no one can sign in and first-run setup stays closed. Measured besides: any orphaned row makes `GET /admin/users`, `/admin/audit`, `/auth/me`, the login reply, maintenance and user-settings return 500 (decrypt throws, no catch). Haive has no outbound mail and no forgot-password flow. The owner decided (2026-11-13):
  - a host recovery script restores one admin;
  - orphaned rows get their passwords cleared;
  - a new SMTP mail feature and a forgot-password flow let a typed email that equals exactly one orphaned row's `git_email` claim that row by a link mailed to it;
  - the admin relinks the remaining rows.

Each part runs as Codex driver, Sonnet review, then a PR with the bots and CI, one PR per part.

## A. Rebuild DDEV , one PR

Precedent: `POST /tasks/:id/open-mailpit` (`api/src/routes/tasks/browser-access.ts:111`, `requireOwnedTask`, runtime-ensure job with its own jobId), worker `queues/runtime-ensure-queue.ts`.

- **Shared.** `RUNTIME_ENSURE_JOB_NAMES.REBUILD_DDEV` and its payload `{taskId, userId}` (`shared/src/constants/index.ts` ~:263-300).
- **API.** Add `POST /tasks/:id/ddev/rebuild` in `browser-access.ts`.
  - Check ownership with `requireOwnedTask`. The global `isForeignOrigin` check already covers the origin.
  - Answer 409 while a step of the task is running or a CLI invocation is live. Decide from the structural columns, never message copy.
  - Enqueue with jobId `ddev-rebuild-<taskId>`, so concurrent clicks merge, and answer 202.
- **Worker handler, in order:**
  1. Join the task's `ddevBoots` entry so a rebuild never interleaves with `ensureDdevStarted` (`ddev-runner.ts` :2155).
  2. Refuse while the runner is busy (`whileRunnerBusy` / `runner-activity.ts`).
  3. Check presence with `requireRunnerPresence`. An unknown answer throws `RunnerProbeError` and removes nothing.
  4. Check this install's ownership label and the workspace label. A foreign runner is refused.
  5. Run `docker rm -f -v`, then record a task event naming the user.
  6. Enqueue the normal runtime ENSURE job. The existing cold boot takes admission and restores the newest durability snapshot, or comes up with an empty database when none exists.
  7. If the runner is already absent, skip the removal and ensure only.
- **Web.**
  - A danger item "Rebuild DDEV" in the task's action menu. It shows when the task has a DDEV runtime and no step is running; the driver finds the structural field.
  - The confirmation uses the shared `Dialog`, which closes on Escape. Its text: the runner is removed, the database comes back from the last snapshot if one exists, every change since is lost, and a failed step stays failed, so Retry it afterwards.
- **Copy and docs.**
  - The #1128 warm-start error points at the action instead of a hand removal.
  - Update `docs/architecture/ddev-runtime.md` :72-82 ("until an explicit rebuild action exists").
- **Tests.**
  - API: 404 for another user's task, 409 while busy, 202.
  - Worker:
    - a busy runner is not removed;
    - an unknown probe removes nothing;
    - a foreign install is refused;
    - an absent runner is ensured only;
    - an owned runner is removed, then ensured.
  - Web: the dialog states the loss, and Escape cancels.
- **Rollback:** revert. No schema change.

## B. Key-loss recovery , four PRs in order

**B1. No 500s, plus a recovery script** (first: it gives a way back on its own)
- **Safe decrypt.** A `tryDecryptEmail` (`shared/src/crypto/index.ts`) returns `null` on a failed GCM tag. Use it at every user-email or phone decrypt site: `admin.ts:104,247`, `auth.ts:324,421`, `maintenance.ts:280,290`, `user-settings.ts:219-220`. An unreadable row shows as "unreadable, needs relink" with an `emailReadable: false` flag, never a 500.
- **Orphan test.** A row is orphaned when its email does not decrypt under the current key. No key id exists in the ciphertext.
- **`recover-admin` CLI** in `packages/updater/src/`. It gets DB, Redis and the key exactly as `cli.ts` :171-175 and :274-277 do. A `./haive recover-admin --email <addr> [--user-id <id>]` subcommand runs it (`install/install.sh` :826-863, like `upgrade`).
  - It picks the admin by id, or the only admin when there is one.
  - It re-encrypts the email, recomputes the blind index, and sets a random temporary password that it prints once.
  - It sets `mustChangePassword` and bumps `tokenVersion`.
  - It refuses an email that a readable row already holds.
  - Per the owner, every orphaned row's password becomes a bcrypt hash of 32 random bytes, with `mustChangePassword` set and `tokenVersion` bumped.
  - Idempotent: a re-run reissues the temporary password and changes nothing else.
  - The dev-stack invocation is documented.
- **Docs.** Close the "Known gap" in `docs/architecture/error-diagnostics.md` :100-114.
- **Rollback:** revert. No schema change.

**B2. SMTP mail**
- **New config keys** `config:mail:{enabled,smtpHost,smtpPort,secure,user,from,fromName}` and the system secret `mail_smtp_password` (SecretsService). These are new names: the retired `config:email:*` keys and `smtp_password` stay retired (`config.service.ts` :942-950, `secrets.service.ts` :37).
- **Admin API.** `GET/PUT /admin/mail` (the password is write-only: blank keeps it) and `POST /admin/mail/test`. Admin page: a mail card (global config needs its admin card).
- **Sending.** An api `lib/mailer.ts` on nodemailer, a new dependency, so the dev stack needs a full `pnpm docker rebuild`. The api sends after it has answered, so the raw reset link never sits in Redis.
- **Network.** The SMTP host is admin-set; the driver checks whether the #1029 private-endpoint egress guard applies and records the answer.
- **Dev.** Defaults point at the compose Mailpit (`mailpit:1025`) in the dev override only.
- **Rollback:** revert. Unused keys are harmless.

**B3. Forgot-password, generic plus the key-loss claim**
- **Migration** `NNNN_password_resets.sql`: `password_resets(id, user_id, claim_email_encrypted null, token_hash, expires_at, consumed_at, created_at)`. Guarded and idempotent. The Drizzle table is declared to match. Precedent: `user_invites` (`schema/auth.ts` :138-158, `lib/invites.ts`).
- **`POST /auth/forgot-password {email}`**: public, so add it to `PUBLIC` with its reason. Login throttling applies. It always answers the same 202 and sends only when mail is enabled.
  - A blind-index match on a readable row links that user.
  - Otherwise, only after a `config.discard_unreadable_secrets` audit row exists: if exactly one orphaned row's `git_email` equals the typed email (trimmed, case-insensitive), the link goes to the typed address, bound to that row and to the typed email.
  - Zero or several matches send nothing; those rows go to the admin relink.
  - The link expires in 30 min.
- **`POST /auth/reset-password {token, newPassword}`**: public. It consumes the token atomically on `consumed_at IS NULL`.
  - For a claim, it re-encrypts the claimed email and recomputes the blind index, and refuses if that index is taken.
  - It sets the password, clears `mustChangePassword`, bumps `tokenVersion`, revokes refresh tokens, and audits.
- **Web.** `/forgot-password` and `/reset-password?token=` as public routes (`lib/route-access.ts`). A "Forgot password?" link on the login page when mail is enabled.

**B4. Admin relink**
- An orphaned row in the admin users list (name, git name and email, role, created) gets a "Relink" action. The admin enters the email.
- That re-encrypts the email and recomputes the index, with 409 if taken. It randomizes the password, sets `mustChangePassword`, and mails a reset link.
- When mail is off, the one-time link is shown to the admin, like invites.
- **Rollback:** revert. The `password_resets` table stays harmless, or a later migration drops it.

## Order

A and B1 run in parallel: their code is disjoint. Then B2, B3, B4 in order.

## Verification

- Controls are red first on the base for every behaviour above. Run the touched packages' tests and typecheck, then one full run at the end of each feature.
- Live checks on the dev stack, owned resources only:
  - **A:** rebuild an owned DDEV task in the browser; the runner is recreated and the snapshot restored; a click while busy gets 409.
  - **B1:** an orphaned row exercised against a scratch database, never the dev users; the script restores login.
  - **B2:** a test send reaches Mailpit.
  - **B3:** request a reset, receive it in Mailpit, reset, and sign in; also the git_email claim on a scratch install.
  - **B4:** relink in the admin UI.
