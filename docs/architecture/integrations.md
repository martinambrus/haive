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
has an Integrations tab for account overrides, explicit remembered preferences and reset.

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
`isCategoryId` accepts a module-grammar id or a registered core id only; the choice PUT routes are
stricter and accept only a registered category (`listIntegrationCategories`: the core list, then the
categories loaded modules declare); DELETE also accepts retained unavailable categories. Core categories and their labels:
`rich-documents` Documents, `spreadsheets`, `file-storage` File storage, `mail` Email, `chat`,
`issues` Issue tracking, `wiki`, `forge` Git forge. Only `forge` has core providers.

**Module providers and categories.** A module's manifest may declare `integrations` (provider specs)
and `categories` (`{id, label, description?}`), full `module.<moduleId>.<local>` ids (local part at most 64
characters); the manifest rules refuse another module's prefix, a provider category outside core plus the
module's own, `forge`, an `mcp` surface, `selfHosted`, a provider with no usable sign-in (oauth2 with
`userInfo` and `preregistered`, or device with `userInfo`), duplicate ids, a module provider without
`apiHosts` (bare https hostnames), and a composable step requirement naming a `module.*` id the manifest does not
declare or whose id is not `^[a-z][a-z0-9-]{0,15}$`. Provider specs parse strictly: an unknown or misplaced key
is refused by name. The api's `mountModules` and the worker's `bootStepEngine` call
`registerModuleIntegrations` (an idempotent replace behind the unchanged `listIntegrationProviders`,
`getIntegrationProvider` and `listIntegrationCategories`, core first); the worker refuses at boot, naming the step,
a requirement naming a module category or provider no loaded module declares. A module provider with no
provider-config row is off, and enablement folds `modules.deactivated_at` in live, never cached:
`providerState(db, id)` answers `enabled`, `disabled`, `module-deactivated`, `module-missing` (a module-grammar id
nothing registers) or `unknown`. `GET /integrations/categories` lists the core categories, then those of active
modules (`{id, label, description?, moduleId, moduleName}`); `GET /tasks/:id/integrations` lists the categories of
core and active-module providers plus any category a choice or retained task grant already names.

The Settings and admin provider listings carry `state` from the live provider-state snapshot and
`module: {id, name}` for the contributing registered module (`null` for core). The user listing's
`enabled` remains effective availability; the admin listing's `enabled` remains the configured switch,
so a deactivated module can have that switch on while `state` is `module-deactivated`. Admin bulk
reads reuse their already-read config rows in `loadIntegrationStates`, with at most one config query
and one module query. A save computes its response state inside the existing save/audit transaction.
These are availability snapshots, not evidence that a module's worker schema or jobs are ready.
Settings shows disabled/deactivated providers and keeps unavailable owned accounts visible, with
provider availability separate from the account's own status and its disconnect/reconnect controls.

Preferred by kind and Defaults by kind load the active category endpoint before showing editable
rows: core order first, stable module order next, deduplicated by id. Stored preferences/defaults for
unavailable categories remain visible by raw id, with Clear and no new provider option; a default's
saved provider remains named even when unavailable. Category failures show an error rather than a
complete-looking core-only list. Provider badges in Settings and admin use the same category labels,
falling back to ids while metadata is loading or unavailable, with that condition visible. This label
read is independent of provider/client edits; late labels or errors do not reset OAuth fields or saved
write-switch state. Category labels are literal text and unsafe control characters fall back to ids.
Repository allow-lists group owned accounts by provider rather than category and retain that contract.

The core providers are the five forges, in this order: `github`, `gitea`, `gitlab`,
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

During a graceful module drain, provider enablement stays unchanged so already admitted tasks
keep their tools. New task choices and dispatch grants take the module's shared admission guard
in their mutation transaction; nonmembers receive `module-draining`, and dispatch uses the
existing integration wait. A raced final deactivation is rechecked under that guard. The
module drain cohort also counts live invocation stamps, so Reset cannot cut a call off merely
by removing its current grant. See [Modules](modules.md) for finalization and cancellation.

## Module data purge

Uninstalling keeps integration data. An admin's explicit purge of a missing module removes only
configuration and bindings owned by that module. Ownership comes from persisted
`module.<moduleId>.<local>` ids using the scoped provider/category grammar, without needing a
loaded manifest. The delimiter and full local-id match distinguish `foo`, `foobar` and `foo-bar`,
and exclude malformed extra suffixes. `api/src/modules/purge-integrations.ts` supplies the same
predicates to the readonly preview and the delete:

- provider configurations, connections and user write settings belong through their provider id;
- preferences (user and installation defaults) and task choices belong through their category id,
  provider id, or a connection owned by the module;
- grants (task bindings and repository allow-lists) belong through their category id or an owned
  connection.

A binding matching several ownership paths counts once. Bindings are explicitly deleted before
connections, so neither grant cascades nor preference/choice `SET NULL` actions silently change
uncounted rows. A repository's `integrations_restricted` flag stays set: removing its last allowed
account still allows nothing. An unrelated category/provider pointing at an owned account loses
that binding, while unrelated bindings and other modules' accounts/configurations remain.

Live tasks, dead ones included, with a directly affected choice or task grant refuse purge, even
when their type/run list names no module step. The main-store transaction checks direct bindings
again with writers fenced and affected task status rows held. The table fence permits a
connection's row-only `FOR UPDATE` holder, so purge additionally locks owned connection rows
`FOR UPDATE NOWAIT` before task status rows and deletion. This refuses a current disconnect
before its DELETE can wait on purge's table lock; unrelated account row locks remain compatible.
A late live binding or concurrent writer after the module database has gone yields the existing incomplete-cleanup response, with
all main-store changes rolled back. See [Modules](modules.md) for lock ordering and retries.

`integration_calls` are retained: their provider, tool, outcome and task/invocation references
survive, while a removed connection becomes NULL through its existing foreign key. Invocation
integration stamps, task events and audit rows are retained. Git credentials are retained even
when an owned connection points at one: the credential-to-connection cascade is one-way.
No vendor revoke is attempted. The actual six deletion counts join the purge response and its
required main-store audit insert atomically. The database drop and Redis cleanup retain their
separate partial-failure semantics; preview counts promise neither a reservation nor cross-store
atomicity.

## Accounts

`integration_connections` has a `scope` (`user` or `shared`) and a `status` (`connected`,
`needs_reauth`, `revoked`, `provider_unavailable`). Every writer inserts `user` rows today, and every
reader — the listing, disconnect, ownership checks and the resolver — filters `scope = 'user' AND
owner = caller`; shared connections are deferred to the module providers. Only the refresh writes
`needs_reauth`; `revoked` and `provider_unavailable` are declared and never written. The browser sees
`toConnectionSummary`, never a token column. UI keys on `status`; `last_error` is only the words,
following the message-column rule in AGENTS.md, so a `connected` row shows it only while
`refresh_refused_at` is set.

### A forge account is a Git credential

A forge connection holds no token. It points at its `repo_credentials` row (`repo_credential_id`,
`ON DELETE CASCADE`), because every clone and push already reads that table and folding it into
connections would have been a destructive migration. Consequences, all deliberate:

- `finishSignIn` refuses a forge token response that carries a refresh token or an expiry (400): the
  credential holds the only copy and nothing would refresh it, so GitHub Apps with expiring tokens are
  refused.
- Signing in again to the same account updates the connection and its credential's secret in place,
  under `pg_advisory_xact_lock(integration-account:<user>:<provider>:<externalId>)` and `FOR UPDATE`,
  keeping the credential's label, host and provider. It writes a credential only while that is still
  on the sign-in endpoint's host and still the provider's forge; one that moved is left as it is and
  the connection is pointed at another credential, the one an earlier sign-in of the account left or a
  new one. A vendor that sends no new refresh token leaves the
  stored one in place when the sign-in used the row's own method and OAuth client (re-encrypted with the new access
  token; an unreadable one counts as none); under another method or client it is dropped, since a refresh would send
  it with that issuer's credentials. A first forge sign-in creates a credential
  labelled `<Provider> OAuth (<login>)` on the sign-in endpoint's host.
- A credential a sign-in wrote records the vendor's account id (`repo_credentials.sign_in_account_id`,
  0216), and after a disconnect the next sign-in of that account takes it back instead of adding a
  second one. The key is the user, the host and that id, never the username or the label: the oldest
  credential of the user with that id that is on the sign-in's host, still the provider's forge, backs
  no connection and can be decrypted (one stored under a replaced key is skipped). It keeps its id,
  which connections and repositories reference. A second account on the same host gets its own. A
  credential typed by hand has no id and is never taken, and neither is one whose secret the user
  replaced in the edit form, which clears the id. Credentials a disconnect left behind before 0216 are
  unmarked and look hand-typed: the next sign-in adds one more, marked, and later ones reuse it.
- "Use as connection" (`POST /integrations/providers/:id/link-credential`) turns an existing
  credential into a connection: forge only, provider enabled, own credential, the credential's forge
  must be this provider, one connection per credential (0202's unique key).
- Disconnecting a credential-backed connection removes only the pointer; the credential and every
  repository bound to it stay, and nothing is revoked. The next sign-in of that account takes the
  credential back (above).
- Deleting the Git credential deletes its connection (the cascade). The credentials page asks for a
  confirmation that names the connection (`GET /repo-credentials` carries each row's `connection`),
  and the `credential.delete` audit row holds `{connectionId, providerId}` of the connection that went
  with it, written in the delete's transaction; a credential no connection backed has neither key.
  Delete and edit lock the connection row, then the credential row (the order a reconnect uses), and
  look the connection up once more after the credential lock, for one linked meanwhile. That second
  lookup never waits (`FOR UPDATE NOWAIT`): waiting for the row with the credential held would
  deadlock with a sign-in of that account, so a row someone holds answers 503 and the request can be
  sent again.
- A credential can be edited after linking, but not moved. While a connection backs it,
  `PUT /repo-credentials/:id` answers 409 `credential-backs-connection` when the host changes
  (compared case-insensitively) or the forge (explicit provider, else inferred from the host) changes
  to something other than the connection's provider. The label, secret, username, commit identity and
  API base stay editable, and a rename follows into `account_label` of a connection made with "Use as
  connection" (`auth_method` `token`; a sign-in connection keeps the vendor's account name). A
  credential that already drifted can still be renamed or moved back to the connection's forge.
  link-credential reads the credential `FOR UPDATE` before it judges its forge, so an edit committed
  while the link waited is the one judged. Both credential readers still throw
  `CredentialProviderMismatchError` once the credential's forge is no longer the connection's
  provider (a row edited before the refusal existed), so an adapter is never paired with another
  forge's secret.

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
  sign-in then answer. A failed delete of the record (Redis) is logged at warn with its error class and
  never replaces the poll's answer, so a sign-in that committed still answers ok; the record then lives
  until its TTL (at most 1800 s), and a replay reaches the vendor with a spent device code and is refused.
  The legacy
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
the status and the tokens and records `last_error` and stamps `refresh_refused_at`, since fixing the
client heals every connection (GitHub's `incorrect_client_credentials` likewise); a connection that
holds no refresh token becomes `needs_reauth`; a network error, a 5xx or a timeout writes nothing. A
successful refresh writes both tokens under a new DEK, keeps the old refresh token when the vendor
does not rotate it, keeps the granted scopes when none are sent, and clears `last_error` and
`refresh_refused_at`; so does a sign-in. The flag, not the words, is what makes the page show a
refusal on a `connected` row.

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
its `integration.write_switch` row in one transaction (see Audit rows). It is in Postgres, with no
ConfigService cache, so a flip is visible to the next read. `integrationTools` lists a binding's
read operations always and its write
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
`provider-deactivated`, `provider-missing`,
`no-connection`, `needs-choice`, `not-allowed-by-repository`, `connection-unavailable`, and for a
forge `no-repository` and `no-remote` — and `candidates`, the connection ids a picker offers.

Candidates are the task owner's scope-user connections of a provider that serves the category (or the
pinned provider), with the provider enabled; for `forge` the linked credential must fit the
repository's `remote_url` (`credentialUsableForPr`) and, for a forge provider, still be that
provider's forge (`connectionCredentialFits`), then the repository allow-list applies.

Module state survives resolution: an own selected account from a deactivated module answers
`provider-deactivated`; one whose module provider is no longer registered answers `provider-missing`,
including a sticky grant. A provider-pinned target gets the same reasons even without an account.
A module category's registered declaration supplies its deactivation state even when no provider
serves it; a module-grammar category no longer declared or served answers `provider-missing`.
A choice without an account still asks `needs-choice`, and a missing or foreign account is still
absent. An unserved core category retains `no-provider` for an unbound or absent choice; only an
own missing-module account binding supplies evidence for its specific `provider-missing` reason.
An own persisted choice or grant supplies evidence for a missing provider's category without
inventing a spec or offering that account as a candidate. Unknown core ids remain `no-provider`.
Soft tiers skip module providers with `provider-deactivated` or `provider-missing` in `skipped.why`
and keep their fallback; when all owned accounts' registered providers are blocked for the same
reason, that reason is the unresolved result (mixed causes stay `provider-disabled`).
`loadIntegrationStates` loads registered providers and categories from one live bulk read (at most
one provider-config query and one module query); `loadResolverContext` keeps those states, while
`loadProviderEnablement` retains its boolean map for other readers.

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
`resolveTaskCategories` is the category-resolution helper; the task page read route uses the same
`loadResolverContext` and `resolveTarget` contracts; `recordTaskGrants` upserts one grant per category (a
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
a required requirement is classified by its named reason (an optional unresolved one is dropped).
`connection-unavailable` (the selected account's structural status is not `connected`),
`provider-deactivated` and `provider-disabled` park durably; `provider-missing` makes the task dead.
Other unresolved reasons (`needs-choice`, `no-connection`, `no-provider`, repository/allow-list
refusals) keep the named `integration-unresolved` failure and Retry path. A requirement that pins a provider is refused
`integration-provider-pinned` until pins land (J6e), and a missing signing key or tool names the
broker could not list fail
`integrations-no-signing-key` and `integration-tools-unlistable`. The run is written by
`insertStampedRun`: one transaction that takes `lockTaskIntegrations` (the lock the choice PUT and
DELETE take first), resolves again, records the grants from that resolution and inserts the run
stamped with its bindings; a required binding lost since the first resolution writes no run, grant or
job and takes the same wait/dead/failure classification, and so does an account a prompt step's template names (`{{integration:<id>.account}}`)
that now resolves to another connection than the prompt was built on, or appeared or went away
(`integration-account-changed`). A dispatch whose first resolution bound nothing (every requirement
optional and unresolved) inserts its run unstamped with no second resolution, so the prompt's
`(no account connected)` holds for that run and an account connected meanwhile applies from the next
dispatch. In a fan-out only the first run goes
through it: that run's stamp is the fan-out's, and every later agent is inserted with the same
bindings, with no second resolution and no grant write, so a choice changed meanwhile applies from the
next dispatch (an agent can then carry an account removed after the first insert, and the broker
refuses its calls `connection-unavailable`). Bindings make the dispatch need an
MCP-capable CLI, and the prompt names each provider (its id when the display name is not one safe line
or names an agent path) with the tools the agent will see, write tools only while the owner's switch
is on, never the account; a prompt step's template names it only through
`{{integration:<id>.account}}` (see [Task types](task-types.md)). The prompt and the CLI choice come from the first resolution and the stamp
from the second; tools/list follows the stamp, so a choice change landing between the two can only
leave the prompt naming tools the agent is not offered.

**Reconnect and provider waits (J7).** The step's nullable `integration_wait` (0218) stores typed
causes with requirement, category, provider and connection ids from the resolver. Its separate
`continuation: true` bit records that this interrupted dispatch already passed its entry precondition;
it stays true when runtime capacity or module schema setup takes over and clears the active `causes`
array. Legacy nonempty-cause rows also identify an entered continuation, so no data migration is
needed. A cause-free continuation is not a reconnect wait. The envelope never stores a token, invents
a provider for an unserved category, or writes connection `status`: refresh and sign-in
remain the auth-health owners. Deactivation does not say the account's tokens are bad. No vendor
refresh or login runs while checking a wait.

The existing fenced park owner writes `pending`, the shared idle marker and the typed cause in one
transaction, with the task still `running`; its 30 s delayed advance checks the current requirements,
choices/grants, account status and live provider/module state before runtime admission or step work.
A resolved wait re-enters the runner, which resolves again before dispatch and under the stamp lock;
a task override changed meanwhile takes effect there, never from the captured wait account. Optional
unresolved requirements remain nonblocking. The park retains detection, answers and iterations and
does not ask `shouldRun` again on its integration continuation. Mining reservations retain their own
stored prompts and unspent counters: the existing reserved-agent recovery sends them after recovery,
including a follow-up wave, without creating a new agent retry owner.

A park takes the step row first and reads it after the lock, refuses a Retry's unmarked pending row,
a Stop/Skip, a changed epoch, a terminal or dead task, and any live invocation. Duplicate blocks keep
the same idle marker and do not fold a park twice. Pause takes precedence; a runtime or schema
wait that wins after recovery clears only the active integration cause and keeps the continuation bit, so the next
pending tick cannot ask `shouldRun` again and skip unfinished work or reserved follow-up agents.
The existing stale-park sweep repairs a lost delayed advance at boot and after its cutoff.
Reset/Retry, terminal settlement and successful claim clear the whole `integration_wait` envelope.
Runtime/schema cause transfer reads that envelope under the park transaction's step-row lock;
a pending CLI switch can reset it at the same epoch, so copying the earlier unlocked park snapshot
would resurrect the cleared continuation and suppress a fresh entry check. Pause leaves the column
untouched. Row-before-task locking and the timing fold remain in the same park transaction.
Banner/badge readers require pending status plus idle marker and a nonempty active cause array: stale
copy or an ended task cannot advertise a reconnect wait. The banner points to Settings and names the
requirement/provider state; the `integration` wait badge is shared by the task header and list.

Missing providers use the existing dead-task owner, guards and boot revival, including run supersede
and the new-work fence. The boot dead-task pass also resolves the current step's required integrations,
so it cannot revive merely because that step still exists. It revives only once no required target is
`provider-missing`; a restored but deactivated provider then parks on its own actionable state. Installing
a module requires a worker restart, which is the recheck trigger. An uninstalled module category with
no selected provider is named by category alone; an own stored choice/grant supplies provider evidence
when present. Other hard failures (provider pins, signing key, tool names, invalid pinned requirements,
account changed while building a named prompt) keep their prior refusal paths. A saved wait whose
pinned requirements no longer parse reaches that hard failure even when a valid sibling is still
blocked; the park/dead recovery readers never promote unsupported provider pins to provider deaths.

**Repository allow-list.** `repositories.integrations_restricted` plus repository grants (category
NULL) listing the allowed accounts. It fails closed on the flag, never on whether entries exist: entries
cascade with their connection — deleting a Git credential is enough — so keying on entries would lift
the restriction when the last allowed account goes. Restricted with no entries allows nothing.

**Routes.** User: `GET /integrations/preferences`, `PUT|DELETE /integrations/preferences/:categoryId`
(no audit). Install defaults: `GET /integrations/defaults` for anyone signed in, `GET|PUT
/admin/integrations/defaults[/:categoryId]` for an admin (`{providerId: null}` clears; audited
`integration.category_default.update`, in the change's transaction). Repository: `GET|PUT
/repositories/:id/integrations {restricted, connectionIds}` for its owner, diffed under
`pg_advisory_xact_lock(integration-allow-list:<repo>)` so two saves never interleave, with the repository
row locked and the change audited in that transaction (`repository.integrations.update`: `restricted`,
`added`, `removed`). Task: `GET
/tasks/:id/integrations` (kept off the polled `GET /tasks/:id`), `PUT /tasks/:id/integrations/:category
{providerId, connectionId?, remember?}` and `DELETE …?remember=1`: one transaction writes the choice,
the preference when `remember`, and the event `task.integration_choice_changed`; DELETE also removes
that category's task grant. Refusals (`api/src/lib/integration-choice.ts`): unknown category,
unknown provider, a provider that does not serve the category, an account of another provider, a
forge account whose credential does not fit the task's repository (`connectionCredentialFits`: not
that remote, or no longer its provider's forge; one answer for both) and an account outside a
restricted repository's allow-list are 400; a disabled provider is 409 (403 on sign-in and link —
both pinned by tests); a connection that is not the caller's is 404, missing and foreign alike; a
completed or cancelled task is 409 (a failed one can still change) and a dead one 409 `task_dead`.
Admins get no override on another user's preferences, repositories or tasks.

## Task-page controls

The task page’s **Integrations** tab uses the ordinary authenticated web API client and is loaded
only when opened, separate from task polling. Its owner-only `GET /tasks/:id/integrations` retains
`categories` with resolver status, source/reason and skipped tiers; it adds `choices` (category,
provider and nullable account ids) and `grants` (category/nullable account ids). An account id outside
the owner’s user-scope accounts is returned as null, including on a stale stored binding. Categories
include retained choice and grant categories even when a module has disappeared, so reset remains possible. Each
category also carries eligible `candidates`, including while resolved. Candidate discovery calls the
same resolver with choices, grants, preferences and defaults cleared; owner/user scope, provider
state, repository fit and allow-list remain authoritative and connection status is never filtered.
No credential, secret or other owner’s account is returned. The tab obtains labels and structural
account status from the existing safe providers, connections and categories endpoints.

Current resolution and the task’s explicit override are displayed separately. A missing or ineligible
explicit provider/account remains visible and removable; Refresh does not prune a draft or replace an
unavailable account. Unresolved states show their named reason (including newer unknown reasons)
and direct the owner to Settings in another tab and Refresh. Provider-only choices are supported by
the existing PUT contract and ask for a specific account at resolution. The server validates every
submitted provider/account and remains final authority for repository and provider constraints.

Save sends `remember: true` only after **Also for my later tasks** is checked. Reset uses the task
DELETE, clearing both choice and category grant; it clears the user preference only after a separate
**Also clear my remembered preference** checkbox. Both consents start unchecked and clear after a
confirmed mutation reload. No control enables write access. Running invocation stamps are unchanged;
all choices take effect from the next dispatch.

Task ids own separate component state and outstanding reads are fenced against unmount and newer
loads. The task-detail poll accepts replies in request order within the current route: a slower older
reply can settle while a newer read is pending, but cannot overwrite a newer reply already applied.
An older running reply therefore cannot replace an ended/dead status. Busy controls and a synchronous action claim prevent duplicate mutations; confirmed server
reloads supply canonical state. Failed requests preserve the draft and expose Refresh for recovery.
A task poll marking completed, cancelled or dead makes controls read-only even if an older request
finishes later. These controls do not park, retry or resume workers. Browser width checks are required
for the new tab at 1280, 768 and 390; unrelated task header layout is outside this feature.

## New Task admission

`GET /tasks/integration-preview?type=<slug>&repositoryId=<uuid>&choices=<JSON>` is an
authenticated, read-only preview. `repositoryId` is optional and must name the caller's own
repository. `choices` is an optional JSON array of `{categoryId, connectionId}`; the same array
is accepted as `integrationChoices` on `POST /tasks`. It is strictly typed, accepts at most 64
unique categories, and refuses unknown choice keys (including `remember`); the query's JSON
text is capped at 24,000 characters. A choice names an account, with its provider derived on
the server. Neither request creates a preference or a grant.

The response is `{admitted, scope, categories, issues}`. Each category carries its id and label,
`required` (true when any step requires it), its step contexts (`stepId`, title,
`requirementId`, access and optional flag), current `status` and named `reason`, token-free
`selected` account and `candidates`. Accounts contain only `connectionId`, `providerId`,
`providerLabel`, `accountLabel` and structural connection `status`. Candidate discovery uses
the same resolver with its choice and soft tiers cleared; status stays visible and never
silently switches an unavailable account to a different one. The picker offers the account
labels and directs unavailable accounts to Settings. Provider/module reasons remain open strings
so a newer named reason can be displayed without inventing a new selection rule.

For a static type the preview uses the definition's exact snapshot, the current catalog entries
and the prompt steps that would be pinned on create. It aggregates categories across those steps;
optional unresolved categories do not block. Invalid stored requirements and provider pins are
reported in `issues` and refuse creation, matching the worker's dispatch refusal. `scope` is
`static` for these lists. Dynamic built-in paths (`workflow_paths`, `run_app_modes`) and unseeded
built-ins answer `scope: 'dispatch-time'`: the API does not reconstruct a worker run list and
makes no claim about requirements on a path chosen later. No shipped core step currently declares
integration requirements. The worker still resolves every dispatched step, for both scopes.

A preview makes no vendor calls, refreshes no tokens and writes no task, event, job, choice,
preference or grant. Creation re-evaluates the requirements against the definition read `FOR SHARE`
inside its existing insert transaction; relevant catalog rows are also read `FOR SHARE`. Explicit
accounts are revalidated for owner, user scope, category/provider, repository fit, allow-list,
provider enablement and connected status. A refusal writes nothing. An unresolved required category
answers 409 `{code: 'integration-admission-required', error, integrationPreview}` with a fresh preview.
Success writes the requested choices and `task.integration_choice_changed` events
(`remembered: false`) in the task/event/queue-state transaction, then enqueues only after commit.
A failed choice/event/queue-state write rolls the task back too. Existing root, upgrade,
database and attachment admission stays in that transaction. This is account admission only:
the owner's write switch and broker permissions still decide which operations can run, and the
worker's dispatch resolution remains final authority when accounts or provider state change later.

Required static integrations selected automatically are module dependencies just like explicit
picks. The read-only preview checks their freshly resolved module state and reports
`module-draining` without admitting creation; the insert transaction takes the same required
modules KEY SHARE before recording the task, so a lifecycle write waits for admission. The same creation transaction records the known required module ids in `module_task_admissions`,
so a create that wins before a drain is included in its later cohort. These tags do not pin an
automatic account as a task choice or grant and do not reconstruct dynamic paths. They survive
cancel/reactivate/urgent actions until task deletion or explicit module purge, with the normal
live/nondead task filter on dependency reads; there is no legacy inference or backfill. An
admission-row failure rolls back task/events/queued state too.
An optional module account denied to a nonmember is omitted before the worker builds its account
text, prompt and tools. The dispatch keeps that omission through its second resolution, even if
the drain is cancelled meanwhile; it never adds an account to a prompt built without it. An
account already used by a cohort member or an immutable fan-out stamp keeps its existing behavior.
A drain beginning after a bound prompt was built still refuses that insert through the existing
integration wait, allowing the next poll to rebuild the optional prompt without the account.

New Task checks the actual create type (including Workflow's inferred onboarding/workflow type),
repository and explicit choices. It discards old responses, gates Create while the current check is
pending, failed or missing a required account, and rechecks each account choice. Optional unresolved
categories remain nonblocking. The onboarding readiness/reset checks retain their own state and errors;
changing an inferred type invalidates the integration preview without clearing entered form text.
Settings opens in another tab, and Refresh accounts rechecks a newly connected account while
keeping the draft. A create-time admission refusal refreshes the preview without resending creation.

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
  `PRIVATE-TOKEN`: fetch drops `Authorization` on a cross-origin redirect but keeps a custom header (redirects are no longer followed, see below,
  so this is now defence in depth).
- **Errors**: 401/403 `ForgeAuthError`, 404 `ForgeNotFoundError`, 409/422 `ForgeConflictError`, 429
  `ForgeRateLimitError` with `Retry-After`. On a 409/422 from a create, the adapter looks up the open
  pull request for the branch pair and returns it when one exists; otherwise the conflict stands.
- **Dialing and redirects**: `BaseForgeProvider.request` sends through `ctx.fetchFn` with
  `redirect: 'manual'`; a 3xx answer cancels its body and throws a `ForgeError` carrying the status that
  says redirects are not followed (set the credential's API base to the final address, or check the
  repository was not renamed or moved: GitHub answers a renamed repository with a 301). Both places that
  build a `ForgeContext` (worker `resolveForgeContext`, api `integration-mcp.ts`) pass `guardedFetch`
  from `@haive/shared/egress`, so a forge host that resolves to a private, loopback or link-local address
  is refused unless the administrator's private-endpoint allowlist lists it (`api-auth.md`); a refusal
  reads as a connect failure (`fetch failed`). `ForgeContext.fetchFn` is required with no default: a site
  that leaves it out fails to typecheck, and a context built without it by a cast gets a `ForgeError` with
  nothing sent.
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
comparisons ignore case. `connectionCredentialFits(providerId, credential, origin)` is what a
connection's credential must pass: for the five forge providers the credential's own forge
(`credentialForgeProvider`) must also be the connection's provider, then `credentialUsableForPr`
applies; any other provider is judged by the origin alone. The resolver's `fits` and the choice route
both ask it, so a connection whose credential was moved to another forge by an edit made before the
refusal existed is never resolved or chosen, while its readers keep throwing
(`CredentialProviderMismatchError`). `credentialApiHost`: for an ssh/git remote
on the credential's host, the default API base keeps the credential's port (a token for
`git.example.com:8443` used to go to `https://git.example.com/api/v1`); an http(s) remote's host stays
authoritative.

**Credential host and API base** (`api/src/routes/repo-credentials.ts`). This is where a secret's
destination is decided. The host is stored trimmed and lower case and must survive
`https://<host>/` parsing unchanged, which refuses numeric forms such as `2130706433` and `0x7f.1`; it
says nothing about the kind of destination, so `localhost` and dotted IPv4 literals are accepted (a
bracketed IPv6 literal does not match the host grammar and is refused; self-hosted
forges on a private network are legitimate, and the host is set by the user, never by an agent; a private host needs an entry in the administrator's
private-endpoint allowlist before any forge call reaches it, and the upgrade seed lists the hosts and API
bases of credentials already stored, `api-auth.md`). A set
API base must be `https:`, carry no user or password, contain no `?` or `#` (endpoint paths are
appended to the stored text), and sit on the credential's host (port included) or on the host of the
forge's default API base (api.github.com, api.bitbucket.org). An edit reads, checks and writes under
the row's lock, judging the value that will be stored against the new host. An edit also refuses a
host or forge change while a connection backs the credential (409 `credential-backs-connection`; see
A forge account is a Git credential). A plain-http self-hosted forge therefore cannot be given an
http API base, and its default base is https, so its pull-request calls cannot reach it. The rule
runs on create and edit; a row stored before it may still hold another
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
  without the tools its prompt names. The failure names each server whose `mcp add` failed.
- **Tool names** (`integrationTools`): a tool is named by its operation id; when two declared tools
  share one, every holder becomes `<requirementId>_<opId>` (other characters replaced by `_`), and such
  a name longer than 40 characters keeps its first 31, then `_` and the first 8 hex characters of the
  sha256 of `<requirementId>\n<opId>`, so a long operation id never leaves a step unlistable. Every
  declared name is checked against `TOOL_NAME_PATTERN` and for uniqueness even while the write switch
  is off, and a bad name (a leading digit, a collision) throws, naming the requirement and the
  operation, instead of being skipped.

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
  row with its reason: `provider-unavailable` (no spec, disabled, or a module provider with no executor
  for the operation), `provider-deactivated` (its module is deactivated), `provider-missing` (the stamp
  binds a module provider no loaded module declares; any tool name the stamp no longer lists is then
  refused this way, with the agent's name not stored), `connection-unavailable` (gone, not
  `connected`, another provider, shared, another user's, its credential cannot be read, or its token
  could not be renewed),
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
  an error body up to 4 KiB, and the stream is cancelled past either. The shared `BaseForgeProvider`
  reads its success bodies through its own bounded reader and its error bodies through
  `readForgeErrorExcerpt` (`@haive/shared/forge`), so the worker's forge calls are bounded too. The
  api uses `readForgeJson` for GitHub's repository pages (`github-oauth.ts`: one bounded read per
  page, paging stopped when GitHub sends no next link) and `readForgeErrorExcerpt` for an Ollama
  pull's error body (`tooling.ts`). The Ollama pull stream (`POST /tooling/pull-ollama-model`,
  `routes/tooling.ts`) relays a stream from a user-typed URL and is bounded in the api: a pending line
  over 64 KiB, more than 64 MiB in total, or 10 minutes with nothing received (the idle timer covers the
  connect, a non-OK excerpt read and every chunk; it is not a total-duration cap) ends the pull with one
  `error` event naming the cause, never `cancelled` or `done`; an in-stream `error` text is cut to 200
  characters; the upstream is aborted and its reader cancelled on every exit.
- **One scrub** (`redactSecrets`, `api/src/lib/module-vendor-client.ts`) removes the secrets from every
  vendor answer before a module executor sees it, and from every error text, every module result and
  every forge success text the broker answers, in every spelling a vendor's encoder may echo: each
  character, a letter or digit too, as is, `%xx` or `\uXXXX` in either case, a slash as `\/`, each
  also inside a JSON string; with a cut read, also a start of one, or of one of its escapes, left at
  the end. Forge success text is scrubbed and never cut.

### Module provider calls

A module that declares providers exports `./integrations`: executors by provider id, then operation
id, each a zod `args` schema and a `run` (`IntegrationExecutor`, `@haive/shared/module-host`). The api
loader refuses to boot a module whose executors name a provider or operation its manifest does not
declare, or whose manifest declares an operation with no executor, naming the module and the
operation. The broker answers a module provider's tool as it does a forge's (state, connection, write
switch, budget row, deadline) and then:

- parses the arguments with the executor's schema (400 `invalid-arguments` naming the first issue);
- hands `run` the parsed arguments, the call's abort signal, the connection's account label and a
  vendor client, never the token. The client adds `Authorization: Bearer <token>` itself and sends
  only to `https` URLs on the default port of a host the provider declares in `apiHosts`
  (`vendor-host-refused`); it drops a module's own `Authorization` and `Host` headers, refuses
  redirects (`vendor-redirect-refused`), lets a read operation send only GET or HEAD
  (`vendor-method-refused`), reads at most 8 MiB of an answer and 4 KiB of an error body, maps a
  non-2xx status to `vendor-auth`, `vendor-not-found`, `vendor-conflict`, `vendor-rate-limited` or
  `vendor-error`, and scrubs the token out of an answer before it parses one, so even an echo of it
  never reaches the executor;
- races the run against the 30 s deadline, so a run that ignores its signal still answers 504
  `timeout`, and aborts what it started once the call is recorded;
- answers the result as JSON text, scrubbed of the token and cut to 64 KiB (`[truncated]` marks a
  cut).

## Audit rows

An action that changes whose account a vendor call runs under writes its audit row inside the
change's own transaction (`insertAuditEvent(tx)`) and logs it after the commit (`logAuditEvent`), so
a row the database refuses answers 500 with nothing changed, and a commit that fails leaves neither.
They are the admin's provider save (`integration.provider_config.update`, the OAuth client secret
included) and category default (`integration.category_default.update`); the user's own GitHub client
id (`integration.github_client.update`, whose user secret joins the transaction through the
service's `executor`); "Use as connection" and every sign-in (`integration.connection.create`,
`.reconnect`; a forge sign-in's Git credential, connection and row are one transaction); the
write switch (`integration.write_switch`); a repository's allow-list (`repository.integrations.update`);
and a repository's remote and its credential binding (`repository.remote.update`). The relink holds the
repository row `FOR NO KEY UPDATE`, which still serializes it with another relink and with the settings
routes' `FOR UPDATE` but does not block a new task's foreign-key insert while its git calls run; the wait for
that row is bounded (`boundedLockWait`), so a relink behind another answers 409 busy before any audit row or
git write. The general repository settings, tooling save, allow-list save and delete each bound their
own row take too; the allow-list key and the delete's task-creation key have their own bounds. These
waits are per statement, not one deadline for the whole request. Implicit row writers and worker
`FOR UPDATE` takes still wait behind the relink's git work (T516). It inserts the audit row, changes git, then writes the column. Each git call is cut at 10 s with
SIGTERM, and with SIGKILL only if the child is still alive 2 s later: git removes its `config.lock` on
SIGTERM and leaves it on SIGKILL (MEASURED with git 2.43.0 and 2.54.0), and a left lock fails every later write to that config. The route
puts git's remote back when the transaction fails: inside the transaction for a failure its callback sees (a
lost connection usually shows there too, as the next statement fails), and after the callback has settled
for a failure at COMMIT or a callback that ends without noticing, so exactly one restore runs, after the last
git write. A restore that fails is the answer the request gets, a lost connection notwithstanding. Once a git
deadline fires, its output is never accepted as a snapshot, even if the child exits cleanly in that
turn. A clean exit after a mutating deadline still triggers restoration. Reported git failures are
redacted structurally, including git's own password placeholder; the raw snapshot stays private for
restoration. A placeholder containing whitespace is a known redaction limit; neither measured git
version emits that form.

Worker writes of the same repository settings use `worker/src/audit.ts`: project-state sync
and take-theirs resolutions audit scope and agent rules; the legacy clone mirror import and
RAG source selection audit scope. Each inserts its row in the settings transaction, only for
changed columns, and logs after commit (including an import nested in the project-state writer's
preparation transaction). Metadata contains `source`, `actorKind` and `fields` (column names
only) plus the API's own keys for the action (`addedCount`/`removedCount` for scope, the
presence summary for agent rules; `host`, `credentialsChanged`, `branchChanged` for the remote),
never rule text, globs or other setting values. Task writes name the task user, conflict
answers name the resolving user, and unattended imports name the repository owner. Other portable
settings have no API audit action and do not gain one here.

Gate 4 writes the repository row when the checkout has no origin (the typed URL and the selected
credential replace what the row held, as before) or when the row has no remote. A row that already
has a remote, with an origin in the checkout, makes the push a one-off: no row lock, no write, and
the selected credential is used for that push only. Otherwise it takes a bounded `FOR NO KEY UPDATE` lock,
re-checks the row under it, and follows the relink's order: `repository.remote.update` row
(source `gate4_push`), an add-only `ensureOrigin` when the checkout has no origin, then the column
write, which also binds the selected credential when one was chosen. It removes only an origin it
added, on a callback or commit failure, after an in-flight callback settles; a failed restore is
the reported failure. Each git call is aborted after 10 s; the worker's abort sends SIGTERM to the
git process group and SIGKILL 1 s later (the relink waits 2 s), so a killed git can still leave a
`config.lock`. A Retry after a failed row write repairs the row from the checkout's origin, under
the lock and without touching git, but only when that origin still matches the one the form showed;
a changed origin is refused before any credential or row write, matching `taskRemoteUrl`'s rule that
a push approval binds to the address the user saw. Retries and matching values add no duplicate
audit row. A lock wait that times out fails the step with the database's message (the worker has no
409 mapping).

Disconnect (`integration.connection.disconnect`) is the one exception, on purpose: its row follows
the vendor revoke, which cannot be undone and whose outcome (`revoked`) the row records, so it stays
`recordAuditEvent` and a refused row is logged, not raised.
`api/test/integrations-audit-db.test.ts` pins both sides.

## Migrations

All guarded and idempotent. 0192 created the six tables and enums (its first line is the rollback).
0202 added `oauth_client_id` and the two partial unique keys (one connection per external account, one
per credential). 0206 added `task_integration_choices`, a preference's `connection_id`,
`repositories.integrations_restricted` and the partial unique keys for task and repository grants.
PostgreSQL truncates three integration foreign-key names over 63 characters (one in 0192, two in 0206)
with a NOTICE, which is harmless and still caught by the guard on a re-run. 0207 added the `running`
outcome (an enum value cannot be dropped, so an undo would have to leave it; the file states no undo),
`reason`, `duration_ms`, the invocation index and the stamp column. 0216 added
`repo_credentials.sign_in_account_id`, backfilled from the sign-in connections that back a
credential (one a disconnect left earlier stays unmarked), and 0217
`integration_connections.refresh_refused_at`; each is additive, and its header states the DROP COLUMN
that undoes it. The admin-default row is a
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
   row that recorded none); a client refusal keeps the status and stamps `refresh_refused_at`; a
   replaced issuing client writes `needs_reauth`; no configured client writes nothing.
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
18. An integration action's audit row is inserted in the change's own transaction and logged after
    the commit, so a refused row undoes the change; only disconnect's stays best-effort, because the
    revoke at the vendor before it cannot be undone.

## Composer capability overview

The task-type editor's selected step rows show each catalog or pinned prompt-template
requirement, its category, required/optional flag, requested access and the registered
providers that serve it. This is an installation/capability overview, not account admission:
it loads no accounts and makes no vendor call. New Task admission and dispatch remain the
authority for account choice, repository restrictions and execution; write operations still
require the task owner's write switch. Stored provider pins are explicitly unsupported.

The overview uses the existing authenticated provider/category reads and the admin task-type
catalog's module states. A disabled provider is distinct from a deactivated or missing module;
an unrecorded module provider is unverified. An unserved or removed category keeps its id,
and a stored malformed requirement remains visible for repair. Labels are literal text,
with unsafe control characters falling back to ids. Missing modules cannot supply invented
provider capabilities: only registered provider declarations are listed.

Provider/category/module metadata loads separately from the editable draft. Refresh re-reads
all three, shows loading/error instead of stale healthy install states, and never applies a
task-type row, clears dirty fields or changes saved-revision evidence. Category authoring can
load independently while a provider read fails or remains pending. Superseded overview and
initial-type reads ignore old replies; unmounted editors discard these reads and abort their requests. Each explicit refresh has a
15-second deadline, with no automatic retry. Installation state is a snapshot of these reads,
not a promise that it will remain unchanged before dispatch.
