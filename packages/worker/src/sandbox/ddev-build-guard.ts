import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { DDEV_NGINX_INCLUDE_PREFIX } from './ddev-nginx-include-guard.js';
import { DDEV_ENTRYPOINT_PREFIX } from './ddev-entrypoint-guard.js';

/**
 * Pre-flight check that the project's own DDEV image-build inputs can build at all, plus
 * the classifier that decides whether a build failure is the implementing agent's to fix.
 *
 * DDEV splices `.ddev/web-build/Dockerfile*` and `.ddev/db-build/Dockerfile*` verbatim into
 * the Dockerfiles it generates (`### From user Dockerfile <path>:`), so ONE bad line there
 * makes every later `ddev start`/`ddev restart` die in the image build — permanently, because
 * a retry re-runs the same build against the same file.
 *
 * The line that reached production was `RUN docker-php-ext-install mysql`, written by an
 * implementing agent that reasoned "compiled route, not apt". `docker-php-ext-install` ships
 * with the official `php:*` Docker images; `ddev/ddev-webserver` is Debian plus ondrej
 * packages and has never carried it, so the build died with exit 127 six minutes into a
 * three-hour task (task 4fad0c4f). The extension was already there — `php -m` on that very
 * image lists mysql, mysqli, mysqlnd and pdo_mysql.
 *
 * Two file reads turn that into an instant failure. The message is also what the "Retry with
 * AI" fix agent receives as its prior error, so it has to read as an instruction naming the
 * DDEV-native mechanism, not as a diagnosis.
 *
 * Deliberately lenient, for the same reason as the healthcheck guard: a false "broken"
 * verdict blocks a working environment, while a false "fine" only returns us to the build
 * failure we already had. So only commands verified absent from the image are flagged, and
 * a line that cannot fail the build (`|| true`) is ignored.
 */

/** Prefix on every message this module produces. Ours, not DDEV's or BuildKit's, so the
 *  fix-loop classifier below can key on it without depending on anyone else's wording. */
export const DDEV_BUILD_INPUT_PREFIX = 'DDEV image-build inputs are invalid:';

const PHP_EXTENSION_ADVICE =
  'DDEV builds the web container from `ddev/ddev-webserver` — Debian with ondrej PHP ' +
  'packages, not an official `php:*` image — so the `docker-php-ext-*` helpers and `pecl` ' +
  'are not installed there. Most standard extensions (mysql, mysqli, pdo_mysql, gd, curl, ' +
  'intl, …) are already compiled in, so check whether you need to add anything at all. To ' +
  'add a real one, set `webimage_extra_packages: ["php${DDEV_PHP_VERSION}-<ext>"]` in ' +
  '.ddev/config.yaml, or run `apt-get update && apt-get install -y ' +
  'php${DDEV_PHP_VERSION}-<ext>` from the build Dockerfile.';

const DEBIAN_ADVICE =
  "DDEV's images are Debian-based, so Alpine's `apk` does not exist in them. Install " +
  'packages with `webimage_extra_packages` / `dbimage_extra_packages` in .ddev/config.yaml, ' +
  'or `apt-get update && apt-get install -y <package>`.';

/** Commands verified absent from `ddev/ddev-webserver` (probed on v1.25.3: every one of
 *  these answers `command not found`, while `apt-get` is present). These are stable facts
 *  about which base image DDEV builds from, not version-bound trivia — the `docker-php-*`
 *  family belongs to the official `php:*` images and `apk` to Alpine, and DDEV has never
 *  been either. A command missing from this map is simply not caught; the build failure it
 *  causes is then classified by {@link isDdevBuildInputFailure} instead. */
const ABSENT_COMMANDS = new Map<string, string>([
  ['docker-php-ext-install', PHP_EXTENSION_ADVICE],
  ['docker-php-ext-enable', PHP_EXTENSION_ADVICE],
  ['docker-php-ext-configure', PHP_EXTENSION_ADVICE],
  ['docker-php-source', PHP_EXTENSION_ADVICE],
  ['pecl', PHP_EXTENSION_ADVICE],
  ['apk', DEBIAN_ADVICE],
]);

/** The directories DDEV splices into its generated image Dockerfiles. */
const BUILD_DIRS = ['web-build', 'db-build'];

/** `Dockerfile` and `Dockerfile.<suffix>` are included in the build; `Dockerfile.example`
 *  is DDEV's own inert sample — the generated `.ddev/.gitignore` excludes every `*.example`
 *  and DDEV never splices one into the image. */
export function isBuildDockerfile(name: string): boolean {
  return name === 'Dockerfile' || (name.startsWith('Dockerfile.') && !name.endsWith('.example'));
}

/** First real command word of one shell segment, or null when the segment has none.
 *  Skips `VAR=value` prefixes and the wrappers that put the actual command later
 *  (`sudo apt-get …`), and reduces a path to its basename so `/usr/local/bin/pecl` is
 *  recognised as `pecl`. */
function firstCommandToken(segment: string): string | null {
  for (const raw of segment.trim().split(/\s+/)) {
    const word = raw.replace(/^["']|["']$/g, '');
    if (!word) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
    if (word === 'sudo' || word === 'command' || word === 'exec') continue;
    return path.posix.basename(word);
  }
  return null;
}

/**
 * Every command a Dockerfile's `RUN` lines will actually execute, in order.
 *
 * Handles `\` continuations, `&&`/`||`/`;`/`|` chains, `VAR=value` prefixes and the JSON
 * exec form. Comment lines are dropped, and so is any `RUN` ending in `|| true` / `|| :` —
 * that line cannot fail the build, so flagging it would block a working environment.
 */
export function dockerfileRunCommands(text: string): string[] {
  const logical: string[] = [];
  let buffer = '';
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (buffer === '' && /^\s*#/.test(line)) continue;
    const continued = /\\\s*$/.test(line);
    const piece = line.replace(/\\\s*$/, '').trim();
    buffer = buffer ? `${buffer} ${piece}` : piece;
    if (continued) continue;
    if (buffer) logical.push(buffer);
    buffer = '';
  }
  if (buffer) logical.push(buffer);

  const commands: string[] = [];
  for (const line of logical) {
    const run = /^run\s+(.*)$/i.exec(line);
    if (!run) continue;
    const body = run[1]!.trim();
    if (/\|\|\s*(true|:)\s*$/.test(body)) continue;
    if (body.startsWith('[')) {
      // JSON exec form: RUN ["executable", "arg"]. A malformed array is not ours to report.
      try {
        const parsed: unknown = JSON.parse(body);
        if (Array.isArray(parsed) && typeof parsed[0] === 'string') {
          commands.push(path.posix.basename(parsed[0]));
        }
      } catch {
        /* not our error to raise */
      }
      continue;
    }
    for (const segment of body.split(/&&|\|\||;|\|/)) {
      const token = firstCommandToken(segment);
      if (token) commands.push(token);
    }
  }
  return commands;
}

export interface DdevBuildFile {
  /** Repo-relative path, e.g. `.ddev/web-build/Dockerfile` — quoted back to the agent. */
  name: string;
  content: string;
}

/** First command in these Dockerfile contents that the image does not have, with its advice.
 *  The single place the ABSENT_COMMANDS map is consulted, so the pre-flight check and the
 *  spec check below can never disagree about what counts as broken. */
function findAbsentCommand(content: string): { command: string; advice: string } | null {
  for (const command of dockerfileRunCommands(content)) {
    const advice = ABSENT_COMMANDS.get(command);
    if (advice) return { command, advice };
  }
  return null;
}

/** Reason the next image build will fail with "command not found", or null when none of
 *  the build inputs reaches for a command the image does not have. */
export function findDdevBuildBreakage(files: DdevBuildFile[]): string | null {
  for (const file of files) {
    const hit = findAbsentCommand(file.content);
    if (hit) {
      return (
        `${DDEV_BUILD_INPUT_PREFIX} ${file.name} runs \`${hit.command}\`, which is not installed ` +
        `in the image DDEV builds from, so the build fails with "command not found" ` +
        `(exit 127) on every start. ${hit.advice}`
      );
    }
  }
  return null;
}

/** Fenced code blocks in a markdown document — body only, language tag ignored. */
const MD_FENCE_RE = /^```[^\n]*\n(.*?)^```/gms;

/**
 * A spec that PRESCRIBES a command the DDEV web image does not have, or null when it does not.
 *
 * Same parser as the pre-flight check, applied to each fenced code block, so the test is "this
 * document contains a RUN line calling an absent command" — not "this document mentions the
 * command". That distinction is the entire point. The corrected spec for the failure that
 * motivated this check names `docker-php-ext-install` three times, in prose and as a deliberately
 * wrong quiz answer, precisely to warn against it; flagging that would punish the fix.
 *
 * Deliberately partial: it catches the fenced Dockerfile snippet an implementing agent copies,
 * not the same command inside a mermaid diagram or a prose checklist, neither of which is a RUN
 * line. One finding is enough to route the spec to the corrector, which then fixes the rest.
 *
 * Reported with its own wording rather than DDEV_BUILD_INPUT_PREFIX: that prefix is what
 * isDdevBuildInputFailure classifies as an agent-fixable RUNTIME failure, and a spec finding is
 * not a bring-up failure.
 */
export function findDdevSpecBreakage(specText: string): string | null {
  for (const match of specText.matchAll(MD_FENCE_RE)) {
    const hit = findAbsentCommand(match[1] ?? '');
    if (hit) {
      return (
        `The spec prescribes \`${hit.command}\` in a build Dockerfile, which does not exist in ` +
        `the image DDEV builds from — following it fails the image build with "command not ` +
        `found" (exit 127) on every \`ddev start\`, and no later step can undo a spec. ` +
        `${hit.advice} Amend the spec so it does not prescribe this command.`
      );
    }
  }
  return null;
}

/**
 * Read the workspace and apply {@link findDdevBuildBreakage}.
 *
 * Returns null when nothing is wrong, when there are no build directories, or when the tree
 * cannot be read — an unreadable workspace is the boot's problem to report, not this check's.
 */
export async function checkDdevBuildInputs(workspace: string): Promise<string | null> {
  const files: DdevBuildFile[] = [];
  for (const dir of BUILD_DIRS) {
    const abs = path.join(workspace, '.ddev', dir);
    const names = await readdir(abs).catch(() => null);
    if (names === null) continue;
    for (const name of names.filter(isBuildDockerfile).sort()) {
      const content = await readFile(path.join(abs, name), 'utf8').catch(() => null);
      if (content !== null) files.push({ name: `.ddev/${dir}/${name}`, content });
    }
  }
  return findDdevBuildBreakage(files);
}

/** VOLATILE: BuildKit's failure wording, not a contract. A miss only costs us today's
 *  behaviour (the step fails outright instead of looping back), never correctness, so it
 *  degrades gracefully — same trade as isDdevVersionConstraintFailure in ddev-runner. */
const BUILDKIT_FAILURE_RE = /did not complete successfully: exit code:|failed to solve/i;

/**
 * True when a DDEV bring-up failed inside the container image BUILD.
 *
 * That is the one class of DDEV failure the implementing agent can fix on its own, which is
 * why 07c-ddev-reconcile routes it back to implementation instead of failing the task: the
 * only mutable build inputs are the project's own `web-build`/`db-build` Dockerfiles and the
 * `*image_extra_packages` lists, all of them agent-authored. DDEV's own generated Dockerfile
 * carries `#ddev-generated` and is mounted read-only, so it cannot be the culprit.
 *
 * Host-level failures — an unsatisfiable `ddev_version_constraint`, a port collision, a
 * healthcheck timeout, a reaped container — never produce a BuildKit error and so keep the
 * hard-fail path that exposes Retry / Retry with AI. Our own pre-flight prefix counts too:
 * it is raised for exactly the same agent-authored files, before the build is even attempted.
 *
 * Caveat: callers truncate DDEV's output (07c keeps the last 1500 chars), so a build error
 * buried under a long tail can fall outside the text this sees. It then classifies as
 * host-level and hard-fails, which is the pre-existing behaviour rather than a new one.
 */
export function isDdevBuildInputFailure(errorMessage: string): boolean {
  return errorMessage.includes(DDEV_BUILD_INPUT_PREFIX) || BUILDKIT_FAILURE_RE.test(errorMessage);
}

/** Fatal, config-caused errors from the daemons inside the web/db containers, keyed on ERROR
 *  IDs and fatal-level tags rather than on prose: nginx's `[emerg]` level, apache's AH00526,
 *  php-fpm's configuration-load failure and its pool-fatal form. Each one means a file the
 *  implementation authored under `.ddev/` is wrong. They only ever appear here because
 *  `ddevFailureMessage` captures the container logs into the error — DDEV's own output never
 *  contains them. */
const CONTAINER_CONFIG_ERROR_RE =
  /nginx: \[emerg\]|AH00526|Syntax error on line \d+ of|failed to load configuration file|\[pool [^\]]*\] cannot/i;

/** The `[emerg]` shapes nginx raises for HOST problems rather than for the project's config:
 *  a port already bound, a privilege it lacks. Editing `.ddev/` cannot fix those, so they
 *  keep the hard-fail path. This exclusion is deliberately the conservative direction — a
 *  wrong "agent-fixable" burns a whole fix round, while a wrong "host-level" only returns us
 *  to the behaviour we already had. */
const CONTAINER_HOST_LEVEL_RE = /bind\(\) to |Address already in use|Permission denied/i;

/** True when a DDEV bring-up failed because a webserver/PHP config the implementation wrote
 *  was rejected by the container, as proven by the captured container logs. */
export function isDdevContainerConfigFailure(errorMessage: string): boolean {
  return (
    CONTAINER_CONFIG_ERROR_RE.test(errorMessage) && !CONTAINER_HOST_LEVEL_RE.test(errorMessage)
  );
}

/**
 * Every DDEV failure the implementing agent can fix on its own, and therefore the whole of
 * what 07c-ddev-reconcile routes back to implementation: a bad image-build input, a
 * webserver/PHP config the container refused to load, the nginx include guard's verdict, or
 * a web-entrypoint script that cannot run unprivileged.
 *
 * Everything else — an unsatisfiable version constraint, a port collision, a reaped runner,
 * an OOM — keeps the hard-fail path that exposes Retry / Retry with AI, because looping the
 * implementation step would burn a round to arrive at exactly the same failure.
 */
export function isDdevAgentFixableFailure(errorMessage: string): boolean {
  return (
    isDdevBuildInputFailure(errorMessage) ||
    isDdevContainerConfigFailure(errorMessage) ||
    errorMessage.includes(DDEV_NGINX_INCLUDE_PREFIX) ||
    errorMessage.includes(DDEV_ENTRYPOINT_PREFIX)
  );
}
