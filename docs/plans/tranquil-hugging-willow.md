# Editor origin isolation (T613)

> Status: planned 2026-11-12, not started. Board: T613. Draft it supersedes: `.claude/tmp/codex-run/M2-S/codex-1/design.txt`.

## Context

The editor iframe runs code-server, and anything in its container (repository code, a process that replaces code-server on its port) can answer the editor's HTTP requests with its own HTML and script. That script runs in the browser at whatever origin serves `/ide`. Today that origin always holds the person's Haive session:

- **Cross-host** (web and api on different hostnames, #1079): `/ide` is proxied on the WEB origin (`apiEditorUrl`, `web/src/lib/api-client.ts:60`; `api-proxy.server.ts` maps `/ide/*`). The editor is same-origin with the app.
- **Same-host** (the default: `localhost:3000` / `localhost:3001`, or one internal hostname): the editor is on the API origin. NEW FINDING, not in the board text or the draft: the session cookies are host-only, so they reach every port of the hostname, and `trustedOrigins()` (`api/src/lib/request-origin.ts:22`) admits the api origin for state changes on purpose ("the editor it proxies runs there"). `isForeignOrigin` also passes any Origin equal to the request's own Host. So editor script on `:3001` can GET and POST every API route with the session. Same exposure, default install.

Owner decisions: separate editor hostname with a scoped handshake token (2026-11-11); single-host installs must keep working with no new setting (2026-11-12).

## Approach

One rule: **the editor origin never carries authority over the app.** The editor origin is `HAIVE_EDITOR_ORIGIN` when set, else the API's public origin (`publicApiOrigin`, `request-origin.ts`). In cross-host mode the API host is already a separate hostname with no Haive cookie on it, so the owner's "separate editor hostname" holds with no new setting and no new DNS. `HAIVE_EDITOR_ORIGIN` is an optional override (a dedicated `ide.<domain>`, or the one topology that cannot be isolated otherwise, below).

Three layers:

1. **The editor origin is not trusted for app routes.** `trustedOrigins` keeps the editor origin only for `/ide/*`. The request-host fallback in `isForeignOrigin` no longer passes an Origin equal to the editor origin on a non-`/ide` path. Every non-ide upgrade listener (`terminal.ts:37`, `cli-stream.ts:30`, `cli-login-banner.ts:281`) refuses the editor Origin the same way. This closes state changes from the editor in both modes.
2. **No session reads from the editor origin (Fetch Metadata).** A browser's `Sec-Fetch-Site` header is a W3C-specified forbidden header that script cannot set. The API refuses app-session auth (`requireAuth`, `authenticateUpgrade`) on non-`/ide` paths when `Sec-Fetch-Site: same-origin`. The web app reaches the api cross-origin in same-host mode (`same-site`) and is unaffected. The web proxy (`api-proxy.server.ts`) deletes incoming `sec-fetch-*` before forwarding, since in cross-host mode the app's own proxied calls are `same-origin` to the web host. A proxied request is still gated by Origin (layer 1) and by CORS on reads. Disabled, with a startup warning, when the editor origin equals the web origin (one reverse proxy serving both on one origin): there the app itself calls the api same-origin and nothing can tell the two apart; isolating that topology needs `HAIVE_EDITOR_ORIGIN`.
3. **`/ide` takes only a scoped editor session, never the app session.** This makes cross-host work (the API host has no app cookie) and keeps one code path for both modes.
   - Grant: `POST /tasks/:id/editor-handshake` and `POST /repos/:id/editor-handshake` (app origin, `requireAuth`, the ownership checks `ide.ts:121-137` already does). Mint 256-bit random secret; Redis key `editor-grant:<sha256>` → `{userId, tokenVersion, target, runtimeSessionId, editorOrigin}`, `PX 60000`. Minted after the ensure reports ready, so an image pull cannot outlive it. Response `Cache-Control: no-store`; returns `<editorOrigin>/ide/_handshake#<secret>` built only from config.
   - Redeem: `/ide/_handshake` on the editor origin serves a static bootstrap (CSP with script hash, `connect-src 'self'`, `Referrer-Policy: no-referrer`, `frame-ancestors <webOrigin>`) that clears the fragment with `history.replaceState`, POSTs the secret in the body to `/ide/_handshake`, then `location.replace`s to the editor path. The POST does `GETDEL` (single use), re-checks the user (active, tokenVersion, no forced password change, ownership), and sets the editor cookie. No new table: Redis is `noeviction` and single-use is atomic.
   - Editor session: a JWT signed with a key derived from the JWT secret (HMAC with a fixed label) so `verifyAccessToken` (`api/src/auth/jwt.ts`, which checks no token type) can never accept it. Claims: user, tokenVersion, target, runtimeSessionId, editorOrigin, `exp` = 8 h. Cookie: host-only, HttpOnly, `Path=/ide/<target>/`, runtime-specific name; `Secure; SameSite=None; Partitioned` on https, `SameSite=Lax` on http (localhost and same-site internal hosts). As strong as the app session it replaces: logout today revokes only the refresh token and the access JWT lives 1 day (`jwt.ts:36`); tokenVersion and deactivation revoke both.
   - Verify on HTTP and WS (`ide.ts:105` route auth and the upgrade at `:231`): signature, exp, target and runtime match the path, request authority equals the editor origin, user re-check through the existing `trackUserUpgrade` fence (`lib/user-sockets.ts`). The existing cookie stripping (`withoutSessionCookies`, `isSessionSetCookie`, `auth/cookies.ts`) adds the editor cookie names in both directions.
   - Web: `EditorTab` (`web/src/components/editor/editor-tab.tsx`) calls the handshake after the ensure and sets the iframe `src` to the bootstrap URL; `apiEditorUrl` returns the editor origin in both modes. Errors render through `MarkdownView`, no retry loop. The web `/ide/*` proxy (`app/ide/[...path]/route.ts`, the `/ide/` branch in `apiProxyTarget`) and `/api/haive/ide/*` are removed.
   - Logging: `ide.ts:282` logs `rawUrl`; switch to the pathname. Redact the handshake body field and the editor cookie in the shared logger.

Cross-host over plain http with hosts in different sites (e.g. single-label `haive` and `haive-api`): no browser sends a cookie to a cross-site iframe without `Secure`, so the editor answers with an operator message ("Serve the editor over HTTPS or from a hostname under the app's domain, or set HAIVE_EDITOR_ORIGIN.") instead of falling back to the web origin. Every same-host install and every same-site cross-host install keeps a working editor with no new setting.

## PRs (each its own review; order matters)

1. **api: editor origin carries no app authority** (layers 1 and 2, plus the web proxy dropping `sec-fetch-*`). Closes the same-host exposure alone. Undo: revert; nothing stored.
2. **api: editor handshake and editor session** (grant, redeem, bootstrap, verifier, HTTP and WS). `/ide` still also accepts the app session so the deployed web keeps working. Undo: revert; Redis grants expire in 60 s.
3. **web: open the editor through the handshake on the editor origin**; remove the web `/ide` and `/api/haive/ide` proxy. Deploy after PR 2. Undo: revert (PR 2's app-session acceptance still serves the old path).
4. **api: `/ide` stops accepting the app session.** Last, after PR 3 has shipped. Undo: revert.
5. **docs**: `sandbox.md` (editor proxy section, ~:202-221), `api-auth.md`, `session-recovery.md`, and the AGENTS.md origin paragraph that says the api origin is trusted because the editor runs there.

No migration in any PR.

## Verification

- PR 1 controls, red on main first: from Origin = api origin, a POST to `/tasks` and a terminal WS upgrade are refused; a GET to `/auth/me` with `Sec-Fetch-Site: same-origin` and a valid session is refused; `same-site` and absent headers pass; `/ide/*` from the editor origin passes; a proxied request with `Sec-Fetch-Site: same-origin` passes after the web proxy strips it. Extend `upgrade-origin.test.ts` and `upgrade-auth.test.ts`.
- PR 2: grant single-use under concurrency (two redeems, one wins), expiry, wrong user, target, runtime and authority refused, an app access token presented as the editor cookie refused, an editor JWT presented as `haive_access` refused, tokenVersion bump and deactivation refuse HTTP and an open WS, editor cookie stripped upstream and an upstream `Set-Cookie` for it dropped.
- PR 3 and 4: web unit tests for `EditorTab` and `apiEditorUrl`; then the browser through the real entry point (web origin → api → worker):
  - same-host: `localhost:3000` with the api on `:3001` (the dev stack as is);
  - cross-host, same site: `app.localhost` and `api.localhost` (browsers resolve `*.localhost` to loopback; no DNS);
  - check that the editor loads, its WebSocket stays up, two task tabs and a repository tab open, a reload re-handshakes, and from the editor iframe's devtools console `fetch('/tasks', {credentials:'include'})` and a fetch to the web `/api/haive/tasks` are both refused.
- Each PR: API and web package tests, typecheck, prettier; full suite once at the feature end.

## Residual, documented

- Browsers without Fetch Metadata (Safari before 16.4) can still read API GETs from the editor in same-host mode; writes are blocked by layer 1.
- All editors share one origin, so one runtime's editor can reach the person's other runtimes; per-runtime hostnames would be a separate decision.
- A web and api served on one origin need `HAIVE_EDITOR_ORIGIN` to be isolated; they keep working without it, with the startup warning.

## Open decisions for the owner (recommendation first)

1. Fix the same-host exposure too (PR 1). Recommended: it is the default install and needs no setting.
2. Default the editor origin to the API host, with `HAIVE_EDITOR_ORIGIN` optional, instead of the draft's "cross-host refuses the editor until the setting exists". Recommended: same-site cross-host installs keep a working, isolated editor with no new DNS.
3. Redis grant plus a derived-key JWT instead of the draft's two PostgreSQL tables. Recommended: no migration, single-use is atomic, revocation matches the app session. The tables are only worth it if a durable per-redemption audit row is wanted.
