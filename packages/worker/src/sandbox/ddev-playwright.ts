import { CONFIG_KEYS, configService, logger } from '@haive/shared';
import { DDEV_PROJECT_MOUNT, ddevExec, type DdevRunnerHandle } from './ddev-runner.js';

/**
 * Provision Playwright's browser runtime inside a task's DDEV web container.
 *
 * A DDEV web container is Debian plus ondrej PHP packages. It ships neither the browser
 * binaries nor the shared libraries they link against — MEASURED on `ddev/ddev-webserver`
 * behind task 681f0f99: `/home/ddev/.cache/ms-playwright` absent, and 13 of the 15 libraries
 * chromium needs missing (`libnss3`, `libnspr4`, `libatk1.0-0`, `libatk-bridge2.0-0`,
 * `libcups2`, `libdrm2`, `libxkbcommon0`, `libxcomposite1`, `libxdamage1`, `libxfixes3`,
 * `libxrandr2`, `libgbm1`, `libasound2`; only `libpango-1.0-0` and `libcairo2` present).
 * So a repo whose suite is Playwright could never run one test through 08b, and nothing in
 * the sandbox can fix that — the CLI is given ddev_status/logs/restart and no `ddev exec`.
 *
 * Two lifetimes, and the split is the whole design. `ddev restart` RECREATES the web
 * container, so anything in its writable layer is lost; `/home/ddev/.cache` is in that layer
 * (not a volume, not a symlink into the global cache). The browser binaries — hundreds of MB
 * — therefore go on the `ddev-global-cache` VOLUME, reached through a symlink at the path
 * Playwright already looks in, so nothing has to pass `PLAYWRIGHT_BROWSERS_PATH` and a human
 * running `ddev exec npx playwright test` by hand gets the same browsers. The apt packages
 * cannot be moved off the layer at all, so those are re-installed per container and guarded
 * by a marker in `/tmp` — which has exactly the right lifetime, the same trick 07c's migrate
 * marker uses.
 *
 * Chromium only. MEASURED: this project's own `--list` reports `[chromium]`, and it is the
 * default project in a stock `playwright.config`. `playwright install` cannot be told "what
 * this config needs" — naming no browser downloads all three — so a suite that drives firefox
 * or webkit is left to report the gap through 08b's degradedNote, which names the general
 * `npx playwright install --with-deps`.
 */

/** Where the browser binaries actually live: a DDEV volume, so they survive the container
 *  recreate that `ddev restart` performs on every reconcile. */
const SHARED_BROWSER_DIR = '/mnt/ddev-global-cache/ms-playwright';

/** Per-container marker that the apt dependencies have been installed. In `/tmp` because
 *  those packages live in the container's writable layer and die with it — a marker on the
 *  shared volume would outlive the thing it describes and skip the install that matters. */
const DEPS_MARKER = '/tmp/haive-playwright-deps';

/** apt plus a browser download on a cold container. Same budget as the selective test run,
 *  since this is the other thing that can legitimately take minutes. */
const PROVISION_TIMEOUT_MS = 600_000;

/** What the script uses for the two ways it can give up, so the caller names the cause
 *  without reading prose. Ours, not apt's or playwright's. */
const EXIT_NO_DEP_LIST = 3;
const EXIT_NO_DEP_RESOLVED = 4;

const log = logger.child({ module: 'ddev-playwright' });

export interface PlaywrightProvisionResult {
  /** False when the kill-switch is off — distinct from an attempt that failed. */
  attempted: boolean;
  ok: boolean;
  /** Runner output when something went wrong, for 08b's degradedNote. Null on success. */
  note: string | null;
}

/**
 * The provisioning script.
 *
 * `playwright install-deps` CANNOT be used, and that is measured rather than assumed: the
 * ddev web image is Debian trixie, which Playwright does not support, so it falls back to
 * its ubuntu20.04 package set and asks apt for `ttf-ubuntu-font-family`. That package does
 * not exist in Debian, and one unavailable name aborts the whole `apt-get install` — so the
 * command exits 0 having installed NOTHING and the next run still cannot launch a browser.
 *
 * So the list comes from Playwright itself (`install-deps --dry-run`, whose stated purpose is
 * to print the command) and each package is filtered by `apt-get install -s`, the
 * authoritative resolver rather than a name guess. That filter is the load-bearing part:
 * three names in the Ubuntu list are spelled differently in trixie — `libasound2`,
 * `libatk1.0-0` and `libfontconfig` are all `Candidate: (none)` there — and every one is a
 * library chromium actually needs. MEASURED, `apt-get install -s` resolves all three through
 * their t64/transitional providers and rejects only `ttf-ubuntu-font-family`, so the filter
 * drops exactly the package Debian genuinely lacks. Filtering on `apt-cache policy` instead
 * would have silently dropped three real dependencies and produced the broken browser this
 * function exists to prevent.
 *
 * Reading the list out of the dry-run is the one volatile dependency here, so it FAILS LOUD:
 * an extraction that yields nothing exits EXIT_NO_DEP_LIST rather than installing an empty
 * set and marking the container done.
 */
export function provisionScript(): string {
  return [
    'set -e',
    `mkdir -p ${SHARED_BROWSER_DIR}`,
    // Only link when nothing is there: a real directory means an earlier install already put
    // browsers in the container, and replacing it would delete them to gain nothing.
    'if [ ! -e "$HOME/.cache/ms-playwright" ]; then',
    '  mkdir -p "$HOME/.cache"',
    `  ln -s ${SHARED_BROWSER_DIR} "$HOME/.cache/ms-playwright"`,
    'fi',
    `if [ ! -f ${DEPS_MARKER} ]; then`,
    '  PW_DEPS=$(npx playwright install-deps --dry-run chromium 2>&1 |',
    '    sed -n "s/.*--no-install-recommends //p" | sed "s/\\"//g")',
    '  [ -n "$PW_DEPS" ] || exit ' + String(EXIT_NO_DEP_LIST),
    '  sudo -n apt-get update -qq',
    '  PW_OK=""',
    '  for p in $PW_DEPS; do',
    '    if sudo -n apt-get install -s -y --no-install-recommends "$p" >/dev/null 2>&1; then',
    '      PW_OK="$PW_OK $p"',
    '    fi',
    '  done',
    '  [ -n "$PW_OK" ] || exit ' + String(EXIT_NO_DEP_RESOLVED),
    '  sudo -n apt-get install -y --no-install-recommends $PW_OK',
    `  touch ${DEPS_MARKER}`,
    'fi',
    'npx playwright install chromium',
  ].join('\n');
}

/**
 * Kill playwright processes left behind in the web container by an ABANDONED run.
 *
 * `ddevExec` reaches the container through `docker exec`. Killing that client — a worker
 * restart, a job orphaned by BullMQ, a user Stop — does NOT kill the process it started
 * inside the container, and nothing else sweeps it. Two things then make the leftover
 * permanent rather than transient: a failed run under playwright's html reporter ends by
 * SERVING the report ("Serving HTML report at http://localhost:NNNNN. Press Ctrl+C to
 * quit."), which blocks forever, and its `globalSetup` cleanup keeps mutating the app.
 * MEASURED on task 681f0f99: three runs alive at once, the oldest 33 minutes past the
 * worker restart that abandoned it, interleaving cleanups against one app until logins
 * failed 210 times and Drupal's flood control locked the test accounts out.
 *
 * Safe as an unconditional pre-run sweep because the DDEV runner is PER TASK and only this
 * step starts tests in it, so anything already running when we are about to start is a
 * leftover by construction. Best-effort: a failure here is never worth failing a step for,
 * and the run that follows reports the truth either way.
 */
export function sweepScript(): string {
  return [
    // grep -c exits 1 on no match, so no `set -e` here — a clean container is the normal
    // path and must not read as an error.
    "n=$(ps -eo args | grep -cE '[p]laywright|[h]eadless_shell' || true)",
    'if [ "${n:-0}" -gt 0 ]; then sudo -n pkill -f playwright || true; sudo -n pkill -f headless_shell || true; fi',
    'echo "HAIVE_KILLED=${n:-0}"',
  ].join('\n');
}

export async function killStalePlaywrightRuns(handle: DdevRunnerHandle): Promise<number> {
  const encoded = Buffer.from(sweepScript(), 'utf8').toString('base64');
  try {
    const res = await ddevExec(handle, `exec bash -c "echo ${encoded} | base64 -d | bash"`, {
      timeoutMs: 60_000,
    });
    const killed = Number(/HAIVE_KILLED=(\d+)/.exec(res.output)?.[1] ?? 0);
    if (killed > 0) {
      log.warn({ container: handle.container, killed }, 'killed abandoned playwright processes');
    }
    return killed;
  } catch {
    return 0;
  }
}

/** What a non-zero exit means, so the note names the cause instead of quoting apt. */
export function failureReason(exitCode: number): string {
  if (exitCode === EXIT_NO_DEP_LIST) {
    return "could not read Playwright's own dependency list (install-deps --dry-run printed no apt command)";
  }
  if (exitCode === EXIT_NO_DEP_RESOLVED) {
    return 'none of the packages Playwright asked for could be resolved by apt in this image';
  }
  return `the provisioning script exited ${exitCode}`;
}

/**
 * Make chromium runnable in the web container, from the framework's own project root.
 *
 * Idempotent and safe to call before every run: with the marker present and the browser
 * already on the volume both halves are no-ops. Never throws — an environment we could not
 * repair is exactly the case 08b's environment classifier exists to report, and a throw here
 * would fail the step instead of naming the gap.
 *
 * The script is shipped base64-encoded because `ddevExec` interpolates its argument into a
 * `bash -lc` running in the RUNNER: a plain script would have `$HOME` and `$(…)` evaluated
 * there and shipped as literals into the web container — a silent mis-target rather than an
 * error. Base64 contains nothing either shell can interpret, so exactly the bytes written
 * above are what run.
 */
export async function ensureDdevPlaywrightBrowsers(
  handle: DdevRunnerHandle,
  root: string,
): Promise<PlaywrightProvisionResult> {
  if (!(await configService.getBoolean(CONFIG_KEYS.TEST_BROWSER_PROVISION_ENABLED, true))) {
    return { attempted: false, ok: false, note: null };
  }
  const dir = root ? ` -d ${DDEV_PROJECT_MOUNT}/${root}` : '';
  const encoded = Buffer.from(provisionScript(), 'utf8').toString('base64');
  try {
    const res = await ddevExec(handle, `exec${dir} bash -c "echo ${encoded} | base64 -d | bash"`, {
      timeoutMs: PROVISION_TIMEOUT_MS,
    });
    if (res.exitCode === 0) {
      log.info({ container: handle.container, root }, 'playwright browsers provisioned');
      return { attempted: true, ok: true, note: null };
    }
    return {
      attempted: true,
      ok: false,
      note: `${failureReason(res.exitCode)}\n${res.output.slice(-2000)}`,
    };
  } catch (err) {
    return { attempted: true, ok: false, note: err instanceof Error ? err.message : String(err) };
  }
}
