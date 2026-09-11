import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** A quoted path literal carrying a segment that looks generated rather than named. */
export interface OpaquePathHit {
  /** Repo-relative file. */
  file: string;
  /** 1-based line, as the agent will see it when it opens the file. */
  line: number;
  /** The whole literal, e.g. `cron-trash-cleanup/19dd78sa09dsa`. */
  literal: string;
  /** The segment that triggered the hit. */
  segment: string;
}

/** Literals long enough to be worth judging. Below this a segment is far more likely to
 *  be an abbreviation (`api`, `v2`, `sk`) than a secret. */
const MIN_SEGMENT = 8;
/** Above this a "path" is almost always minified code, a data URI or a base64 blob. */
const MAX_LITERAL = 200;

/** Segments that are generated but NOT secret — build hashes and ids that appear in paths
 *  constantly. Matching them by SHAPE rather than by a wordlist, because the shapes are
 *  stable and the vocabulary is not. */
const KNOWN_GENERATED = [
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // uuid
  /^[0-9a-f]{32}$/i, // md5
  /^[0-9a-f]{40}$/i, // sha1 / git object
  /^[0-9a-f]{64}$/i, // sha256
  /^\d+$/, // a pure number is an id, not a token
];

const VOWELS = /[aeiouAEIOU]/g;

/** Whether a path segment reads as GENERATED rather than named.
 *
 *  Deliberately not a Shannon-entropy score: the useful signal here is "a human did not
 *  choose these characters", and the two cheap proxies for that are a vowel-starved run
 *  of letters and a mix of letters with digits. MEASURED against the three real hits on a
 *  live Drupal 7 repo — `lfewjngfsda47wq`, `19dd78sa09dsa`, `ps03cxmasa` — and against the
 *  ordinary segments beside them (`cron-notifications`, `admin`, `node`, `webhook`), which
 *  every rule below leaves alone. */
export function looksGenerated(segment: string): boolean {
  if (segment.length < MIN_SEGMENT) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return false;
  if (KNOWN_GENERATED.some((re) => re.test(segment))) return false;

  // The generated-looking part must be ONE CONTIGUOUS run, not a compound of short
  // abbreviations. MEASURED on a live repo without this: `x-httpd-php`,
  // `x-7z-compressed` and forty other MIME types out of `includes/file.mimetypes.inc`
  // filled the entire candidate budget and pushed the three real secrets off the list.
  // Every piece of those is a short word; a token is not.
  return segment.split(/[-_]/).some((run) => run.length >= MIN_SEGMENT && runLooksGenerated(run));
}

/** Whether one separator-free run reads as generated.
 *
 *  Two cheap proxies for "a human did not choose these characters", deliberately not a
 *  Shannon score: a vowel-starved run of letters, or letters interleaved with digits.
 *  MEASURED against the three real hits on a live Drupal 7 repo — `lfewjngfsda47wq`,
 *  `19dd78sa09dsa`, `ps03cxmasa` — and against the ordinary segments beside them
 *  (`notifications`, `inspections`, `dashboard`), which both rules leave alone. */
function runLooksGenerated(run: string): boolean {
  if (KNOWN_GENERATED.some((re) => re.test(run))) return false;
  const letters = run.replace(/[^A-Za-z]/g, '');
  if (letters.length === 0) return false;

  // Digits INTERLEAVED with letters, which is what every real hit measured here looks
  // like. A trailing version number is how humans name things (`bootstrap3`, `drupal7`),
  // so that shape is excluded rather than counted.
  if (/[A-Za-z]\d|\d[A-Za-z]/.test(run) && !/^[A-Za-z]+\d+$/.test(run)) return true;

  // Otherwise: a letters-only run with almost no vowels. The threshold is 0.20 and not
  // 0.25 because MEASURED on a live repo, `postscript` (0.20) and `compressed` (0.30) sit
  // just above the real tokens — English has plenty of consonant-heavy words, and every
  // point of headroom here is a false positive that costs the budget.
  const vowelRatio = (letters.match(VOWELS)?.length ?? 0) / letters.length;
  return vowelRatio < 0.2;
}

/** Quoted literals that look like a ROUTE PATH: a slash, no whitespace, not a URL scheme.
 *  Matching the path SHAPE rather than any framework's registration call is what keeps
 *  this useful beyond `hook_menu()` — an express route, a webhook constant and a Drupal
 *  `$items[...]` key are all the same shape once quoted. */
const PATH_LITERAL = /['"`]([A-Za-z0-9_\-./]*\/[A-Za-z0-9_\-./]*)['"`]/g;

/** Scan one file's text. Exported for tests; the walker below is the real entry point. */
export function scanTextForOpaquePaths(file: string, content: string): OpaquePathHit[] {
  const hits: OpaquePathHit[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!;
    // Minified bundles are one enormous line of quoted fragments; judging them wastes the
    // budget and tells the reader nothing.
    if (text.length > 2000) continue;
    for (const m of text.matchAll(PATH_LITERAL)) {
      const literal = m[1]!;
      if (literal.length > MAX_LITERAL) continue;
      if (/^(https?|data|javascript):/i.test(literal)) continue;
      const segment = literal.split('/').find((s) => looksGenerated(s));
      if (!segment) continue;
      hits.push({ file, line: i + 1, literal, segment });
    }
  }
  return hits;
}

export interface OpaquePathScanResult {
  hits: OpaquePathHit[];
  /** How many were found beyond the cap, so the prompt can say so rather than imply none. */
  omitted: number;
}

/** Walk the given files and collect the candidates, capped.
 *
 *  Exists because the sweep's recall depended on a tool the run may not have. MEASURED
 *  across three onboarding runs of one repo: the two tasks whose prompt wired `rag_search`
 *  found the secret route segments, and the `ragMode: 'none'` task — told to "discover with
 *  grep / ripgrep instead" — missed them TWICE, before and after the class was named in the
 *  prompt. These secrets carry no keyword to grep for: `cron-trash-cleanup/19dd78sa09dsa`
 *  contains no `password`, `secret`, `key` or `token`. Handing the model the candidates
 *  makes discovery deterministic and leaves it the judgement, which is the same bargain
 *  `collectImplementationFiles` strikes for reviewers. */
export async function scanForOpaquePaths(
  repoPath: string,
  files: string[],
  cap: number,
): Promise<OpaquePathScanResult> {
  const hits: OpaquePathHit[] = [];
  for (const rel of files) {
    let content: string;
    try {
      content = await readFile(path.join(repoPath, rel), 'utf8');
    } catch {
      continue; // unreadable or binary — nothing to judge
    }
    hits.push(...scanTextForOpaquePaths(rel, content));
    if (hits.length > cap * 4) break; // enough to report a cap; stop paying for more
  }
  return { hits: hits.slice(0, cap), omitted: Math.max(0, hits.length - cap) };
}
