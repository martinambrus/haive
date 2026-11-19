/** Which repair actually fixes a provider whose usage token the poller found dead.
 *
 *  Three different repairs hide behind the single `needs_reconnect` status, and pointing a
 *  user at the wrong one is worse than saying nothing: codex has no API token to replace, it
 *  is fixed by re-running its interactive CLI login. The decision lives here so the three
 *  surfaces that render the prompt — the tasks-list strip, the task-detail chip and the CLI
 *  providers list — cannot drift apart, the same reason `step-banners.ts` exists.
 */

import type { CliAuthMode, CliAuthStatus, CliProvider, CliProviderName } from '@/lib/api-client';

export type UsageReconnectFix = 'usage-oauth' | 'cli-login' | 'api-token';

/** Providers with an interactive login flow in Haive (the "Log in" button on the CLI
 *  providers page). NOT the shared catalog's `supportsCliAuth`, which is also true for
 *  BYOK-only providers and so names a wider set than the ones that can be logged in here. */
export const CLI_LOGIN_PROVIDERS: CliProviderName[] = [
  'claude-code',
  'codex',
  'amp',
  'antigravity',
  // grok: device-code login for a SuperGrok subscription. This list is the WEB's own copy of
  // the api's SUPPORTED_PROVIDERS (cli-login-banner) and every login affordance is gated on
  // it — the Log in button on the detail page, the list page and the Test-connection card,
  // plus Sign out and the "Not logged in" prompt. Adding a provider to the api side alone
  // leaves a row that probes `auth_expired` with no way to act on it, which is exactly what
  // happened here. Keep the two lists moving together.
  'grok',
];

/** Auth states a fresh interactive login repairs. `unknown` is what a sign-out writes to the
 *  row (and what a never-tested row holds): nobody is logged in, so Log in is the next step. */
const LOGIN_RECOVERABLE: readonly CliAuthStatus[] = [
  'unknown',
  'auth_expired',
  'auth_denied',
  'unknown_error',
  'timeout',
];

/** What the Log in decision reads of a provider row. */
type LoginRow = Pick<
  CliProvider,
  'id' | 'userId' | 'name' | 'authMode' | 'isolateAuth' | 'authStatus' | 'authLastCheckedAt'
>;

function checkedAt(row: LoginRow): number {
  const at = row.authLastCheckedAt ? Date.parse(row.authLastCheckedAt) : Number.NaN;
  return Number.isNaN(at) ? 0 : at;
}

/** CLIs whose subscription login is a token saved on the row it was made on, not a file in
 *  the auth volume that rows share. A login through one such row logs no other row in. This
 *  is the web's copy of the worker's rule: its sign-out deletes the login token of the one
 *  row it ran on, and each run reads the token of its own row. */
const ROW_LOGIN_PROVIDERS: readonly CliProviderName[] = ['claude-code'];

/** A row's stored auth status as its login really stands, for `cliLoginOffered`.
 *
 *  For most CLIs the login is a file in an auth volume, and rows that are not isolated share
 *  one volume per user, CLI and auth mode. A sign-out resets every one of them, but a login
 *  or a Test writes only the row it ran on, so after logging in through one row its siblings
 *  still say `unknown` about a login that works. A sibling that checked ok after this row
 *  was last written is the newer word on that shared login. An isolated row, and a row of a
 *  CLI that keeps its login on the row, speaks for itself. */
export function storedLoginStatus(row: LoginRow, rows: readonly LoginRow[]): CliAuthStatus {
  if (row.isolateAuth || ROW_LOGIN_PROVIDERS.includes(row.name)) return row.authStatus;
  const own = checkedAt(row);
  const newerOk = rows.some(
    (other) =>
      other.id !== row.id &&
      !other.isolateAuth &&
      other.userId === row.userId &&
      other.name === row.name &&
      other.authMode === row.authMode &&
      other.authStatus === 'ok' &&
      checkedAt(other) > own,
  );
  return newerOk ? 'ok' : row.authStatus;
}

/** Whether a provider's surfaces offer Log in. A fresh Test result wins when there is one;
 *  without it a subscription row's stored status decides (pass it through
 *  `storedLoginStatus`). Reading only the Test result left the button missing after a
 *  sign-out, which clears that result and writes `unknown` to the row, until the user ran
 *  Test to rediscover what the row already said. An api_key row's `unknown` says nothing
 *  about a login, so the row alone never offers it there. A dead usage token offers it only
 *  for a CLI whose usage a login repairs. */
export function cliLoginOffered(input: {
  name: CliProviderName;
  authMode: CliAuthMode;
  testStatus: CliAuthStatus | undefined;
  rowStatus: CliAuthStatus | null | undefined;
  usageTokenDead: boolean;
}): boolean {
  if (!CLI_LOGIN_PROVIDERS.includes(input.name)) return false;
  // A dead usage token is itself the evidence, but only where a login is what repairs it:
  // claude-code's meters run on a separate usage-OAuth token with its own Reconnect.
  if (input.usageTokenDead && usageReconnectFix(input.name) === 'cli-login') return true;
  const status =
    input.testStatus ?? (input.authMode === 'subscription' ? input.rowStatus : undefined);
  return status != null && LOGIN_RECOVERABLE.includes(status);
}

/** claude-code first even though it is also a CLI-login provider: its usage meters run on a
 *  separately-minted usage-OAuth token, so re-running `claude login` would not touch the
 *  credential that died. */
export function usageReconnectFix(name: CliProviderName | null | undefined): UsageReconnectFix {
  if (name === 'claude-code') return 'usage-oauth';
  return name && CLI_LOGIN_PROVIDERS.includes(name) ? 'cli-login' : 'api-token';
}

/** Deep link that lands on the control which performs the repair, not merely on the
 *  provider's page — dropping a user on an edit form when what they need is a login button is
 *  the same failure as naming the wrong repair. `#usage-tracking` is ClaudeUsageAuth's card
 *  (claude-code only), `#cli-login` is the Test-connection card that carries the Log in
 *  button, and `#secrets` is the credential textarea an api-token provider is fixed in.
 *
 *  This is the FALLBACK path, not the main one: UsageReconnectAction pre-empts a plain click
 *  on the two fixes that have an in-product flow and runs it in place, so these URLs are what
 *  a middle-click / open-in-new-tab resolves to, plus the whole story for api-token. */
export function usageReconnectHref(
  providerId: string,
  name: CliProviderName | null | undefined,
): string {
  const base = `/cli-providers/${providerId}`;
  switch (usageReconnectFix(name)) {
    case 'usage-oauth':
      return `${base}#usage-tracking`;
    case 'cli-login':
      return `${base}#cli-login`;
    case 'api-token':
      return `${base}#secrets`;
  }
}

/** Tooltip naming the repair. `newTab` is the calling surface's business: the strip and the
 *  task-detail chip open the settings page with target="_blank", the providers list is
 *  already on it. */
export function usageReconnectHint(
  label: string | null | undefined,
  name: CliProviderName | null | undefined,
  opts?: { newTab?: boolean },
): string {
  const who = label ?? 'This CLI';
  const tab = opts?.newTab ? ' in a new tab' : '';
  switch (usageReconnectFix(name)) {
    case 'usage-oauth':
      return `${who} usage token expired — open its Usage tracking${tab} to reconnect and restore its meters.`;
    case 'cli-login':
      return `${who} usage token was rejected — open its settings${tab} and use Log in to restore its meters.`;
    case 'api-token':
      return `${who} usage token was rejected — open its settings${tab} and replace its API token to restore its meters.`;
  }
}
