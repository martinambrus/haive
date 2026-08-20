import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { userSecretsService } from '@haive/shared';
import type { StepContext } from '../../step-definition.js';
import { runnerExec } from '../../../sandbox/ddev-runner.js';
import { appRunnerExec } from '../../../sandbox/app-runner.js';

/* ------------------------------------------------------------------ */
/* Deterministic app login for browser testing.                        */
/*                                                                     */
/* Browser testing reached only what an app serves logged out, which    */
/* for most real apps is the login page. This logs the runner's headed  */
/* Chromium in ONCE, before any agent runs.                             */
/*                                                                     */
/* No agent is involved and no credential enters a prompt. That is the  */
/* whole point of doing it here: a natural-language login flow would    */
/* handle more shapes of login, but only by putting the password into a */
/* CLI provider's context and the stored transcript.                    */
/*                                                                     */
/* There is no session to save or restore. start-browser-desktop.sh     */
/* launches Chromium with a persistent --user-data-dir and is           */
/* idempotent, and every sandboxed CLI attaches chrome-devtools to that */
/* SAME browser over CDP — so one login is inherited by every later     */
/* agent in the task, cookie jar and all.                               */
/* ------------------------------------------------------------------ */

export interface AppAuthConfig {
  enabled: boolean;
  loginUrl: string;
  usernameSelector: string;
  passwordSelector: string;
  submitSelector: string;
  successCondition: { type: 'url_contains' | 'element_present'; value: string };
}

export interface AppLoginOutcome {
  /** Whether a login was attempted at all. False = not configured, or no credentials. */
  attempted: boolean;
  /** Whether the browser is now authenticated. Only ever true on a VERIFIED login. */
  ok: boolean;
  /** Why it did not happen, or did not work. Empty when ok. */
  reason: string;
}

/** The secret names a repository's app credentials live under. Per-repo rather than
 *  per-user: one user commonly onboards several apps. */
export function appAuthSecretNames(repositoryId: string): { username: string; password: string } {
  return {
    username: `app_auth:${repositoryId}:username`,
    password: `app_auth:${repositoryId}:password`,
  };
}

/** A config is usable only if every part of it is present. A half-filled config would
 *  make browser-login.js fail at a selector, which reads as "the login is broken"
 *  rather than "the login was never configured" — two different things to a user. */
export function isUsableAppAuth(raw: unknown): raw is AppAuthConfig {
  if (!raw || typeof raw !== 'object') return false;
  const c = raw as Record<string, unknown>;
  const str = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0;
  const cond = c.successCondition as Record<string, unknown> | undefined;
  return (
    c.enabled === true &&
    str(c.loginUrl) &&
    str(c.usernameSelector) &&
    str(c.passwordSelector) &&
    str(c.submitSelector) &&
    !!cond &&
    (cond.type === 'url_contains' || cond.type === 'element_present') &&
    str(cond.value)
  );
}

/** browser-login.js prints exactly one JSON line; anything else means it did not get
 *  far enough to report, which is a failed login rather than a successful one. */
export function parseLoginOutput(output: string): { ok: boolean; reason: string } {
  const lines = output
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.startsWith('{') || !line.includes('"ok"')) continue;
    try {
      const parsed = JSON.parse(line) as { ok?: unknown; reason?: unknown };
      return {
        ok: parsed.ok === true,
        reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      };
    } catch {
      // keep scanning older lines
    }
  }
  return { ok: false, reason: 'the login script produced no readable result' };
}

type Runtime =
  | { mode: 'ddev'; handle: Parameters<typeof runnerExec>[0] }
  | { mode: 'app-runner'; handle: Parameters<typeof appRunnerExec>[0] };

/**
 * Log the runner's browser into the app, if this repository has it configured.
 *
 * Never throws and never blocks: an unconfigured repo, a missing credential and a
 * refused login all return `ok: false` with a reason the caller reports. Browser
 * testing then proceeds against the logged-out app, which is what it did before this
 * existed — the caller's job is to TELL the tester which of the two it is getting.
 */
export async function loginAppBrowser(
  ctx: StepContext,
  runtime: Runtime,
): Promise<AppLoginOutcome> {
  const task = await ctx.db.query.tasks.findFirst({
    where: eq(schema.tasks.id, ctx.taskId),
    columns: { repositoryId: true },
  });
  if (!task?.repositoryId) return { attempted: false, ok: false, reason: 'task has no repository' };

  const repo = await ctx.db.query.repositories.findFirst({
    where: eq(schema.repositories.id, task.repositoryId),
    columns: { appAuth: true },
  });
  if (!isUsableAppAuth(repo?.appAuth)) {
    return { attempted: false, ok: false, reason: 'no app login configured for this repository' };
  }
  const cfg = repo.appAuth as AppAuthConfig;

  const names = appAuthSecretNames(task.repositoryId);
  const [username, password] = await Promise.all([
    userSecretsService.get(ctx.userId, names.username),
    userSecretsService.get(ctx.userId, names.password),
  ]);
  if (!username || !password) {
    return {
      attempted: false,
      ok: false,
      reason: 'app login is configured but its credentials are missing from the secret store',
    };
  }

  // The config goes in the command string (it is not secret); the credentials go in the
  // environment (they are). Single-quoted with any embedded quote escaped, because a
  // selector legitimately contains quotes — `input[name="user"]` is ordinary.
  const json = JSON.stringify(cfg).replaceAll("'", `'\\''`);
  const env = { HAIVE_APP_USERNAME: username, HAIVE_APP_PASSWORD: password };

  try {
    const output =
      runtime.mode === 'ddev'
        ? (
            await runnerExec(runtime.handle, `node /opt/browser-login.js '${json}'`, {
              timeoutMs: 90_000,
              env,
            })
          ).output
        : (
            await appRunnerExec(runtime.handle, `node /opt/browser/browser-login.js '${json}'`, {
              timeoutMs: 90_000,
              env,
            })
          ).output;
    const parsed = parseLoginOutput(output);
    return { attempted: true, ok: parsed.ok, reason: parsed.reason };
  } catch (err) {
    return {
      attempted: true,
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/** What the tester is told about the session it inherits.
 *
 *  Stated either way, and never left to inference: a tester that assumes it is logged
 *  in reports a login wall as a bug, and one that assumes it is not wastes its budget
 *  logging in by hand. */
export function appAuthPromptLines(outcome: AppLoginOutcome): string[] {
  if (outcome.ok) {
    return [
      'AUTHENTICATED SESSION: the browser has already been logged into this app for you, and',
      'the session is shared — do NOT log in again, and do NOT log out (it would take the',
      'session away from every later step too). If you nevertheless find yourself on a login',
      'page, say so in your findings rather than trying to authenticate.',
    ];
  }
  return [
    'UNAUTHENTICATED SESSION: the browser is NOT logged into this app, so anything behind a',
    'login is out of reach. Test what is reachable logged out, and report a login wall as a',
    'LIMIT ON YOUR COVERAGE rather than as a defect in the change.',
  ];
}
