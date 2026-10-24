# API sign-in hardening

**A user who must change their password is refused by the api, not only by the web.**
`users.must_change_password` is set where a password the holder did not choose is minted
(`POST /admin/users`, `reset_password`) and cleared by exactly one writer, `PUT /user-settings/password`.
While it is set `requireAuth` (`middleware/auth.ts`) answers 403 `must_change_password` on every route
it guards, an administrator included. `requireAuthAllowingPasswordChange` guards exactly two routes,
`GET /auth/me` (the app layout reads the flag there) and `PUT /user-settings/password`; login, register,
logout and refresh never had a session check. The six WebSocket handshakes (`authenticateUpgrade` in
terminal, terminal-shell, cli-stream, cli-login-banner, browser-vnc and ide) verify the token
themselves, so each selects the flag too and answers 401 for a flagged user. Two tests keep this
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
`UPDATE users SET must_change_password = false WHERE id = ...`.

**Sign-in and registration are rate limited.** `lib/auth-throttle.ts` admits an attempt on
`POST /auth/login` and `POST /auth/register` only while an account bucket (the email's blind index) holds
fewer than `AUTH_ACCOUNT_LIMIT` (10) and an address bucket fewer than `AUTH_IP_LIMIT` (30) attempts in the
last `AUTH_THROTTLE_WINDOW_MS` (60 s); login and registration have separate budgets. The buckets are
sorted sets, `haive:auth-throttle:<login|register>:acct|ip:<key>`, and one Lua script checks every
bucket and reserves a member in all of them or in none, so parallel attempts cannot all pass before any
is recorded. A refused attempt adds nothing, so the only lockout is the window sliding past; it answers
429 with `Retry-After` and `{error, code: 'rate_limited', retryAfterSeconds}` (the web form shows `error`
verbatim, and a browser cannot read `Retry-After` cross-origin, so the wait is in the sentence), and has
touched neither the database nor bcrypt. A success removes its own member: only failures cost budget, because the e2e suite
registers about 22 users a minute from one address and a count-all budget would have flaked it. The
throttle runs after the body is validated and before any bcrypt or database work. If Redis is not ready,
rejects, or does not answer within 400 ms the attempt is admitted and one warning is logged: the shared
client queues commands forever while Redis is down, and a login that waits on that is worse than an
unthrottled one. A reservation that still lands after the bound is released when it does, so a stall does
not leave slots that no refund frees, and the wait in `Retry-After` is capped at the window. The address is the TCP peer (`getConnInfo`), an IPv4-mapped peer (dotted or hex, any spelling) read as IPv4 and an IPv6
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

Accepted limits. Someone who knows an email can keep its bucket full for as long as they keep sending, and the
owner then gets 429 even with the right password; behind the default bridge there is no address to tell the
senders apart, so the account bucket is the only brake there. The window is measured by the api's clock, one api
instance per install. The limits are the constants above; the unused `RATE_LIMIT_*` config keys were removed.

**A caller who is not an administrator cannot aim the probe routes at a blocked address.**
`POST /tooling/test-postgres`, `/tooling/test-ollama`, `/tooling/ollama-model-capabilities`, the
`/tooling/pull-ollama-model` stream and `POST /global-kb/test-ollama` connect to an address the caller
types and report what came back. `egressFor(role)` (`lib/probe-egress.ts`) gives an administrator the
plain global `fetch` and plain postgres.js, and everyone else a guarded pair built on the egress guard's
own rules (`isBlockedAddress`, `dnsResolver`, `guardedLookup`, nothing in `egress-guard.ts` changed). The
guarded fetch is `http(s).request` with the guard's lookup, so the address that is checked is the
address that is connected; an IP literal is classified before connecting (a public one is allowed); a
redirect is returned and never followed; and every connect-level failure is the `TypeError('fetch
failed')` a missing name gives, a blocked answer included (`getaddrinfo ENOTFOUND <host>` for the
pg driver), so a name that resolves to a private address reads like one that does not exist and the
response never carries a resolved address. postgres.js has no lookup option, so it gets a `socket`
factory that refuses unix paths, several hosts and blocked literals and otherwise connects through the
same lookup. `probeOllama` and `ollamaEmbed` in shared take an optional `fetchFn`; the worker keeps the
default. `POST /global-kb/test-db` was already `requireAdmin`.

What a non-admin keeps: a target whose HOST (the parsed hostname, never a prefix) equals one of the install's
own known hosts is allowed although it resolves private. `probeEgressFor(c)` (`lib/probe-hosts.ts`) builds
that set per request for a non-admin and hands it to `egressFor(role, hosts)`: the in-stack Ollama names
(`IN_STACK_OLLAMA_HOSTS`: `ollama` and its container name), the host of the configured Global KB Ollama URL
(so `host.docker.internal` is exempt only when that is what is configured, and not otherwise). A project's
`<name>.ddev.site` is NOT exempt: it resolves to 127.0.0.1 in public DNS, so from the api container it
reaches the api's own loopback and never a DDEV Postgres. The exemption lifts only the address classification: the
name must still resolve (through the system resolver, so a `host-gateway` name in `/etc/hosts` works; every
other host resolves through c-ares, which never reads that file), and the guarded fetch still never follows a redirect, so an exempt host cannot
hand the request on to one that is not listed. An IP literal that is not itself listed, any other private
name, and everything for a multi-host Postgres string stay refused. Anything that cannot be read adds no host. The probe sends
no credential and reports only what the guarded fetch reports.

Targets that are a STORED setting are not
covered, deliberately: `POST /global-kb/release-embed-model`, the RAG store and embedder URL read by rag
search and `PATCH /repositories/:id/tooling`, and the forge calls in integration-mcp. Private stores and
forges are legitimate there (`integrations.md`, the closed embedder-settings decision, the pin in
`global-kb-config-gate.test.ts`), and the worker uses the same stored values unguarded. A new route that
connects to an address from the request body should take `egressFor(c.get('userRole'))` and add a case
to `probe-targets.test.ts`.

The IDE proxy's credential rule is in [Sandbox](sandbox.md).
