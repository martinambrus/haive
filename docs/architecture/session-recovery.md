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

`withBrowserSessionLock` coordinates every browser session cookie writer: recovery, API 401
retry, keepalive, login, registration, logout and own-password change. They use one Web Lock per
app origin. Fetch construction and cookie selection happen inside that lock, and it is held
through response headers: a refresh may have committed while its replacement cookies are still
in flight. A later logout must present the installed successor, and a later login or password
change must install its own pair after that response. API retry releases the writer lock before
acquiring it again for refresh, avoiding lock reentry. Same-tab API refresh callers still share
one promise. Failed logout, including a lock-acquisition failure, stays on the current page and
shows an error; it must never report sign-out by navigating away without a successful response.

Lock acquisition expires after 20 seconds. Read-only `/auth/me` probes have five-second bounds,
but **an active refresh POST has no application cancellation deadline**. Aborting after its
single-use CAS commits can permanently discard the only successor cookies. Recovery changes its
message after five seconds while the request and lock remain active; eventual headers still
install cookies and finish recovery. A genuine network failure, lost response or destruction of
the lock-owning document remains a single-use protocol limit. No redeemed token is made reusable
to conceal it. A second tab checks the jar after acquiring the lock. Keepalive requests rotation
even when access still works; recovery first checks access so that a stale SSR refusal does not
cause another rotation.

A refresh refusal is followed by a fresh `/auth/me` read. Only two refused tokens under the lock
produce a rejected-session verdict. Network errors, API 5xx and timeouts produce an unavailable
verdict and a retry screen. Without Web Locks (for example plain HTTP on a non-localhost host), a
refusal stays on that retry screen because another tab's response might still be in flight;
successful recovery still works. A local queue still serializes writers within that document,
and an expired queued writer never starts later; cross-tab ordering requires Web Locks. The recovery
shell records an automatic reload in sessionStorage and refuses a second one within 30 seconds,
so an inconsistent upstream cannot cause a reload loop; manual retry remains available. If
sessionStorage is unavailable it also offers retry instead of an automatic reload.

`/login?session=expired` permits the login form despite cookie presence. It never deletes cookies:
the navigation may be a delayed result from an old request after another tab has recovered. The
proxy checks `/auth/me` read-only before redirecting an unmarked public page to the dashboard.
Cookie presence alone is insufficient: retaining invalid access cookies must still permit bare
`/setup`, `/register`, direct invitations and public navigation onward from the login form.
A valid authenticated session keeps its dashboard redirect. A failed or uncertain probe permits
the public page and never deletes cookies. Private-page and CSP routing remain unchanged. Role
and forced-password guards read the API's authenticated data and API middleware enforces
authorization.

The sign-in form (`AuthForm`: `/login`, `/register`, `/setup`) declares `method="post"`. A submit
before React attaches `handleSubmit` is the browser's own, and as a GET it put the email, password
and setup token in the URL, the history and the access logs, and dropped `?invite=`. MEASURED on
Next 16.4.3 (dev and standalone build): a urlencoded POST on those routes is answered with the page
itself (200), while a multipart one gets 409, so the form must never set `encType`. Its fields are
uncontrolled, and `handleSubmit` reads them with `new FormData(event.currentTarget)` before its
first `await`. React keeps text typed or autofilled before it attached, but a controlled input's
state stays empty and the next re-render resets the field to it: the form posted empty strings and
then emptied itself after a refusal (MEASURED with the script chunks held back). A click or Enter
before React attaches is still the native POST to the same page and drops what was typed; React's
own replay (a function `action`) would keep it but removes `method`, so it is not used. A form that
carries a secret and is rendered on the server declares `method="post"` too.

`NewRepoForm` (`/repos/new`) follows the same rule: its display name, branch and writable-copy box are
uncontrolled and read with `FormData` before the first `await` (MEASURED with the script chunks held
back: all of them were reset at the first re-render), and it declares `method="post"` because those
fields now have names (a urlencoded POST to `/repos/new` is answered with the page, a multipart one with
409, in dev and in the standalone build). The branch is also written through a ref, by the GitHub picker
(its default branch, into an empty untouched field) and by a Source switch. The Source select stays
controlled because it decides which sections render, so a Source chosen before attach is reset at the
first re-render. `/tasks/new` loses its typed title, description and estimate the same way; it has no
native submit before attach, because its submit button is `disabled` in the server HTML.

## Cookie transport boundary

The current session transport requires the browser-facing web and API URLs to use **the same
hostname**. Different ports on that hostname work: host-only cookies are shared across ports,
and credentialed CORS plus the existing request-origin gate allow the web to call its API. The
loopback harness tests exactly this contract (`127.0.0.1:46100` and `127.0.0.1:46101`).

An explicit API URL on a different hostname remains configurable, but host-only API cookies do
not reach the web hostname's proxy or server layout. A successful API login alone therefore
cannot establish that server-rendered web session; CORS cannot transfer those cookies. Different
sites add the existing SameSite=Lax restriction as well. This is a pre-existing deployment limit,
not fixed by browser recovery. No cookie Domain, SSO or proxy transport redesign is included here.

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
auth endpoint Playwright checks alongside the original recovery spec. That mode excludes the
zero-user ordering spec because the existing auth checks intentionally keep a bootstrap owner;
run the default ordering/recovery checks first on a fresh scratch database. The harness lives
under `harness/`, which the normal Chromium project excludes. The isolated server's `/__fixture/*` controls exist only in this test entry point. They create
synthetic users, select registration mode, inject 503 responses and hold a real `/auth/me`
response. The fixture also mounts the actual own-password route. Node-side interception can hold
committed refresh response headers without prematurely updating the browser cookie jar. The
ordering controls require a fresh scratch database so the setup case really has zero users;
run them before the optional existing auth checks, whose bootstrap owner intentionally remains.
They must never be mounted in the production application.
