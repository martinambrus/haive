# API sign-in hardening

**A user who must change their password is refused by the api, not only by the web.**
`users.must_change_password` is set where a password the holder did not choose is minted
(`POST /admin/users`, `reset_password`) and cleared by `PUT /user-settings/password` and by a completed password reset (`POST /auth/reset-password`, below).
While it is set `requireAuth` (`middleware/auth.ts`) answers 403 `must_change_password` on every route
it guards, an administrator included. `requireAuthAllowingPasswordChange` guards exactly two routes,
`GET /auth/me` (the app layout reads the flag there) and `PUT /user-settings/password`; login, register,
logout and refresh never had a session check. The five app WebSocket handshakes (terminal, terminal-shell,
cli-stream, cli-login-banner and browser-vnc) share one authenticator, `authenticateUpgrade`
(`lib/upgrade-auth.ts`), which reads the user through `requireSessionUser` (the policy `requireAuth`
uses, flag included) and answers 401 for a flagged user, and one refusal, `rejectUpgrade`. The
editor socket authenticates its own editor session instead (`authenticateEditorUpgrade`,
`lib/editor-auth.ts`), with the same user policy and revocation fence; see the editor section in
[Sandbox](sandbox.md). A test fails a handler that keeps a copy of either. A refusal about a
resource the user owns (a container that is not running, a finished task, a repository that is not
ready, a busy login) cannot be read by a browser as a refused upgrade's status, so once origin, auth
and ownership have passed the handler accepts and closes at once with a 4000-4999 code through the
one helper `closeRefused` (`lib/upgrade-auth.ts`): `CLI_LOGIN_CLOSE_CODES` (4409-4411) and
`TERMINAL_CLOSE_CODES` (4420-4424, `@haive/shared/constants`); the client keys its sentence on the
code. Origin, auth and ownership refusals stay HTTP and are sent before any accept, so a foreign page
or another user learns nothing. Two tests keep this
structural rather than remembered: `session-flag-drift.test.ts` fails when a file calls
`verifyAccessToken(` without reading the flag (`maintenance.ts` is the one listed exception: it reads
the role only to let administrators through a maintenance 503), and `flagged-session-routes.test.ts`
requests every registered route with a flagged session, the twin of `anonymous-routes.test.ts`.
`PUT /user-settings/password` is registered ABOVE the router-level `use('*', requireAuth)` in
`routes/user-settings.ts` on purpose: Hono answers a route registered before a wildcard `use()`
without running it (MEASURED against 4.13). A flagged user cannot "change" to the same password (400
`password_unchanged`), or the minted secret would stay in place and the flag would be cleared by a
no-op; an ordinary user still can, and it still signs their other devices out. Password-reset
redemption enforces the same forced-change refusal by comparing the proposed password to the
locked user's current hash after the guarded live-token claim. A refusal rolls the transaction
back, leaving the token unconsumed and the password, flag and sessions unchanged. The redirect in
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

**Sign-in, registration and password recovery are rate limited.** `lib/auth-throttle.ts` admits an attempt on
`POST /auth/login`, `POST /auth/register` and `POST /auth/forgot-password` only while an account bucket
(the email's blind index) holds
fewer than `AUTH_ACCOUNT_LIMIT` (10) and an address bucket fewer than `AUTH_IP_LIMIT` (30) attempts in the
last `AUTH_THROTTLE_WINDOW_MS` (60 s); `login`, `register` and `recover` have separate budgets.
`POST /auth/reset-password` reserves an account bucket keyed by the token's SHA-256 and, when
present, an address bucket in its own `reset` scope. A token's exhausted bucket affects only
that token, so knowing an email cannot spend its owner's reset-token budget. `PUT /user-settings/password`
checks the current password against the sign-in budget (scope `login`, keyed by the account's stored blind
index, same address rules), so the two password checks share one budget. It reads the user row to find that
index, then reserves before bcrypt, and refunds as soon as the current password verifies, even when the change
is then refused (`password_unchanged`, a conflict). A wrong current password answers 400
`current_password_incorrect`, not 401: the web client retries any other 401 once after a silent refresh, and a
retried wrong password would spend two attempts and write two rows. The buckets are
sorted sets, `haive:auth-throttle:<login|register|recover|reset>:acct|ip:<key>`, and one Lua script checks every
bucket and reserves a member in all of them or in none, so parallel attempts cannot all pass before any
is recorded. A refused attempt adds nothing, so the only lockout is the window sliding past; login,
registration and reset answer 429 with `Retry-After` and `{error, code: 'rate_limited', retryAfterSeconds}` (the web form shows `error`
verbatim, and a browser cannot read `Retry-After` cross-origin, so the wait is in the sentence), and have
run no bcrypt; their only database work is the audit row below, written after the answer (a refused password
change has also read its user row, for the key). A successful login or registration removes its own member;
recovery and reset attempts keep theirs. Only failures cost login and registration budget, because the e2e suite
registers about 22 users a minute from one address and a count-all budget would have flaked it. The
throttle runs after the body is validated and before any bcrypt or account lookup (the password change reads the
user row first, for the key). Reset-password reserves its token and available address buckets before an unlocked live-token lookup and
runs bcrypt only when that lookup finds an unconsumed, unexpired token. If Redis is not ready,
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

**Cross-host web-proxy mode.** When web and API hostnames differ, browsers reach the api through
web's `/api/haive` proxy, so web is the peer. Next route handlers forward supplied
`X-Forwarded-For` and expose no socket peer. Expose web only behind a front proxy that appends the
real client to `X-Forwarded-For`, block direct access to web, and list the web container and every
trusted intermediary hop in `HAIVE_TRUSTED_PROXIES`. Trusting web alone lets a direct caller pick
its address bucket; leaving web's private peer untrusted turns the address bucket off. The api logs one warning at boot
when the hostnames differ and `HAIVE_TRUSTED_PROXIES` is empty (`bootstrap.ts`): the web's outbound
address cannot be known at boot, so a non-empty list is taken as the operator having followed this rule.

**Sign-ins, registrations and password changes leave audit rows.** A successful sign-in writes
`auth.login.success` in the transaction that stores its refresh token, and a failed one
`auth.login.failure` (`reason: 'invalid_credentials'`, the account as target when the email matched) before
the 401, so a row the database refuses answers 500, never a session or a 401 without its row. Registration
(`user.register`: `role`, `invited`, `firstRun`) and a password change (`user.password.change`, `forced` for
the must-change flow) write theirs in the change's own transaction, so a refused row undoes the account or the
new hash. A wrong current password writes `user.password.change.failure` (`reason: 'invalid_credentials'`)
before its 400, so a refused row answers 500, and a throttled password change writes
`user.password.change.throttled` (actor and target the signed-in user, no lookup) after its 429,
best-effort, at most once per refused bucket per window; it shares the sign-in's `<bucket>:audit` key, so one row
per refused bucket per window covers both. A throttled sign-in writes `auth.login.throttled` with `limiter: 'account' | 'address'`, the limiter
whose bucket refused it, and names the account only when the account limiter refused. It is written at most
once per refused bucket per window (a `SET NX` key `<bucket>:audit` that expires with the window) and never
makes the 429 wait: the lookup and the insert run after the answer, and a failure is logged (`failed to audit
throttled sign-in`), not raised, because a stalled database must not slow a refusal. A refused registration
writes no row. A throttled recovery request writes `auth.password_reset.throttled` after the same 202,
with the same limiter metadata and account-target rule, at most once per refused bucket per window.
Its `recover` bucket and audit slot are separate from sign-in and password change, so recovery cannot
spend their admission budget or suppress their throttled audit row.

Accepted limits. Someone who knows an email can keep its bucket full for as long as they keep sending, and the
owner then gets 429 even with the right password; behind the default bridge there is no address to tell the
senders apart, so the account bucket is the only brake there. Anyone holding a valid access cookie can also spend the
account's sign-in budget through the password change, and its 429 says "sign-in attempts" because the budget
is the sign-in one. Anyone who knows an email can also fill its separate `recover` bucket, silently
dropping the owner's recovery request while still answering the same 202. The window is measured by
the api's clock, one api instance per install. The limits are the constants above; the unused `RATE_LIMIT_*` config keys were removed.

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
`POST /global-kb/test-ollama` takes a typed address from an administrator only: anyone else's call reads the
stored settings and ignores the body, so it dials only what an administrator saved, still through the guard. It
stays open to them because the settings page and the status panel run it on load, where `requireAdmin` would 403.

**Who may make Ollama pull a model.** An administrator may make the in-stack daemon pull any model. Anyone else may make it pull only the effective Global KB embedding model or the onboarding embedding default (`DEFAULT_EMBED_MODEL`), each from the default registry only, or an entry of the administrators' allowlist (`config:security:ollamaModelAllowlist`, admin `GET`/`PUT /admin/config/ollama-model-allowlist`, audited as `config.ollama_model_allowlist`, at most 256 exact names). A model named in the caller's own provider grants nothing, since the caller writes that provider. One policy (`@haive/shared`) is applied at every place a pull or create starts:

- `/tooling/pull-ollama-model`, whatever `ollamaUrl` the caller names, refuses with 403 before the stream opens.
- An in-stack Ollama provider's create, duplicate and PATCH refuse with the same 403 (`code: 'ollama_model_not_allowed'`) before anything is written. A PATCH is checked only when it changes the model, the Modelfile `FROM` base, or moves the endpoint into the stack, so a provider saved earlier can still be renamed, disabled or deleted.
- For a Modelfile provider the `FROM` base is what gets pulled; its own model name is a `/api/create` target and is not checked.
- The worker re-reads the owner's current role and applies the policy just before it would pull or create, at provisioning and at the boot re-pull. A model that is already resident stays `ready`. A disallowed one is skipped with a warn and settles `idle` with no error, and boot goes on.

Names compare as Ollama resolves them: registry `registry.ollama.ai`, namespace `library` and tag `latest` by default, case-insensitive, distinct tags distinct. A digest or a URL is refused.

For a non-administrator, the embedding defaults grant pull permission only on the exact default
registry `registry.ollama.ai`, with no port. An omitted host uses that default. An explicit
foreign host, IP literal, `localhost`, port, trailing host dot, or differently cased spelling of
`registry.ollama.ai` needs explicit administrator approval. The Global KB embedding-model setting
and a provider's own model or Modelfile cannot grant that approval.
The admin model allowlist is an intentional exception: a valid full reference such as
`models.example:5000/library/embed:latest` approves that exact model and registry for non-admin pulls.
Registry spelling (case included) and port must match the allowlist entry exactly; the remaining
name parts keep their case-insensitive comparison and default tag. A default-registry allowlist
entry cannot approve a foreign registry or a differently spelled default host. Administrators
retain unrestricted registry access.

The check lives in the shared `isOllamaModelAllowed` policy, so the tooling pull stream,
provider create/PATCH/duplicate and the worker's provision/boot paths use the same decision,
including a Modelfile's `FROM` base. Refusals remain JSON 403 `ollama_model_not_allowed` before
streaming, writing a provider or queuing its provisioning. The worker skips a refused pull.
Ollama's [name parser](https://github.com/ollama/ollama/blob/main/types/model/name.go) splits names
from the right: three parts supply a registry, while two parts normally supply namespace/model.
The permission check also conservatively treats a first segment containing `.` or `:`, or equal
to `localhost` ignoring case, as a registry; it never reinterprets an invalid name as an allowed
model. Empty path components and trailing slashes remain invalid.

External Ollama provider endpoints are not gated: they pull on someone else's daemon. The tooling
pull route applies its model policy regardless of the typed endpoint. Sandboxed agents reach only
the inference/read-only [Ollama gate](sandbox.md#in-stack-model-access) on the models network; the
daemon is not attached there.

**What an administrator types is dialled unguarded, by decision.** The guard protects the install from users who
are not administrators; an administrator already controls the install, so the dials only an administrator can
aim stay on the plain transport: the Global KB external connection string (only an administrator can change it,
`putConfig` in `routes/global-kb.ts`, and `resolveExternal` in `global-kb/connection.ts` opens plain
postgres.js), `POST /global-kb/test-db` (`requireAdmin`), and module sources, which the admin-only module routes
clone with a named admin-trusted owner (the git remote rule below). A new dial that someone other than an
administrator can aim takes the guarded pair; a new administrator-only dial may stay plain and says so where it
is defined.

**A provider's Test connection follows the same rule in the worker.** `POST /cli-providers/:id/test` only queues
a PROBE job, and for an OpenRouter or Ollama provider the worker then sends one request to the provider's base
URL and shows the answer's text. The job carries no role, so `resolveProbeFetch` (`worker/src/cli-adapters/probe-fetch.ts`)
reads the owner's `users.role` at probe time: `admin` gets the plain `fetch`, and any other value, a missing row
included, gets `guardedProbeFetch` (`egress/probe-fetch.ts`, the allow set `rag/embed.ts` uses). Only a hand-set
`ANTHROPIC_BASE_URL` is guarded, read from the same merged env the run resolves it from: a URL Haive picked itself
(the OpenRouter compatibility proxy, the Ollama thinking proxy, the in-stack daemon, ollama.com) was typed by no
one, and the two proxies are private sidecars outside the allow set, so guarding them would end the check for
every non-administrator. A refused Ollama probe answers `ok: true` with a `warning` that names the guard rather
than a failure, because a run dials from inside the sandbox under its own network policy and may well reach what
this probe may not. The warning is keyed on the transport `cause.code` `ENOTFOUND` and also covers a name that
does not resolve: telling the two apart would say which names resolve privately. An OpenRouter probe stays
silent on any transport failure, as it does for every inconclusive outcome.
The Z.AI usage poll dials the origin of the same hand-set URL with the provider's token, so it takes its
transport from the same `resolveProbeFetch` (`UsageFetchContext.fetchImpl`); a refusal is a plain `error` row,
never an auth strike or a backoff. The Ollama and OpenRouter probes and the Z.AI poll read at most 64 KiB of a
reply (`readBounded`, `readForgeJson` from `@haive/shared/forge`, which cancel the stream past the cap) and
treat a longer one as no answer: the bare HTTP status, an inconclusive compatibility check, a failed poll.

**A git remote follows the same owner rule.** Any signed-in user can add a repository or a bundle with a git URL,
or repoint a repository's origin (`POST /repos/:id/remote`), and the worker's child `git` then dials it and the
clone or step error reaches the user. Every git network operation goes through one of two chokepoints, `gitClone`
(`repo/clone.ts`) and `originGitRun` (`repo/git-push.ts`), and both take a required owner. `gitRemoteGuardArgs`
(`repo/git-remote-guard.ts`) reads the owner's `users.role` per call: `admin` gets git unchanged, and any other
value, a missing row included, has every fetch and push URL of the origin (insteadOf applied) resolved by
`resolveGuardedAddress` (`egress/probe-egress.ts`: the probe's resolver, blocked ranges, private-endpoint
allowlist and unliftable addresses) before git starts. A blocked answer is refused with git's own "Could not
resolve host" text, which a name that does not exist also gets on this path, so the two read alike. The checked
answer is pinned so git cannot resolve again: http(s) gets `http.curloptResolve` with every checked address
(none for an IP literal, which is the checked address, and whose bracketed IPv6 form libcurl 8.5 refuses),
`http.followRedirects=false` and `http.proxy=`. A URL-scoped entry in the repository's own config
(`http.<url>.*`, or `remote.<name>.proxy`) outranks a generic `-c`, and git matches it against every spelling of
the stored URL (userinfo, query, fragment), so pinning per URL was tried and kept missing one: `originGitRun`
instead reads the checkout's effective config once (includes and worktree config) and refuses a guarded run that
has any such key, or a generic `http.curloptResolve` (resolve entries add up, and an IP literal gets no pin to
outvote one), with a message that names the setting to remove. An imported repository never has one (the
import strips `http.*`); an external checkout may. Git reads `.git/config` itself after the check, and the
owner can rewrite it meanwhile (`POST /repos/:id/remote`, or the repo-scope Terminal, which keeps a writable
`.git`), so after resolving `originGitRun` runs the scan and then reads the URLs again as its last steps before
spawning, and refuses any difference. That shrinks a window the remote's own DNS could stretch to seconds down to
the few process starts before git's own read; closing it needs git to run where a private address is unreachable,
which this does not do. `-c remote.origin.url=` is no lever: git 2.54 resets the list with it, 2.43 appends an empty
URL (MEASURED). Any ambient `GIT_CONFIG_*` is dropped for that run; ssh gets `core.sshCommand` with
`-o HostName=<address> -o HostKeyAlias=<host>`, and `GIT_SSH`/`GIT_SSH_COMMAND` are dropped for that run. The
worker image has no ssh client, so that pin is tested on its argv only. A redirecting remote therefore fails for
a non-administrator, and a private Git server needs an allowlist entry. Module sources are admin-only routes and
pass a named admin-trusted owner. `isAllowedGitRemoteUrl` (`schemas/git-url.ts`) also refuses a URL whose raw
authority holds a backslash, a control or whitespace character, or a host that differs from what `new URL`
parses, because curl dials the raw text: `http://public.example\@10.0.0.5/` reads as `public.example` to
WHATWG and connects to 10.0.0.5. That rule applies to every caller, administrators included, and also refuses
IDN and percent-encoded hosts (write the punycode form).

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
IPv4-compatible (`::a9fe:a9fe`) forms, and the IPv6 tunnel ranges `64:ff9b:1::/48` (local NAT64) and `2001::/32`
(Teredo), held back whole because either can carry traffic to those addresses. Only an address or CIDR entry can allow those
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
counts as an empty list with a warn. The card says a hostname entry cannot lift link-local, unspecified,
cloud metadata or IPv6 tunnel addresses, that a refusal reads as host-not-found, and that a hosts-file-only name needs a hostname entry.

**Upgrade seed.** `seedPrivateEndpointAllowlist` (`packages/worker/src/private-endpoint-seed.ts`) is a
convergent `DATA_MIGRATIONS` entry that runs while the key was never written, or while its own retry state
(`bootstrap:privateEndpointSeed`: attempts, the list it wrote, the names still pending) says the list is still
the one it wrote; an empty value counts as written, so a cleared list is never re-seeded and a fresh install stays
empty. It lists the private targets
the install already stores: the Global KB Ollama URL; per repository the external or ddev RAG connection
string and the Ollama URL (the committed tooling mirror, else the newest onboarding task's
`04-tooling-infrastructure` output); the host and API base of each forge credential. A name is listed only if
it resolves (DNS first, the system resolver for a name that exists only in `/etc/hosts`) into 10/8, 172.16/12,
192.168/16, 100.64/10 or fc00::/7. Public names, built-in hosts, loopback, link-local, unspecified and
100.100.100.200 / 192.0.0.192 / fd00:ec2::254 are never listed, so a stored loopback target stays refused until an
administrator lists it. An address literal becomes an address entry, a name a hostname entry. Lookups take
5 s each, 8 at once, 20 s overall; the entry and byte caps apply. The write is one transaction under the admin
save's advisory lock (`PRIVATE_ENDPOINT_ALLOWLIST_LOCK_NAME` in `@haive/shared`, which the admin save uses for
this route): an audit row `config.private_endpoint_allowlist` by the nil-UUID system actor with metadata
`{from, to, seeded: true}`, then one Lua compare-and-set of the list and the retry state together; a lost race
rolls the row back and is logged as a skip. A throw writes nothing and the next boot retries.
A name that did not resolve stays pending: the names that did resolve are written at once, and each later seed
run looks up only the pending names and appends the ones that now resolve (an audit row per change). While
nothing resolved and a name is pending, the list key stays absent rather than empty. After 10 runs (a seed run,
not a distinct boot: a bootstrap retry or a crash loop counts too) the seed writes what it knows, `''` included,
warns, and stops. An administrator save of the list (any value, the same one included) deletes the retry state
in the same Lua call, so the seed never adds to a list an administrator decided. A malformed retry state fails the
seed run (the list stays as it is) until the state key is deleted. The api's 30 s cache delays the effect there.
Undo: clear the list in the card (never re-seeded), or `DEL` the key to have the next worker boot seed once more.

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

**CLI volume logins leave a row after the success signal.** Codex, Grok, Amp and
Antigravity record `cli_provider.login` with source `volume` before their post-login
probe. The CLI has already written the credential into its volume: a failed probe,
closed dialog or refused audit cannot undo it, so the row is deliberately best-effort.
Metadata never includes credentials, output, codes or environment values.
Claude-family captured tokens already record `cli_provider.secret.set` atomically
with encrypted-secret promotion; those keep their strict write.

**CLI sign-out requires its request row before enqueue.** The API commits
`cli_provider.sign_out` before adding the sign-out job, with no transaction open
during the enqueue; an audit refusal queues nothing, and a rejected or id-less
enqueue deletes that one row by id (a failed delete is logged). The pino line
follows a successful enqueue. The worker retains ownership of credential-volume and
Claude login-secret removal and adds no audit writer.

**CLI provider security edits require their own row.** Create records
`cli_provider.create` in its insert transaction, listing the security fields the
request sent. PATCH records `cli_provider.update` whenever `networkPolicy`,
`egressDomains`, `wrapperContent`, `wrapperPath`, `executablePath`, `cliArgs`,
`sandboxDockerfileExtra`, `rulesContent`, `modelfile`, `authMode`, `isolateAuth`
or `cliVersion` changes, or a non-secret environment entry changes; NULL and an
empty value count as equal. The current provider is read under its
`FOR NO KEY UPDATE` row lock, and the update and required audit commit together. Metadata lists changed fields and environment names
(including removals), never their values or wrapper/Dockerfile content.
Secret environment writes keep their existing strict `cli_provider.secret.set`
row in that same transaction. Both logs follow commit; unchanged settings
add no update row.

## Administrator SMTP mail

`GET`/`PUT /admin/mail` and `POST /admin/mail/test {to}` use the existing admin guard;
mutations also pass the app's origin check. The Mail card is on **Admin → Data & access**.
Settings live in ConfigService under `config:mail:{enabled,smtpHost,smtpPort,secure,user,from,fromName}`.
The password is encrypted by SecretsService as `mail_smtp_password`: reads return only
`passwordSet`, and a blank or absent password on a save keeps the stored value. The retired
`config:email:*` keys and `smtp_password` stay retired. Saves write `config.mail` audit rows
(with password-change and username-presence flags only); tests commit a required `mail.test`
attempt row before sending, and return `{ok: true}` or a typed `{ok: false, code, error}`.
No SMTP transcript, credential, or recipient goes into the response diagnostics or audit metadata.

`api/src/lib/mailer.ts` exports `sendMail({to, subject, text, html?})` for future recovery mail.
It rereads settings and the password on each call and creates a fresh Nodemailer transport.
Connection and greeting timeouts are each 10 seconds; socket inactivity is bounded at 30 seconds
(the limits are injectable for controls). `secure` selects TLS on connect, normally on port 465;
otherwise Nodemailer uses STARTTLS when offered. Certificate checks remain enabled. Disabled
mail returns `mail_disabled` without connecting. A configuration-store outage retains its
retryable API 503 instead of being mistaken for an incomplete setup. Internal SMTP relays are allowed: only
administrators can choose the endpoint, so the administrator-trusted outbound policy above applies.

Production seeds disabled mail and an empty host/from. The dev override seeds enabled SMTP at
`mailpit:1025`, no TLS on connect, from `haive@example.test`, through `HAIVE_MAIL_ENABLED`,
`HAIVE_MAIL_SMTP_HOST`, `HAIVE_MAIL_SMTP_PORT`, `HAIVE_MAIL_SECURE` and `HAIVE_MAIL_FROM` in both
API and worker environments. Optional `HAIVE_MAIL_USER` and `HAIVE_MAIL_FROM_NAME` complete the
seed fields. All seeds use SET NX: existing administrator choices win on restart. Mailpit itself
already lives in the base Compose file (`axllent/mailpit:latest`, persistent `mailpit_data`);
the dev override publishes only its web UI, on the host loopback (`127.0.0.1:8085`); SMTP stays
internal, reached as `mailpit:1025`. The Nodemailer dependency and lockfile change
require `pnpm docker rebuild` when this branch is deployed to a dev stack. Roll back by reverting
the mail commit; unused config keys are harmless.

## Password recovery

`GET /auth/forgot-password/available` reports whether SMTP mail is enabled; the login page shows
**Forgot password?** only then. `POST /auth/forgot-password {email}` uses separate `recover` account
and address throttle buckets and a separate once-per-window throttled audit slot, and
always answers the same 202, for unknown accounts, disabled mail, throttle refusals and delivery
failures alike. Lookup, issuance and SMTP delivery run in-process after the reply, so the raw link
never sits in Redis or a queue. Failure logs carry fixed codes, the error class and, when present, a short
five-character error code (a SQLSTATE, or an errno such as `EPIPE`), never the address, token or SMTP text.

A readable blind-index match gets a reset link at its stored address only while the user is active;
a deactivated match sends nothing. A claim is allowed only after a `config.discard_unreadable_secrets`
audit row exists, and only when exactly one active user whose email fails `tryDecryptEmail` has a
plaintext `git_email` equal to the typed one (trimmed,
case-insensitive). The typed address is stored encrypted on the reset row and the link goes to it.
Zero or several matches send nothing; those rows are relinked by an administrator.

Tokens are 32 random bytes; only their SHA-256 is stored in `password_resets`. A link expires after
30 minutes. Issuance, cooldown and both redemption expiry checks use the application clock.
Issuance serializes on the active user row; an unexpired, unconsumed link issued less than
`PASSWORD_RESET_COOLDOWN_MS` (2 minutes) ago makes a request issue and send nothing, preserving that
link and the same 202. After the cooldown a new link invalidates the user's earlier unconsumed links.
Issuance commits its required `auth.password_reset.request` audit row with the token.

`POST /auth/reset-password {token, newPassword}` applies the change-password policy. It reserves its
separate `reset` token bucket and any counted address bucket before any token lookup or bcrypt; a throttle refusal answers 429
without hashing. An unlocked SELECT by token hash refuses unknown, consumed or expired tokens with
the generic 400 before bcrypt. The transaction's guarded UPDATE remains the authority if that hint races.
One transaction requires an active user under its lock, consumes an unexpired, unconsumed token,
rechecks that a claim target's email still fails `tryDecryptEmail`, and repairs the email and blind index for a
claim, sets the password, clears `must_change_password`, bumps `token_version`, revokes refresh
tokens and writes `auth.password_reset.complete`. If another user holds the claimed index it answers
409 and rolls everything back, consumption included. The claim recheck and that holder check run before any
bcrypt work; the unique email index still decides a holder that appears after the check. Invalid, expired, superseded and consumed tokens
share one 400, as do a deactivated user and a claim whose target email is readable now; refusal rolls
back consumption and all changes. Both issuance and redemption lock the user `FOR NO KEY UPDATE`,
which permits refresh's FK key-share lock; redemption revokes refresh rows before a claim's unique
email-index update can upgrade the user lock. After commit the user's API sockets close and the browser's
auth cookies are cleared;
the web returns to login with a notice. Rollback: revert the feature; `password_resets` stays unused
or a later migration drops it. Passwords already reset are not undone by a revert.

## Admin relink

For accounts whose email is unreadable, an administrator uses **Relink** on the users page.
`POST /admin/users/:id/relink {email}` uses the admin and app-origin guards and refuses the calling
administrator with 400, as deactivate and role changes do. It normalizes the
address like sign-in and refuses a readable or deactivated account with a typed 409, an unknown
user with 404, and an address held by another account with 409 `relink_email_taken`, including a
unique-index race. Under a `FOR NO KEY UPDATE` user lock, one transaction repairs the email and
blind index, replaces the password with a bcrypt hash of 32 random bytes, sets
`must_change_password`, increments `token_version`, revokes refresh tokens and records the required
`user.relink` audit (administrator actor and target id, no address or password). Refresh tokens are
revoked before the unique email-index update, following password redemption's lock order.
The same transaction uses the shared reset issuance helper to supersede prior links and issue a
plain reset, bypassing the two-minute self-service cooldown so a recent claim cannot block the
administrator. Both required audit rows name that administrator as actor, and they commit together
with the reset; a failure undoes all writes.
After commit, the user's API sockets close and mail is sent to the new address with a reset link
at the configured web origin. Success returns `delivery: 'mailed'`; disabled mail returns
`delivery: 'manual'` and the link. Every delivery error, including a configuration outage, returns
`delivery: 'failed'` and the link for manual handoff. The dialog shows that link once with a copy
button. The reply uses `Cache-Control: no-store`, as does the one-time invite-token reply.
While the request is in flight the dialog cannot be closed, and once a link is shown only
Escape or Close dismisses it, since the relink has already committed and the link exists nowhere
else. A lost link cannot be re-requested through Relink, because the email is now readable: use
**Reset password** for a temporary password, or forgot-password when mail is enabled. Links and
tokens are never logged. Rollback: revert the feature; no schema change.
