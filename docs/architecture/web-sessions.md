# Web sessions

Refresh rotation belongs to the browser. `/auth/refresh` claims each refresh token with a
guarded transactional update, creates its replacement in that transaction, and returns the
new HttpOnly cookies. A Server Component cannot install those cookies in the browser. The
app layout therefore reads `/auth/me` but never redeems the browser's refresh token.

If that server read cannot authenticate, the layout renders `SessionRecovery` instead of
treating its request snapshot as proof that the current browser session is revoked. The
recovery component checks with the browser's current cookie jar, installs any replacement
cookies through browser fetch, then reloads the original URL. The refreshed server layout
reads the actual role, forced-password flag, sidebar preferences and module navigation.
There is no caller-supplied return URL.

`recoverBrowserSession` coordinates browser refresh callers, including API retries, keepalive
and recovery, with the origin-wide `haive:session-rotation` Web Lock. The lock covers response
headers as well as the database rotation: the winner can have committed while its Set-Cookie
is still in flight. On a refused refresh, recheck `/auth/me` using the current jar before
classifying the session as rejected. Ordinary network failures and non-401 responses are
unavailable, not proof of revocation. Without Web Locks, a refusal remains unavailable
because another tab's late success cannot be excluded.

`/login?session=expired` allows the login page to render without trusting cookie presence.
It does not delete shared session cookies: a stale server response or marker navigation
can arrive after a successful rotation. Actual sign-out continues to use the auth API.
The recovery screen offers retry and sign-in when the session cannot be checked; a
30-second sessionStorage stamp bounds automatic reloads when server and browser disagree.
Its explanatory prose uses the shared Markdown renderer.

The opt-in browser harness under `tests/e2e/harness/session-recovery/` exercises the real
Next app against isolated Hono auth routes, signed tokens and Postgres rotation. It covers
returning visitors, persisted replacement cookies, concurrent tabs, delayed server replies,
stale markers, outages and role/password guards. Its synthetic fixture is separate from
the live dev database and provider accounts; normal Chromium specs do not start it.
