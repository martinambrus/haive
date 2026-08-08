import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';

/**
 * Pre-flight check that the YAML files DDEV loads at start can be PARSED at all.
 *
 * DDEV reads `.ddev/config.yaml`, every `.ddev/config.*.yaml` override and every
 * `.ddev/docker-compose.*.yaml` before it creates a single container, so one syntax error
 * in any of them fails `ddev start` outright — permanently, because a retry re-reads the
 * same file. Task fcf03ead is the shape: the round-3 implementation agent wrote a
 * post-start hook as a bare YAML scalar,
 *
 *     - exec: chmod 0755 … || (echo 'WARN: chmod failed' >&2; true)
 *
 * where the `: ` inside `'WARN: chmod failed'` opens a nested mapping (the single quotes
 * are literal characters, not YAML quoting, because the scalar already started at `chmod`).
 * DDEV answered with `go-yaml load error in scanner at L14.C143: mapping values are not
 * allowed in this context`, which is precise but names neither the rule that was broken nor
 * the fix — and, classified as a host-level failure, hard-failed an 11-hour task that still
 * had two of its five fix rounds left.
 *
 * The value here is NOT speed: that `ddev start` failed in ten seconds. It is that the
 * verdict becomes ours. {@link DDEV_CONFIG_YAML_PREFIX} is a contract this repo owns, so
 * `isDdevAgentFixableFailure` can route the failure back to the implementing agent without
 * keying on DDEV's prose, and the message can carry the quoting rule the fix agent needs.
 *
 * No repair: rewriting an agent's config behind its back trades one silent failure for
 * another (same call as the healthcheck, build-input and nginx guards).
 */

/** Prefix on every message this module produces. Ours, not DDEV's or go-yaml's, so the
 *  fix-loop classifier can key on it without depending on anyone else's wording. */
export const DDEV_CONFIG_YAML_PREFIX = 'DDEV config is not valid YAML:';

/** The file names DDEV itself parses, per its own globs. A file outside these is never
 *  loaded at start, so a syntax error in it cannot fail the boot and flagging it would
 *  block a working environment. DDEV's OWN generated compose files are `.ddev-docker-
 *  compose-*.yaml` — leading dot, no match — so they are never re-judged here. */
const DDEV_PARSED_NAMES = [/^config\.yaml$/, /^config\..+\.yaml$/, /^docker-compose\..+\.yaml$/];

/** True for a `.ddev/` file name DDEV loads and parses at start. */
export function isDdevParsedYaml(name: string): boolean {
  return DDEV_PARSED_NAMES.some((re) => re.test(name));
}

/**
 * Parse errors that are NOT a syntax defect both parsers would agree on, and are therefore
 * ignored.
 *
 * DDEV parses with go-yaml, we parse with `yaml` (JS). At the syntax level the two agree;
 * where they diverge is exactly this list — duplicate keys and multi-document streams are
 * accepted, rejected or first-wins depending on the library and its options, and a key
 * length limit is this library's alone. Flagging one of those would block an environment
 * that boots fine, which is the one outcome this guard must never produce. Every other code
 * the parser can emit is a scanner/composer error: text that is not YAML in any parser.
 */
const IGNORED_ERROR_CODES = new Set(['DUPLICATE_KEY', 'MULTIPLE_DOCS', 'KEY_OVER_1024_CHARS']);

/** The rule that breaks these files in practice, phrased as an instruction rather than a
 *  diagnosis — this text is what the "Retry with AI" fix agent receives as its prior error. */
const SCALAR_QUOTING_ADVICE =
  'A shell command written as a bare YAML value is the usual cause: a plain scalar may not ' +
  'contain `: ` (a colon followed by a space), because that opens a nested mapping — and ' +
  'quotes INSIDE such a value are literal characters, not YAML quoting, so ' +
  "`- exec: echo 'WARN: failed'` is a syntax error. Wrap the whole command in double " +
  'quotes instead: `- exec: "echo \'WARN: failed\'"`.';

export interface DdevYamlFile {
  /** File name within `.ddev/`, e.g. `config.yaml` — quoted back to the agent. */
  name: string;
  content: string;
}

/** First parse error in these files that will fail `ddev start`, or null when every file
 *  DDEV loads parses. Files are judged in the order given; one finding is enough, because
 *  it routes the whole `.ddev/` tree back to the agent that wrote it. */
export function findDdevYamlBreakage(files: DdevYamlFile[]): string | null {
  for (const file of files) {
    // The parser collects syntax errors rather than throwing them, but a throw from it would
    // propagate out of the pre-flight and fail a bring-up this guard has no verdict on —
    // the one outcome it must never produce. A parser that cannot answer is a "fine".
    let error;
    try {
      error = parseDocument(file.content).errors.find((e) => !IGNORED_ERROR_CODES.has(e.code));
    } catch {
      continue;
    }
    if (!error) continue;
    const pos = error.linePos?.[0];
    const at = pos ? ` at line ${pos.line}, column ${pos.col}` : '';
    // The library appends a pretty source excerpt (and its own coordinates) after the first
    // line; keep the reason only, and add the position from linePos, which is there whether
    // or not pretty errors are enabled.
    const reason = error.message
      .split('\n')[0]!
      .replace(/\s+at line \d+, column \d+:?$/, '')
      .replace(/:$/, '');
    return (
      `${DDEV_CONFIG_YAML_PREFIX} .ddev/${file.name} cannot be parsed — ${reason}${at}. ` +
      `DDEV loads that file before it creates a single container, so \`ddev start\` fails ` +
      `on every attempt until it is fixed. ${SCALAR_QUOTING_ADVICE}`
    );
  }
  return null;
}

/**
 * Read the workspace and apply {@link findDdevYamlBreakage}.
 *
 * Returns null when nothing is wrong, when there is no `.ddev/`, or when the tree cannot be
 * read — an unreadable workspace is the boot's problem to report, not this check's.
 */
export async function checkDdevConfigYaml(workspace: string): Promise<string | null> {
  const dir = path.join(workspace, '.ddev');
  const names = await readdir(dir).catch(() => null);
  if (names === null) return null;

  const files: DdevYamlFile[] = [];
  for (const name of names.filter(isDdevParsedYaml).sort()) {
    const content = await readFile(path.join(dir, name), 'utf8').catch(() => null);
    if (content !== null) files.push({ name, content });
  }
  return findDdevYamlBreakage(files);
}
