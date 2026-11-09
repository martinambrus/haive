# API sign-in hardening

**A user who must change their password is refused by the api, not only by the web.**
`users.must_change_password` is set where a password the holder did not choose is minted
(`POST /admin/users`, `reset_password`) and cleared by exactly one writer, `PUT /user-settings/password`.
While it is set `requireAuth` (`middleware/auth.ts`) answers 403 `must_change_password` on every route
it guards, an administrator included. `requireAuthAllowingPasswordChange` guards exactly two routes,
`GET /auth/me` (the app layout reads the flag there) and `PUT /user-settings/password`; login, register,
logout and refresh never had a session check. The six WebSocket handshakes (terminal, terminal-shell,
cli-stream, cli-login-banner, browser-vnc and ide) share one authenticator, `authenticateUpgrade`
(`lib/upgrade-auth.ts`), which selects the flag too and answers 401 for a flagged user, and one
refusal, `rejectUpgrade`; a test fails a handler that keeps a copy of either. Two tests keep this
structural rather than remembered: `session-flag-drift.test.ts` fails when a file calls
`verifyAccessToken(` without reading the flag (`maintenance.ts` is the one listed exception: it reads
the role only to let administrators through a maintenance 503), and `flagged-session-routes.test.ts`
requests every registered route with a flagged session, the twin of `anonymous-routes.test.ts`.
`PUT /user-settings/password` is registered ABOVE the router-level `use('*', requireAuth)` in
`routes/user-settings.ts` on purpose: Hono answers a route registered before a wildcard `use()`
without running it (MEASURED against 4.13). A flagged user cannot "change" to the same password (400
`password_unchanged`), or the minted secret would stay in place and the flag would be cleared by a
no-op; an ordinary user still can, and it still signs their other devices out. The redirect in
the web (`ForcedPasswordGuard`) is now the UX and the api is the boundary, so the account page treats
the 403 as the expected state and shows only its Password card. Nothing in the app clears the flag for
someone else; an administrator who set it by mistake runs
`UPDATE users SET must_change_password = false WHERE id = ...`. While the flag is set the `(app)`
layout does not start the shell's recurring requests, since the api refuses every one of them: it
mounts no `NotificationProvider` or `GlobalPauseBanner`, `SidebarNav` leaves out its active-task list,
and `MaintenanceNotice` stops watching (`useMaintenanceState(watch)`). The layout's own flag is
current for the whole session, because the flag is set only for a new account or by a password reset,
and a reset bumps `token_version`, which ends the session first. The account page's `router.refresh()`
after the change re-renders the layout, so the polls start again without a reload. A new recurring
request in the shell is gated on the same flag, not by catching the 403.
`tests/e2e/auth/forced-password.spec.ts` covers the flow, and `login-throttle.spec.ts` the sign-in
throttle's 429.

**A revoked session closes its open sockets.** A handshake registers its socket under the user as soon
as the token verifies, before the user row is read (`trackUserUpgrade`, `lib/user-sockets.ts`), so a
revocation that lands during the auth, ownership or runtime waits fences that upgrade too. A write that
deactivates a user or moves `token_version` calls `closeUserSockets(userId)` after its commit: today
`deactivate` and `reset_password` (`routes/admin.ts`, with the selected row's id, since the URL may
spell the uuid in upper case) and `PUT /user-settings/password`. Any new writer of `users.status` or
`token_version` must do the same. Activation and role changes end no session and close nothing. An open
WebSocket closes with 1008, a pending upgrade is answered 401, the IDE relay gets a raw close frame, and
a peer that never acknowledges is destroyed after one second; the browser panel stops reconnecting
on that code. The registry is a Map in the api process, which assumes the single api process compose
pins, as the terminal and IDE refcounts already do. Every upgrade socket gets an error listener first thing
(`guardUpgradeSocket`, `lib/upgrade-errors.ts`) and every accepted WebSocket gets one: a client reset
during the handshake, or a malformed frame, was an uncaught error that exited the api. Sockets are still
authorized at the handshake only: logout, token expiry and an out-of-band database edit leave open
sockets open.

**Sessions change by compare-and-set, and an answer does not tell which accounts exist.** A refresh redeems
its token with one `UPDATE refresh_tokens SET revoked_at = ... WHERE id = ... AND revoked_at IS NULL RETURNING`
inside the transaction that inserts the successor, so of two redemptions of one cookie exactly one wins; the
loser answers exactly as a revoked token does (same status, body and headers, no cookie). `PUT
/user-settings/password` writes with `WHERE token_version = <the value read>` and answers a lost race with 409
`password_change_conflict`; only the committed winner closes the user's sockets. The admin `deactivate` and
`reset_password` actions bump `token_version` atomically in the UPDATE (`token_version + 1`), so no concurrent
bump is reused or undone. Tokens are signed before those transactions open, since signing may read the JWT
secret from the database. Login spends one bcrypt comparison on every validated attempt, against a constant
dummy hash of the same cost (`SALT_ROUNDS`) when the account is unknown, and a missing, deactivated or
wrong-password account gets the same 401; register refuses by registration mode before it looks for the email,
so a closed or invite-only install answers every email alike, while an open one keeps its 409 for a taken email.
Two administrators creating one email at once get 201 and 409, as the pre-check answers, not a 500. HTTP and the
WebSocket handshakes read the session cookie with the same parser. Two sweeps keep authorization structural:
`flagged-session-routes.test.ts` requests every admin route of the real app (`createApiApp` plus
`installModules`) with a signed-in non-admin and requires 403 with no handler reached, and a ratchet fails a
role check in api source outside its allowlist, so an admin route gated some other way cannot escape the sweep.

**Sign-in and registration are rate limited.** `lib/auth-throttle.ts` admits an attempt on
`POST /auth/login` and `POST /auth/register` only while an account bucket (the email's blind index) holds
fewer than `AUTH_ACCOUNT_LIMIT` (10) and an address bucket fewer than `AUTH_IP_LIMIT` (30) attempts in the
last `AUTH_THROTTLE_WINDOW_MS` (60 s); login and registration have separate budgets. The buckets are
sorted sets, `haive:auth-throttle:<login|register>:acct|ip:<key>`, and one Lua script checks every
bucket and reserves a member in all of them or in none, so parallel attempts cannot all pass before any
is recorded. A refused attempt adds nothing, so the only lockout is the window sliding past; it answers
429 with `Retry-After` and `{error, code: 'rate_limited', retryAfterSeconds}` (the web form shows `error`
verbatim, and a browser cannot read `Retry-After` cross-origin, so the wait is in the sentence), and has
run no bcrypt; its only database work is the audit row below, written after the answer. A success removes its own member: only failures cost budget, because the e2e suite
registers about 22 users a minute from one address and a count-all budget would have flaked it. The
throttle runs after the body is validated and before any bcrypt or database work. If Redis is not ready,
rejects, or does not answer within 400 ms the attempt is admitted and one warning is logged: a login that
waits on a stalled Redis is worse than an unthrottled one. A reservation that still lands after the bound is
released when it does, and so is one the shared client rejected at its own 2 s command deadline, since that
script may still run: the release is queued behind it on the same connection either way. A stall therefore
does not leave slots that no refund frees, and the wait in `Retry-After` is capped at the window. The address is the TCP peer (`getConnInfo`), an IPv4-mapped peer (dotted or hex, any spelling) read as IPv4 and an IPv6
peer bucketed by its /64; with no address (a unit test, a dead socket) only the account bucket applies.
`X-Forwarded-For` is never read unless the peer is inside `HAIVE_TRUSTED_PROXIES` (comma separated IPs or
CIDRs, empty by default, passed through `docker-compose.yml`); then the right-most hop that is not itself
trusted is the client, and an unparsable chain falls back to the peer. The api port is published on all
interfaces, so a header from anyone else must not be believed.

**A private peer has no address bucket.** Under Docker's default network every browser reaches the api as the
bridge gateway (MEASURED: `::ffff:172.20.0.1` for a WSL client), so one address bucket there was one shared
budget and thirty bad attempts a minute made every sign-in answer 429, a correct admin login included. When the
address is the peer itself and the egress guard's classifier (`isBlockedAddress`, the same one the probe routes
use: RFC 1918, loopback, link-local, unique-local and the other special ranges) calls it private, the address
bucket is neither counted nor enforced and only the account bucket applies. An address a trusted proxy supplied
through `X-Forwarded-For` is counted even when it is private, because the operator configured that proxy and
the address is then a real client. A public peer keeps the bucket.

**Sign-ins, registrations and password changes leave audit rows.** A successful sign-in writes
`auth.login.success` in the transaction that stores its refresh token, and a failed one
`auth.login.failure` (`reason: 'invalid_credentials'`, the account as target when the email matched) before
the 401, so a row the database refuses answers 500, never a session or a 401 without its row. Registration
(`user.register`: `role`, `invited`, `firstRun`) and a password change (`user.password.change`, `forced` for
the must-change flow) write theirs in the change's own transaction, so a refused row undoes the account or the
new hash. A throttled sign-in writes `auth.login.throttled` with `limiter: 'account' | 'address'`, the limiter
whose bucket refused it, and names the account only when the account limiter refused. It is written at most
once per refused bucket per window (a `SET NX` key `<bucket>:audit` that expires with the window) and never
makes the 429 wait: the lookup and the insert run after the answer, and a failure is logged (`failed to audit
throttled sign-in`), not raised, because a stalled database must not slow a refusal. A refused registration
writes no row.

Accepted limits. Someone who knows an email can keep its bucket full for as long as they keep sending, and the
owner then gets 429 even with the right password; behind the default bridge there is no address to tell the
senders apart, so the account bucket is the only brake there. The window is measured by the api's clock, one api
instance per install. The limits are the constants above; the unused `RATE_LIMIT_*` config keys were removed.

**A caller who is not an administrator cannot aim the probe routes at a blocked address.**
`POST /tooling/test-postgres`, `/tooling/test-ollama`, `/tooling/ollama-model-capabilities`, the
`/tooling/pull-ollama-model` stream and `POST /global-kb/test-ollama` connect to an address the caller
types and report what came back. `egressFor(role, allowHosts?)` (`lib/probe-egress.ts`) gives an
administrator the plain global `fetch` and plain postgres.js, and everyone else the guarded pair from
`@haive/shared/egress` (node-only subpath, not in the root barrel and not web-reachable): `egress-guard.ts`
(`isBlockedAddress`, `dnsResolver`, `guardedLookup`), `probe-egress.ts` (`createGuardedFetch`,
`createGuardedPgSocket`) and `allowlist.ts`. The guarded fetch is `http(s).request` with the guard's lookup,
so the address that is checked is the address that is connected; an IP literal is classified before
connecting (a public one is allowed); a redirect is returned and never followed; and every connect-level
failure is the `TypeError('fetch failed')` a missing name gives, a blocked answer included (`getaddrinfo
ENOTFOUND <host>` for the pg driver), so a name that resolves to a private address reads like one that does
not exist and the response never carries a resolved address. The server log carries one `egress guard
refused a private or unresolvable target` warn with the host, at most one per host per 60 s (the key is
lower-cased and cut to 253 characters, at most 256 hosts tracked with the oldest evicted, a backwards clock
warns again); the response never does. postgres.js has no lookup option, so it gets a `socket` factory that
refuses unix paths, several hosts and blocked literals and otherwise connects through the same lookup. The
Ollama helpers in `rag/embed.ts` take an optional `fetchFn` and default to a guarded fetch that exempts the
built-in hosts, so the worker's dials are guarded too. `POST /global-kb/test-db` was already `requireAdmin`.

**The private-endpoint allowlist.** An administrator lists the private, loopback or link-local endpoints the
install may dial: `config:security:privateEndpointAllowlist`, `GET`/`PUT /admin/config/private-endpoint-allowlist`
(an audit row `config.private_endpoint_allowlist` per change), a card on the admin data tab. The key has no
stored default: it does not exist until an administrator saves it or the upgrade seed runs, and a missing key
reads as an empty list. Entries are separated by newlines or commas: an IPv4 or IPv6 address, a CIDR range
(/1-32, /1-128) or a hostname (lower-cased; no wildcard, port, scheme or path); at most 256 entries and 16 KiB.
`PUT` answers 400 naming the offending entry; the read path skips an invalid one. An address or CIDR entry is
matched against the RESOLVED address at connect time (an IPv4 rule also matches the IPv4-mapped form), so a
name that later resolves elsewhere is judged by where it connects. A hostname entry matches the dialed
hostname exactly and trusts every address that name resolves to EXCEPT link-local (169.254.0.0/16, fe80::/10),
unspecified (0.0.0.0/8, `::`) and cloud metadata addresses (100.100.100.200 Alibaba ECS, 192.0.0.192 Oracle
Compute Classic, 168.63.129.16 the Azure host, fd00:ec2::254 EC2 over IPv6), each IPv4 one also in its IPv4-mapped, NAT64, 6to4, SIIT and
IPv4-compatible (`::a9fe:a9fe`) forms. Only an address or CIDR entry can allow those
(`isUnliftableByHostname`). `::1` is the IPv6 loopback and not the compatible form of 0.0.0.1, so like
127.0.0.1 it stays liftable. Only address entries are rebinding-proof. The DNS
servers are asked first; the system resolver (hosts file) only when DNS fails and a hostname entry names the
host, so a name defined only in `/etc/hosts` needs a hostname entry. One resolution per dial; an answer that
mixes allowed and refused addresses is refused whole; a redirect is never followed. The list is read lazily,
at most once per dial, through the cached `configService.get` (a change applies within about 30 s), and only
when the dial needs it: a blocked address literal, a blocked resolved address, or a name that did not
resolve. A public-only answer and a built-in host never read it, so public forge and embed dials keep working
while the config store is down. With a cold cache and the store down, a dial that needs the list rejects with
`ConfigUnavailableError` (`error-diagnostics.md`); any other read failure (an uninitialised store included)
counts as an empty list with a warn. The card says a hostname entry cannot lift link-local, unspecified or
cloud metadata addresses, that a refusal reads as host-not-found, and that a hosts-file-only name needs a hostname entry.

**Upgrade seed.** `seedPrivateEndpointAllowlist` (`packages/worker/src/private-endpoint-seed.ts`) is a
convergent `DATA_MIGRATIONS` entry that runs while the key was never written; an empty value counts as
written, so a cleared list is never re-seeded and a fresh install stays empty. It lists the private targets
the install already stores: the Global KB Ollama URL; per repository the external or ddev RAG connection
string and the Ollama URL (the committed tooling mirror, else the newest onboarding task's
`04-tooling-infrastructure` output); the host and API base of each forge credential. A name is listed only if
it resolves (DNS first, the system resolver for a name that exists only in `/etc/hosts`) into 10/8, 172.16/12,
192.168/16, 100.64/10 or fc00::/7. Public names, built-in hosts, loopback, link-local, unspecified and
100.100.100.200 / 192.0.0.192 / fd00:ec2::254 are never listed, so a stored loopback target stays refused until an
administrator lists it. An address literal becomes an address entry, a name a hostname entry. Lookups take
5 s each, 8 at once, 20 s overall; the entry and byte caps apply. The write is one transaction under the admin
save's advisory lock (`admin-config:private-endpoint-allowlist`): an audit row
`config.private_endpoint_allowlist` by the nil-UUID system actor with metadata `{from, to, seeded: true}`, then
`SET NX`; a lost race rolls the row back. An empty plan writes an empty value and no audit row. A throw writes
nothing and the next boot retries. A name that did not resolve at the one boot that seeds is skipped, not
retried. The api's 30 s cache delays the effect there. Undo: clear the list in the card (never re-seeded), or
`DEL` the key to have the next worker boot seed once more.

What a non-admin keeps: the built-in hosts, the only targets a request-typed probe may reach while they
resolve private. They are the in-stack Ollama names (`IN_STACK_OLLAMA_HOSTS`: `ollama` and its container
name; host only, fetch and pg socket) and the exact origin `http://host.docker.internal:11434`
(`BUILT_IN_PRIVATE_ORIGINS`, `packages/shared/src/constants/index.ts`, the shipped
`DEFAULT_EXTERNAL_OLLAMA_URL`), matched by scheme, host and port and for fetch only (not pg, forge or custom
tools). `probeEgressFor(c)` (`lib/probe-hosts.ts`) passes both static sets and reads no config.
`host.docker.internal` on any other port or scheme, the `ddev` and `external` RAG database strings, any other
compose name and every forge host are NOT built in and need an allowlist entry (the seed lists those an
install already stores). Stores Haive derives from `DATABASE_URL` (internal RAG, Global KB, module stores),
Redis, Mailpit, the ddev runner, VNC and the IDE are never guarded. A project's `<name>.ddev.site` is NOT
exempt: it resolves to 127.0.0.1 in public DNS, so from the api container it reaches the api's own loopback
and never a DDEV Postgres. The exemption lifts only the address classification: the name must still resolve,
and the guarded fetch still never follows a redirect, so an exempt host cannot hand the request on to one
that is not listed. An IP literal that is not itself listed, any other private name, and everything for a
multi-host Postgres string stay refused unless the allowlist lists them. The probe sends no credential and
reports only what the guarded fetch reports.

Stored targets are guarded for every caller, an administrator included, because the value may have been
written by someone else (the Global KB Ollama URL and embed model are admin-only since `putConfig`
refuses a non-admin's change, but a value saved before that is still trusted nowhere):
`POST /global-kb/release-embed-model`, the RAG store and embedder URL read by rag search and
`PATCH /repositories/:id/tooling`, the forge calls in integration-mcp, and the worker's counterparts. The
guard sits at the lowest layer: the embed helpers default to the guarded fetch, `resolveRagConnection` dials
an `external` or `ddev` store through the guarded socket unless `trustedTarget: true` is passed (operator
scripts that dial a target typed on their command line pass that or `fetchFn: fetch`), and a forge request
goes through `ForgeContext.fetchFn` (`integrations.md`). An install that already stores private targets keeps
them across the upgrade through the seed. Not guarded, by decision: the Global KB's admin-only external
connection string and `POST /global-kb/test-db`, and an administrator's request-typed probe (so an admin Test
can succeed where the runtime still refuses until the target is listed). A new route that connects to an
address from the request body should take `egressFor(c.get('userRole'))` and add a case to
`probe-targets.test.ts`.

The IDE proxy's credential rule is in [Sandbox](sandbox.md).
