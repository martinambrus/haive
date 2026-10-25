# Session recovery

The API's refresh token is single use. Its guarded transaction revokes the old row and inserts
one successor; a concurrent loser returns 401 without cookies. Keep that compare-and-swap and
revocation contract. Making a redeemed token reusable hides a lost-cookie bug by weakening
rotation.

The app layout only reads `/auth/me`. A Server Component cannot forward replacement cookies to
the browser, so it must never call `/auth/refresh`. A failed read renders `SessionRecovery`,
withholding the authenticated shell. The browser rechecks `/auth/me` with its current cookie jar,
then POSTs `/auth/refresh` when needed. The browser installs HttpOnly replacement cookies before
reloading its current URL. That server render reads the role, forced-password flag, sidebar
preferences and modules using the same authenticated cookie header. There is no return-path
parameter or internal authentication header.

`recoverBrowserSession` coordinates the recovery shell, API retry and keepalive with one Web Lock
per app origin. Hold it through the refresh response, since a winner may have committed in
Postgres while its cookies are still in flight. A second tab checks the jar after acquiring the
lock. The keepalive requests rotation even when access still works; recovery first checks access
so that a stale SSR refusal does not cause another rotation. Same-tab API callers also share their
existing promise. Explicit logout remains the API operation that clears cookies.

A refresh refusal is followed by a fresh `/auth/me` read. Only two refused tokens under the lock
produce a rejected-session verdict. Network errors, API 5xx and timeouts produce an unavailable
verdict and a retry screen. Without Web Locks (for example plain HTTP on a non-localhost host), a
refusal stays on that retry screen because another tab's response might still be in flight;
successful recovery still works. Requests and lock acquisition have time bounds. The recovery
shell records an automatic reload in sessionStorage and refuses a second one within 30 seconds,
so an inconsistent upstream cannot cause a reload loop; manual retry remains available. If
sessionStorage is unavailable it also offers retry instead of an automatic reload.

`/login?session=expired` permits the login form despite cookie presence. It never deletes cookies:
the navigation may be a delayed result from an old request after another tab has recovered. The
proxy otherwise preserves public-page, private-page and CSP routing. Role and forced-password
guards continue to read the API's authenticated data and API middleware enforces authorization.

## Isolated regression harness

The fixture server mounts the real auth routes, signing and authentication middleware over a
scratch PostgreSQL database, with synthetic secrets and authenticated sidebar response fixtures.
It never starts workers, providers or the developer stack. The fixture refuses any database host
except `127.0.0.1:46537` with a database named `auth_hardening_test*`, and refuses Redis hosts other
than `127.0.0.1:46437`. Prepare those isolated stores externally and create a scratch database;
never point these tests at a developer database. The Redis fixture must use noeviction.

From the branch root, using the scratch database URL in `$SESSION_RECOVERY_DATABASE_URL` and
Redis database 1 in `$SESSION_RECOVERY_REDIS_URL`:

```bash
mkdir -p /tmp/haive-session-recovery
export TMPDIR=/tmp/haive-session-recovery
DATABASE_URL="$SESSION_RECOVERY_DATABASE_URL" pnpm --filter @haive/database migrate
pnpm --filter @haive/api exec tsx test/session-recovery-server.ts
```

In another terminal start the branch web server:

```bash
TMPDIR=/tmp/haive-session-recovery API_URL_INTERNAL=http://127.0.0.1:46101 \
  HAIVE_API_PORT=46101 pnpm --filter @haive/web exec next dev --hostname 127.0.0.1 -p 46100
```

Then run the opt-in Playwright config (no dev-stack lifecycle or global setup):

```bash
TMPDIR=/tmp/haive-session-recovery pnpm exec playwright test \
  -c tests/e2e/harness/session-recovery/session-recovery.config.ts
```

Use `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to select an already installed Chromium if needed;
`SESSION_RECOVERY_RESULTS` changes the default `/tmp/haive-session-recovery-results` artifact path.
Set `SESSION_RECOVERY_AUTH_CHECKS=1` together with `PLAYWRIGHT_API_BASE` and
`PLAYWRIGHT_DATABASE_URL` pointing at the same isolated API and database to include the existing
auth endpoint Playwright checks. The harness lives under `harness/`, which the normal Chromium
project excludes. The isolated server's `/__fixture/*` controls exist only in this test entry point. They create
synthetic users, inject 503 responses and hold a real `/auth/me` response for ordering controls.
They must never be mounted in the production application.
