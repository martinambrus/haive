import type { TestFramework } from './08b-test-management.js';

/**
 * Classifier for a test run that failed because the ENVIRONMENT cannot run tests, as
 * opposed to because the tests are wrong.
 *
 * 08b already had a stand-down guard for this, built on `playwright test --list`: a
 * non-zero exit there means the runner could enumerate nothing, so no fix pass can act.
 * That guard is structurally blind to a whole class of failure. Playwright 1.54.1's
 * `lib/runner/runner.js` builds the list task set as `createLoadTask` +
 * `createReportBeginTask` and puts `createGlobalSetupTasks` only in the non-list branch,
 * so `--list` never runs globalSetup. MEASURED against the live container behind task
 * 681f0f99: the real run died in globalSetup at `chromium.launch()` while
 * `npx playwright test --list <spec>` exited 0 and listed 50 tests. The guard never fired,
 * and five fix agents each independently re-derived "the browser binaries are not
 * installed" and wrote it into a field nothing read — three rounds running.
 *
 * So this reads the RUN's own output instead, keyed on error IDs the runner raises itself.
 * Playwright only, deliberately: the same discipline `buildCollectCommand` already states
 * for its list mode — adding a framework means measuring what it prints first, not assuming
 * it behaves like this one. Everything else returns null and keeps the previous behaviour.
 */
export interface TestEnvBlocker {
  /** What is wrong with the environment, in the words shown to a human. */
  reason: string;
  /** The command that repairs it, bare — the caller prefixes its own invocation. */
  repair: string;
}

/**
 * Playwright's own errors for "this machine cannot run a browser", both read out of the
 * installed `playwright-core` rather than taken from docs:
 *
 * - `Executable doesn't exist at` — `lib/server/registry/index.js`, the registry's throw
 *   when a browser build is absent from the cache.
 * - `Host system is missing dependencies` — `lib/server/registry/dependencies.js`, raised
 *   for the shared libraries a downloaded browser links against.
 *
 * Both are format strings in playwright's source, not prose it composes per case, which is
 * what makes them safe to match. The decorative "Looks like Playwright Test or Playwright
 * was just installed" box is deliberately NOT matched — that one is presentation.
 */
const PLAYWRIGHT_BLOCKERS: ReadonlyArray<{ marker: RegExp; reason: string; repair: string }> = [
  {
    marker: /Executable doesn't exist at/,
    reason:
      'the Playwright browser binaries are not installed where the runner looks for them, so ' +
      'the run aborted before any test executed',
    repair: 'npx playwright install --with-deps',
  },
  {
    marker: /Host system is missing dependencies/,
    reason:
      'the Playwright browser is installed but the host is missing the shared libraries it ' +
      'links against, so it could not be launched',
    repair: 'npx playwright install-deps',
  },
];

/**
 * Why the environment could not run these tests, or null when the failure is not one we
 * can name — in which case the caller keeps whatever it did before.
 *
 * The executable check is tested first: when a browser is absent BOTH errors can appear in
 * one output, and `--with-deps` repairs both, so reporting the missing binary is the
 * complete answer while reporting only the missing libraries is not.
 */
export function classifyTestEnvFailure(
  framework: TestFramework | null,
  output: string,
): TestEnvBlocker | null {
  if (framework !== 'playwright') return null;
  for (const blocker of PLAYWRIGHT_BLOCKERS) {
    if (blocker.marker.test(output)) {
      return { reason: blocker.reason, repair: blocker.repair };
    }
  }
  return null;
}
