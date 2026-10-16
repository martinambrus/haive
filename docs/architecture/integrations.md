# Integrations

An integration lets a task reach a vendor (a forge today; documents, mail, chat and the rest later)
with the task owner's own account, without the agent ever holding that account's token. The pieces:

- a **provider** (`IntegrationProviderSpec`, code) serves one or more **categories** and declares its
  auth methods and **operations**;
- a **connection** (`integration_connections`) is one account of a user at a provider;
- a **write switch** per user per provider decides whether write operations are offered at all;
- **resolution** picks, per task and category, which connection a step uses;
- the **stamp** on `cli_invocations.integrations` records what one agent run may use, the
  **`integrations` task token** names that run, and **`integration_calls`** logs every attempt.

What is live and what is not: providers, connections, sign-in, the write switch, the forge code,
resolution, the choice routes, the broker (`/integration-mcp`, see The broker) and the exec side of the
worker are merged: a run whose invocation row carries a stamp gets the `haive-integrations` MCP server
and its own `integrations` token (see The call log, the stamp and the token), and the dispatch side is
merged: a step whose catalog entry declares requirements is resolved, granted and stamped at dispatch
(see Dispatch). No shipped core step declares one; a module step can, and an admin's prompt step can
declare `integrations` (see [Task types](task-types.md)), so only those reach the broker. The task page
has no Integrations section yet.

## Providers and categories

The contract is web-safe and lives in `@haive/shared/modularity` (`integrations.ts`): id, display
name, `categories[]` (at least one, unique), `selfHosted`, `auth[]` (each kind at most once, because a
refresh finds its method by kind and a second `oauth2` entry would refresh through the first one's
token endpoint), an optional remote/stdio `mcp` surface, `operations[]` (`{opId, description,
inputSchema, access: read|write}`) and an optional `entitlementId`. A spec needs `mcp` or at least one
operation. An operation id must match `TOOL_NAME_PATTERN` (`^[a-z][a-z0-9_]{0,39}$`, `contracts.ts`),
the same grammar as a custom tool's name, so an operation can list under its own id (two declared
tools that share one are renamed; see Tool names).

Auth kinds: `oauth2` (authorize/token/optional revoke URLs, read and write scopes, PKCE always,
`clientRegistration`, optional `userInfo` = an https URL plus JSON pointers for the account id and
label, optional `authorizeParams` = extra authorize-URL parameters such as Google's
`access_type=offline`, each one printable line and never a name the sign-in sets itself:
`response_type`, `client_id`, `redirect_uri`, `scope`, `state`, `code_challenge[_method]`), `device` (device-code and token URLs, scopes, optional `userInfo`, without which it cannot
sign anyone in), `token` (a form and help text).

Ids: a core provider or category is `^[a-z0-9][a-z0-9_-]*$`, a module's is `module.<moduleId>.<id>`.
`isCategoryId` accepts a module-grammar id or a registered core id only; the choice routes are
stricter and accept only the core list (`listIntegrationCategories`). Core categories and their labels:
`rich-documents` Documents, `spreadsheets`, `file-storage` File storage, `mail` Email, `chat`,
`issues` Issue tracking, `wiki`, `forge` Git forge. Only `forge` has providers today.

The registered providers are the five forges, in this order: `github`, `gitea`, `gitlab`,
`bitbucket_cloud`, `bitbucket_server` (`CORE_FORGE_PROVIDER_SPECS`, `@haive/shared/forge`). Each
declares `forge`, a token method first, and two operations: `open_pull_request` (write) and
`get_pull_request_state` (read). GitHub alone adds `device` and `oauth2`; its read and write scopes are
both `repo`, so for GitHub the write switch narrows nothing at the vendor — the switch is enforced by
Haive, not by the scope. A forge provider's id IS its `ForgeProviderName`; code compares the two
directly. A forge token is never typed into the token method's form: it is entered as a Git
credential and turned into a connection with "Use as connection".

**Enablement** (`integrations/providers.ts`): an `integration_provider_configs` row wins; without one
a registered core provider is on and anything else is off. An admin's first save of a provider takes
the provider's current state for `enabled`, not the column's `false`, so saving only an OAuth client
id never switches a core provider off. Enablement gates integration features only — sign-in, link,
choices and resolution. The worker's PR open and PR poll never read it, and the repository form's
GitHub device sign-in skips it (`checkEnabled: false`), so that path can still create a connection
for a disabled GitHub provider, which resolution never selects: it answers `provider-disabled` when a
choice or grant names that account, or when no enabled provider's account serves the category.

Both `@haive/shared/integrations` (server-only, imports the database) and `@haive/shared/forge` stay
out of the root barrel. Web imports `@haive/shared/forge`, so nothing loaded by that subpath may import
a node-only module or the database.

## Accounts

`integration_connections` has a `scope` (`user` or `shared`) and a `status` (`connected`,
`needs_reauth`, `revoked`, `provider_unavailable`). Every writer inserts `user` rows today, and every
reader — the listing, disconnect, ownership checks and the resolver — filters `scope = 'user' AND
owner = caller`; shared connections are deferred to the module providers. Only the refresh writes
`needs_reauth`; `revoked` and `provider_unavailable` are declared and never written. The browser sees
`toConnectionSummary`, never a token column. UI keys on `status`; `last_error` is only the words,
following the message-column rule in AGENTS.md.

### A forge account is a Git credential

A forge connection holds no token. It points at its `repo_credentials` row (`repo_credential_id`,
`ON DELETE CASCADE`), because every clone and push already reads that table and folding it into
connections would have been a destructive migration. Consequences, all deliberate:

- `finishSignIn` refuses a forge token response that carries a refresh token or an expiry (400): the
  credential holds the only copy and nothing would refresh it, so GitHub Apps with expiring tokens are
  refused.
- Signing in again to the same account updates the connection and its credential's secret in place,
  under `pg_advisory_xact_lock(integration-account:<user>:<provider>:<externalId>)` and `FOR UPDATE`,
  keeping the credential's label, host and provider. A vendor that sends no new refresh token leaves the
  stored one in place when the sign-in used the row's own method and OAuth client (re-encrypted with the new access
  token; an unreadable one counts as none); under another method or client it is dropped, since a refresh would send
  it with that issuer's credentials. A first forge sign-in creates a credential
  labelled `<Provider> OAuth (<login>)` on the sign-in endpoint's host.
- "Use as connection" (`POST /integrations/providers/:id/link-credential`) turns an existing
  credential into a connection: forge only, provider enabled, own credential, the credential's forge
  must be this provider, one connection per credential (0202's unique key).
- Disconnecting a credential-backed connection removes only the pointer; the credential and every
  repository bound to it stay, and nothing is revoked.
- Deleting the Git credential deletes its connection (the cascade).
- A credential can be edited after linking. Both credential readers throw
  `CredentialProviderMismatchError` once the credential's forge (explicit provider, else inferred from
  its host) is no longer the connection's provider, so an adapter is never paired with another forge's
  secret.

### Signing in

The routes live under `/integrations` (`use('*', requireAuth)`); every sub-resource is prefixed
(`/providers/:id/…`, `/oauth/complete`, `/connections/:id`) because the provider grammar would let a
provider be called `oauth` or `connections`.

- **Web flow.** `POST /integrations/providers/:id/connect` needs an `oauth2` method with `userInfo`
  and a preregistered client, an enabled provider (403 otherwise) and a client with a secret (503
  "OAuth is not configured"). The attempt is stored in Redis at
  `integration-oauth:<userId>:<providerId>` (the hashed state, the PKCE verifier, the redirect URI,
  scopes and the client id) for 600 s; one key per user and provider, so a new attempt replaces the
  old one and the keyspace stays bounded under `noeviction`.
- **The callback is a web page**, `/settings/integrations/callback/<provider>`
  (`oauthRedirectUri`, one helper for the authorize request and the admin page). A module provider's
  id holds dots, which the proxy's catch-all matcher takes for a static file, so `web/src/proxy.ts`
  names this path in a second matcher entry: the page gets its CSP header and login redirect. It strips `code`
  and `state` from the address bar and POSTs once to `/integrations/oauth/complete`, never retrying a
  refusal; the web client's one resend after refreshing an expired cookie is the only repeat, and only
  that send reaches the attempt.
  This replaced the plan's api GET callback: the work happens in a cookie-authenticated POST that
  passes the Origin check, the web client refreshes an expired cookie, `WEB_ORIGIN` is always defined
  where the public api origin is not, and the api keeps no state-changing GET. The per-provider path
  is the RFC 9700 mix-up defence.
- `POST /integrations/oauth/complete` takes the attempt with a compare-and-delete script BEFORE it
  asks the vendor anything or writes anything, so a replayed, foreign or other-session state is
  refused with nothing written; an unknown provider answers the same invalid-state text. The code is
  exchanged with the client the attempt started with, and a client removed in between is refused by
  name.
- **Device flow.** `POST /providers/:id/device/start|poll`. The browser gets a 32-byte opaque handle;
  the vendor's device code stays in Redis (`integration-device:<user>:<provider>`, TTL the vendor's
  `expires_in` bounded to 1–1800 s). A poll claims the record by moving `nextPollAt`, so an early or
  concurrent poll answers `pending` without calling the vendor; `slow_down` lengthens the interval by
  5 s, and the next poll is due one new interval from now. While
  the token endpoint is polled, a vendor refusal drops the record (400) and an unavailable vendor keeps
  it (502); once the token poll succeeds the record is consumed whatever the account lookup and the
  sign-in then answer. The legacy
  `/github-oauth/device-code|poll` routes run the same path and hand out the handle as `deviceCode`,
  which binds the device code to the user who started it.
- Sign-in asks for write scopes only while the user's write switch is on. The settings page offers
  "Reconnect to grant write access" when the switch is on and the connection lacks the method's write
  scopes.

### OAuth clients

`oauth-client.ts`: only GitHub has extra sources. For GitHub the order is the env pair
`GITHUB_OAUTH_CLIENT_ID`/`_SECRET`, then the user's own client id (`user_secrets`
`github_client_id`, set through `PUT /integrations/github`), then the admin row; every other provider
uses the admin row only. A source is taken whole, never mixed, and a source that cannot serve the
method is skipped: `oauth2` needs a secret, `device` does not. So a user's own GitHub client id serves
the device flow only, and the web flow needs the env pair or the admin row. The env pair reaches the
api service only.

### Tokens and refresh

`getConnectionAccessToken(db, id, {fetchFn})` throws `NeedsReauthError` for a connection that is not
`connected`, returns a credential-backed connection's credential secret (never refreshed), and returns
a token that is not within 5 minutes of expiry. A refresh runs in a transaction with `SET LOCAL
lock_timeout = 30s` and the row `FOR UPDATE`, re-checks the expiry after the lock (a waiter behind a
finished refresh makes no vendor call), and shares one in-flight refresh per database client
(`WeakMap<Database, …>`; the row lock covers two pools). A row lock rather than the plan's Redis lock:
the refresh writes that row anyway, no lease can expire mid-call, and it serialises with disconnect's
DELETE.

The refresh goes out under the client that issued the connection (`oauth_client_id`): if that client
is gone but another is configured, the connection becomes `needs_reauth` ("was replaced"); if no client
is configured at all, nothing is written, because a cleared row or an unset variable during a deploy
can come back. A connection with no recorded client (`oauth_client_id` NULL, e.g. rows from
before 0202) refreshes with whichever client currently ranks first, so replacing a client does not
move such a row to `needs_reauth`. `invalid_grant` (and GitHub's `bad_refresh_token`) means
`needs_reauth`, written inside the transaction and thrown after it commits; `invalid_client` keeps
the status and the tokens and records `last_error`, since fixing the client heals every connection
(GitHub's `incorrect_client_credentials` likewise); a connection that holds no refresh token becomes
`needs_reauth`; a network error, a 5xx or a timeout writes nothing. A successful refresh writes both
tokens under a new DEK, keeps the old refresh token when the vendor does not rotate it, and keeps the
granted scopes when none are sent.

`getConnectionCredential` adds the credential's username and API base for a forge call (Bitbucket
Cloud app passwords need Basic auth); an OAuth connection answers `username` and `apiBaseUrl` null.
Neither function checks ownership: only ids the resolver produced may reach them.

**Vendor answers** (`oauth.ts`): 15 s timeout covering the body, `redirect: 'error'`. A network error,
a timeout and any 5xx are `OauthUnavailableError` (the 5xx check comes after the body is read and
before it is parsed); otherwise a JSON body with an `error` field is an `OauthVendorError` whatever the
status (GitHub refuses with 200), and any other non-2xx is unavailable. A known error code (RFC
6749, 7009, 8628 and GitHub's) passes through whole — a short secret inside `invalid_grant` once turned it into `[redacted]` and the
refresh missed it; other codes are redacted and cut. Code branches on the `error` code, never on the
text. `expires_in: 0` means already expired. Over HTTP: vendor error 400, unavailable 502.

## The write switch

One switch per user per provider (`integration_user_settings`, default off), covering every account of
that provider and never set per task or per step. `PUT /integrations/providers/:id/write` writes it and
audits `integration.write_switch`. It is in Postgres, with no ConfigService cache, so a flip is
visible to the next read. `integrationTools` lists a binding's read operations always and its write
operations only when the binding asked for write access and the caller's `writeAllowed` says yes —
the broker answers it from the task owner's switch; anything that is not `read` counts as write. Tool
names are computed from what the bindings declare before the switch filters them, so a flip never
renames a listed tool. `integration_connections.write_enabled` is reserved as the admin's switch for
a shared connection (a write through one is to need both); nothing reads it yet, since the broker
refuses every shared connection.

## Choosing an account

`resolver.ts`, per task and category, first hit wins:

1. the task's choice (`task`);
2. the task's grant from an earlier dispatch — sticky, so a run keeps the account it started with
   (`grant`);
3. the owner's preference, a provider and optionally an account (`user`);
4. the install default, a provider only, resolved against the task owner's accounts (`admin`);
5. the only usable account (`only`; `pinned` for a provider-pinned requirement).

Otherwise the result is unresolved with a reason — `no-provider`, `provider-disabled`,
`no-connection`, `needs-choice`, `not-allowed-by-repository`, `connection-unavailable`, and for a
forge `no-repository` and `no-remote` — and `candidates`, the connection ids a picker offers.

Candidates are the task owner's scope-user connections of a provider that serves the category (or the
pinned provider), with the provider enabled; for `forge` the linked credential must fit the
repository's `remote_url` (`credentialUsableForPr`), then the repository allow-list applies.

The rules that look odd and are deliberate:

- **Status is checked only on the account the tiers picked, never used to filter candidates.** A
  picked account that is not connected answers `connection-unavailable` with its id, so an expired
  token fails by name instead of quietly switching to another vendor.
- **Explicit beats soft.** A task choice resolves only through its account: one that names none (the
  PUT allows it, and deleting the account leaves one) answers `needs-choice` whatever its provider's
  state. A choice or grant whose account's provider is disabled, whose account the repository's
  allow-list excludes, or (forge) whose task has no repository or remote stops there with that reason.
  An account that is gone, foreign or no longer fits the repository counts as absent: a choice then
  asks again (`needs-choice`), a grant falls through to the next tier. The preference and the install
  default skip a provider that is disabled, not connected, not allowed or not for this repository, and
  record why; a preferred provider with several usable accounts, none of them named, stops the walk
  with `needs-choice`.
- A forge connection with no linked credential never fits; every forge connection has one today.
- One resolution per target per call: two requirements naming the same category get the same account.
- Choices are the desired state the api writes; grants are the applied state written where resolution
  runs at dispatch. A change on a running task applies from the next dispatch. Whoever serves an agent
  must never compare a run's stamp with the task's current grant: a sibling dispatch rewrites the grant
  and would cut a run that is still going.
- `integration_grants.tool_allow_list` is never written, so nothing reads it.

`resolveStepIntegrations(db, {taskId} | {draft}, requirements)` is read-only;
`resolveTaskCategories` answers `GET /tasks/:id/integrations`, meant for the task page, which does not
call it yet; `recordTaskGrants` upserts one grant per category (a
no-op when unchanged) and skips unresolved and provider-pinned results. The agreed dispatch contract:
the grant is written FIRST and the stamped invocation inserted after it, in one transaction, so no run
holds a connection without a grant.

**Dispatch** (`worker/src/step-engine/step-integrations.ts`, the llm and fan-out sites of
`step-runner.ts`). A step's requirements are its composable catalog entry's `integrations` (a prompt
step's are its pinned entry's, and one that no longer parses fails the step
`integration-requirement-invalid` before anything resolves); boot refuses, naming the step, a
declaration none of the step's dispatches can carry (no `llm` or `agentMining` phase without a
`toolProfile`). Only a dispatch whose spec leaves `toolProfile` unset resolves; recaps, the AI-fix
agent, merges and the DAG never do. One resolution per dispatch, shared by every agent of a fan-out:
a required requirement that does not resolve fails the step `integration-unresolved` naming it, its
category and the reason (an optional one is dropped), a requirement that pins a provider is refused
`integration-provider-pinned` until pins land (J6e), and a missing signing key or tool names the
broker could not list fail `integrations-no-signing-key` and `integration-tools-unlistable`. The run is written by `insertStampedRun`: one transaction that takes
`lockTaskIntegrations` (the lock the choice PUT and DELETE take first), resolves again, records the
grants from that resolution and inserts the run stamped with its bindings; a required binding lost
since the first resolution writes nothing and fails the step. In a fan-out only the first run goes
through it: that run's stamp is the fan-out's, and every later agent is inserted with the same
bindings, with no second resolution and no grant write, so a choice changed meanwhile applies from the
next dispatch (an agent can then carry an account removed after the first insert, and the broker
refuses its calls `connection-unavailable`). Bindings make the dispatch need an
MCP-capable CLI, and the prompt names each provider (its id when the display name is not one safe line
or names an agent path) with the tools the agent will see, write tools only while the owner's switch
is on, never the account. The prompt and the CLI choice come from the first resolution and the stamp
from the second; tools/list follows the stamp, so a choice change landing between the two can only
leave the prompt naming tools the agent is not offered.

**Repository allow-list.** `repositories.integrations_restricted` plus repository grants (category
NULL) listing the allowed accounts. It fails closed on the flag, never on whether entries exist: entries
cascade with their connection — deleting a Git credential is enough — so keying on entries would lift
the restriction when the last allowed account goes. Restricted with no entries allows nothing.

**Routes.** User: `GET /integrations/preferences`, `PUT|DELETE /integrations/preferences/:categoryId`
(no audit). Install defaults: `GET /integrations/defaults` for anyone signed in, `GET|PUT
/admin/integrations/defaults[/:categoryId]` for an admin (`{providerId: null}` clears; audited
`integration.category_default.update`). Repository: `GET|PUT /repositories/:id/integrations
{restricted, connectionIds}` for its owner, diffed under
`pg_advisory_xact_lock(integration-allow-list:<repo>)` so two saves never interleave. Task: `GET
/tasks/:id/integrations` (kept off the polled `GET /tasks/:id`), `PUT /tasks/:id/integrations/:category
{providerId, connectionId?, remember?}` and `DELETE …?remember=1`: one transaction writes the choice,
the preference when `remember`, and the event `task.integration_choice_changed`; DELETE also removes
that category's task grant. Refusals (`api/src/lib/integration-choice.ts`): unknown category,
unknown provider, a provider that does not serve the category, an account of another provider, a
forge account that does not fit the task's repository and an account outside a restricted repository's
allow-list are 400; a disabled provider is 409 (403 on sign-in and link — both pinned by tests); a
connection that is not the caller's is 404, missing and foreign alike; a completed or cancelled task is
409 (a failed one can still change) and a dead one 409 `task_dead`. Admins get no override on another
user's preferences, repositories or tasks.

## Forges

`@haive/shared/forge` holds the forge code that needs no database: the types and typed errors,
`BaseForgeProvider`, the five adapters, the registry, the provider specs, the argument validators and
`known-hosts.ts`. The worker keeps what reads the database and decrypts — `resolveForgeContext`, the PR
poller and the PR open in `12-worktree-cleanup` — and re-exports the subpath so its callers did not
change.

- **Default API bases**: GitHub `https://api.github.com` for github.com, else `https://<host>/api/v3`;
  Gitea `/api/v1`; GitLab `/api/v4`; Bitbucket Cloud `https://api.bitbucket.org/2.0`; Bitbucket Server
  `/rest/api/1.0`.
- **Auth headers**: GitHub and Bitbucket Server Bearer, Gitea `token`, Bitbucket Cloud Basic
  `username:password` when the credential has a username. GitLab uses `Authorization: Bearer`, never
  `PRIVATE-TOKEN`: fetch drops `Authorization` on a cross-origin redirect but keeps a custom header.
- **Errors**: 401/403 `ForgeAuthError`, 404 `ForgeNotFoundError`, 409/422 `ForgeConflictError`, 429
  `ForgeRateLimitError` with `Retry-After`. On a 409/422 from a create, the adapter looks up the open
  pull request for the branch pair and returns it when one exists; otherwise the conflict stands.
- **Deadline**: `FORGE_REQUEST_TIMEOUT_MS` (30 s) per request, headers and body, injectable through
  the constructor. `openPullRequest` can make two requests, so one call can take up to twice that.
  An error response whose body stalls is still reported as its HTTP status, not as a timeout: the
  status line is the answer, and a timeout would lose the 401 token error, the 429 back-off and the
  409/422 recovery of an already-open pull request (declined Codex finding on #756). Before this, a
  forge that never answered held a PR open or a poll forever.
- **Arguments an agent can reach** (`op-args.ts`): `validateForgeOpArgs` refuses an unknown operation
  and any object without EXACTLY the declared string keys; `prNumber` must be `^[1-9][0-9]{0,9}$`;
  `head` and `base` valid branch names of at most 255 characters; title 1–256; body at most 65,536.
  There is no owner or repository argument: those come from the task's repository. Every adapter
  re-checks the PR number first, because `prNumber = '../../../../user'` once sent the token-bearing
  request to `https://api.github.com/user` — URL parsing normalises dot segments.

**Remotes and credential fit** (`known-hosts.ts`). The public-host table (github.com, gitlab.com,
codeberg.org as Gitea, bitbucket.org) is a `Map`, so a host named like an object property is not a
forge; a self-hosted host's name cannot reveal its forge. Every host is lower case. An ssh, scp or git
remote's port belongs to the transport and is dropped; an http(s) remote keeps its port.
`parseRemote` takes everything between the host and the last segment as the owner (GitLab subgroups)
and strips Bitbucket Server's `/scm/`. `credentialUsableForPr`: for a public host, the credential's forge
must be that host's and the credential's own host (port dropped) must infer the same forge, so a
self-hosted credential of the same forge never fits a public remote; a self-hosted host needs a host
match and an explicit provider; for an ssh/git remote the credential's port is not compared;
comparisons ignore case. `credentialApiHost`: for an ssh/git remote
on the credential's host, the default API base keeps the credential's port (a token for
`git.example.com:8443` used to go to `https://git.example.com/api/v1`); an http(s) remote's host stays
authoritative.

**Credential host and API base** (`api/src/routes/repo-credentials.ts`). This is where a secret's
destination is decided. The host is stored trimmed and lower case and must survive
`https://<host>/` parsing unchanged, which refuses numeric forms such as `2130706433` and `0x7f.1`; it
says nothing about the kind of destination, so `localhost` and dotted IPv4 literals are accepted (a
bracketed IPv6 literal does not match the host grammar and is refused; self-hosted
forges on a private network are legitimate, and the host is set by the user, never by an agent). A set
API base must be `https:`, carry no user or password, contain no `?` or `#` (endpoint paths are
appended to the stored text), and sit on the credential's host (port included) or on the host of the
forge's default API base (api.github.com, api.bitbucket.org). An edit reads, checks and writes under
the row's lock, judging the value that will be stored against the new host. A plain-http self-hosted
forge therefore cannot be given an http API base, and its default base is https, so its pull-request
calls cannot reach it. The rule runs on create and edit; a row stored before it may still hold another
base, so `resolveForgeContext` (worker, PR open and poll) re-checks every use: before the token is
decrypted it refuses, with a ForgeError naming the fix, a credential that does not fit the repository's
remote (`credentialUsableForPr`) and a stored base that fails `apiBaseFits`. It reads the row once and
decrypts that same row (`decryptCredentialRow`), so an edit landing between the check and the decrypt
cannot pair the new token with the host and base that were checked. With no stored base, the default
follows an http(s) remote's host.

## The call log, the stamp and the token

- **Task token** (`task-token.ts`): `v1.<payload>.<mac>`, payload
  `{aud, taskId, taskStepId?, cliInvocationId?, exp}`, 24 h by default; the MAC key is derived per
  audience, so a token verifies under its own audience only. Audiences: `rag`, `ddev`, `custom-mcp`,
  `integrations`. An `integrations` token is meant to carry the step and the invocation too, tying
  each call to the run whose bindings it may use; `verifyTaskToken` treats both as optional, so the
  broker requires them (`claimsFromBearer`, `api/src/lib/task-call-auth.ts`). The broker must not live
  under `/integrations`, whose `requireAuth` would answer a sandbox token 401.
- **`integration_calls`**: the provider id (`varchar(256)`, not null, no foreign key), the connection,
  task, step and invocation (each `SET NULL` on delete, so rows outlive a deleted task), tool, access,
  surface (`mcp` or `rest`), outcome (`ok`, `refused`, `error`, `running`), reason, duration, time.
  Never arguments or results — those are someone's mail and documents (pinned by
  `database/test/integrations-schema.test.ts`). `running` lets the broker write the row before the
  vendor answers, so a crash leaves an honest "attempted, outcome unknown".
- **The stamp**: `cli_invocations.integrations`, the bindings resolved at dispatch
  (`{requirementId, categoryId|null, providerId, connectionId, access}`), NULL when none. One decision,
  one value: a run keeps the provider its prompt named, and the next dispatch resolves again.
  `parseIntegrationBindings` drops any entry that does not parse.
- **The run's server** (`worker/src/queues/cli-exec/resolvers.ts`, `sandbox/integrations-mcp-server.ts`):
  at exec, a run whose invocation row carries a non-empty stamp and whose MCP profile is full (not
  `rag_only`, not `none`) gets the `haive-integrations` server: a script at
  `/haive/haive-integrations-mcp.mjs` and a token file beside it holding an `integrations` token for
  that task, step and invocation (lifetime: the run's timeout plus 15 min, the same rule as
  `haive-custom`). The server's entry names only the api URL (`INTEGRATIONS_MCP_API_URL`), never the
  token, so it is the same for every run of a task and the CLIs' merged configs do not churn. The
  script lists `[]` on any failure and answers a refused call as a tool error; the broker decides. A
  stamped run whose server cannot be delivered (no `CONFIG_ENCRYPTION_KEY`, no step, a config the
  task volume did not take, a CLI with no MCP configuration such as amp) fails `integrations-unwired`
  before its CLI starts, rather than running
  without the tools its prompt names.
- **Tool names** (`integrationTools`): a tool is named by its operation id; when two declared tools
  share one, every holder becomes `<requirementId>_<opId>` (other characters replaced by `_`). Every
  declared name is checked against `TOOL_NAME_PATTERN` and for uniqueness even while the write switch
  is off, and a bad name throws, naming the requirement and the operation, instead of being skipped.

## The broker

`POST /integration-mcp/tools/list` and `POST /integration-mcp/call` (`api/src/routes/integration-mcp.ts`)
take an `integrations` token naming a step and an invocation, read that invocation and its task, and
answer 401 `invocation-not-live` unless the invocation is the token's, of the token's step, not ended
and not superseded. Both sit behind their own body limit (`INTEGRATION_CALL_BODY_LIMIT_BYTES`, about
793 KiB), sized from the longest `open_pull_request` arguments with every character a JSON-escaped
surrogate pair (12 bytes), so every argument the tool schema advertises can arrive; it answers 413 before
the token is read. Lengths are counted in code points, as JSON Schema's `maxLength` counts them, and the
title's `minLength: 1` is published too.

- **tools/list** builds the tools from the invocation's stamp alone, never from grants or the current
  resolution, with `writeAllowed` read now from the owner's switch. A name clash answers 409
  `tools-unlistable`. It writes no rows and logs the tool names.
- **call** matches the tool name against the stamp with every write tool included, so a write the
  switch has turned off is refused as `write-switched-off` with a row rather than as unknown; a name
  the stamp never declared answers 403 `undeclared-tool` and writes nothing. Each later refusal is a
  row with its reason: `provider-unavailable` (no spec or disabled), `connection-unavailable` (gone,
  not `connected`, another provider, shared, another user's, or its credential cannot be read),
  `write-switched-off`, `invalid-arguments` (400), `no-remote` (409), `connection-not-for-repository`
  (the credential's host is not the task's remote, or it has none), `unsafe-api-base` (`apiBaseFits`,
  so older credentials saved before the rule are refused here rather than sent as is).
- **Budget**: every row, refused or not, is a claim written under `pg_advisory_xact_lock` on
  `integration-budget:<invocationId>`, at most `INTEGRATION_CALL_BUDGET` (50) per invocation; past it
  the answer is 429 `budget-spent` and no row. A refused row whose connection is gone carries a NULL
  `connection_id` (the foreign key).
- **Deadline**: the row is claimed `running`, then one `AbortSignal.timeout(INTEGRATION_CALL_DEADLINE_MS)`
  (30 s) covers the whole operation, the open-PR lookup included (`ForgeContext.signal`), on top of each
  request's own timeout. Expiry finishes the row `error`/`timeout` and answers 504; a typed forge error
  answers 502 with `vendor-auth`, `vendor-not-found`, `vendor-conflict`, `vendor-rate-limited` or
  `vendor-error`; anything else is logged and answers 500 `internal-error`.
- **The token stays in the api.** A vendor may echo its Authorization header, so `BaseForgeProvider`
  removes the credential from an error body while it is still whole, before the 500-character cut: the
  token and each auth header value after its scheme (Bitbucket Cloud's `Basic base64(username:token)`
  included), each also JSON-escaped and URL-encoded, and when the 4 KiB read stopped early also a trailing start of one. The broker then cuts
  its error text to 400 characters and removes the token again. The gated harness
  (`api/test/integration-mcp-db.test.ts`) scans every response, row and log line for the token, its
  Basic form and any 12-character piece of a long token cut by the limit.
- **Bounded vendor answers**: a success body is read up to `FORGE_RESPONSE_MAX_BYTES` (8 MiB; an
  open-PR lookup on Gitea or Bitbucket Server lists a whole page of pull requests with their bodies),
  an error body up to 4 KiB, and the stream is cancelled past either. This is in the shared
  `BaseForgeProvider`, so the worker's forge calls are bounded too.

## Migrations

All guarded and idempotent. 0192 created the six tables and enums (its first line is the rollback).
0202 added `oauth_client_id` and the two partial unique keys (one connection per external account, one
per credential). 0206 added `task_integration_choices`, a preference's `connection_id`,
`repositories.integrations_restricted` and the partial unique keys for task and repository grants.
PostgreSQL truncates three integration foreign-key names over 63 characters (one in 0192, two in 0206)
with a NOTICE, which is harmless and still caught by the guard on a re-run. 0207 added the `running`
outcome (an enum value cannot be dropped, so an undo would have to leave it; the file states no undo),
`reason`, `duration_ms`, the invocation index and the stamp column. The admin-default row is a
preference with `user_id` NULL, unique with `NULLS NOT DISTINCT`; drizzle 0.45.2 has no such
uniqueIndex option, hence a `unique(...).nullsNotDistinct()` constraint.

## Do not change

1. Status is checked on the selected account only; never filter candidates by status.
2. A blocked choice or grant stops; a soft tier skips and says why, or stops at `needs-choice` when its
   provider has several usable accounts and none is named; a choice with no account asks again, and an
   absent account (gone, foreign or no longer fitting) makes a grant fall through and a choice ask
   again.
3. The allow-list fails closed on `integrations_restricted`, never on entry existence.
4. Refresh: row lock, re-check, single flight, under the issuing client (the current top client for a
   row that recorded none); a client refusal keeps the status; a replaced issuing client writes
   `needs_reauth`; no configured client writes nothing.
5. Branch on the OAuth `error` code, never on text; known codes pass whole.
6. Forge connections point at a credential and never copy its token; no expiring forge tokens; a
   disconnect removes only the pointer.
7. One write switch per user per provider; tool names never depend on it; anything not `read` is write.
8. The OAuth attempt is consumed before any vendor call or write; the exchange uses the starting client;
   no state-changing GET.
9. Agent-reachable forge input is validated before a URL is built, and adapters re-check the PR number.
10. A stored API base is https on the credential's own host or its forge's API host: checked on create
    and edit since 9295cd3b3, and again on every use by the broker (`unsafe-api-base`) and by
    `resolveForgeContext`, so an older row is refused rather than sent.
11. GitLab authenticates with `Authorization: Bearer`.
12. A forge request has its own deadline and takes the caller's; a stalled error body keeps its HTTP
    status.
13. Only scope-user, owner-matched connections resolve or are accepted; an install default names a
    provider, never an account.
14. Credential drift after linking fails loudly with `CredentialProviderMismatchError`.
15. `integration_calls` never stores arguments or results.
16. The broker lists and runs only what the invocation's stamp declares and re-reads the write switches
    on every call; it never reads grants, and no token or its Basic form reaches a response, row or log.
17. Only a dispatch stamps, under the task's integrations lock, with its grants in the same
    transaction; the choice routes take that lock first; a provider-pinned requirement is refused at
    dispatch until pins land (J6e).
