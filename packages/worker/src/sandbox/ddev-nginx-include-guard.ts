import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Pre-flight check that the project's nginx configs do not declare the same `location`
 * twice inside one server block.
 *
 * DDEV ends every server block it generates with `include /mnt/ddev_config/nginx/*.conf;`,
 * so each `.ddev/nginx/*.conf` snippet is spliced INSIDE every `.ddev/nginx_full/*.conf`
 * server block — including a project-authored sibling that already declares the same
 * locations. nginx rejects that outright (`[emerg] duplicate location`), which is not a
 * degraded boot but a dead one: nginx fails its three supervisord spawn retries, goes
 * FATAL, and `ddev-webserver`'s own /healthcheck.sh answers a FATAL nginx by running
 * `supervisorctl shutdown` — killing PID 1, so the CONTAINER EXITS. DDEV then reports only
 * "web container exited", with the actual emerg line visible nowhere in its output
 * (task a0d1bbf9, which burned nine fix rounds and ~5 days).
 *
 * Three file reads turn that into an instant, actionable failure. No repair: rewriting an
 * agent's webserver config behind its back trades one silent failure for another.
 *
 * Deliberately lenient, like the healthcheck and build-input guards: only an EXACT
 * collision is reported, because a false "broken" verdict blocks a working environment
 * while a false "fine" only returns us to the boot failure we already had.
 */

/** Prefix on every message this module produces. Ours, not nginx's or DDEV's, so the
 *  fix-loop classifier can key on it without depending on anyone else's wording. */
export const DDEV_NGINX_INCLUDE_PREFIX = 'DDEV nginx config is invalid:';

/** The include DDEV appends to every server block it generates. Matched on the DIRECTORY
 *  path rather than the whole line so a change in DDEV's spacing or glob does not silently
 *  disable the check. A conf without it does not receive the snippets and cannot collide. */
const SNIPPET_INCLUDE_DIR = '/mnt/ddev_config/nginx/';

export interface NginxConfFile {
  /** File name within its directory, e.g. `nginx-site.conf`. */
  name: string;
  content: string;
}

/** Strip `#` comments so a location mentioned in prose is never counted. A `#` inside a
 *  quoted string or regex is mangled too, but identically on both sides of the comparison —
 *  so it can only ever cost a detection, never invent one. */
function stripComment(line: string): string {
  const hash = line.indexOf('#');
  return hash === -1 ? line : line.slice(0, hash);
}

/** nginx compares `location` directives on the exact (modifier, uri) pair, so normalising
 *  the run of whitespace between them is the whole of what a faithful key needs. */
function normalizeLocationKey(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

/**
 * `location` keys declared at exactly `wantDepth` brace levels into `text`.
 *
 * Depth 1 is "directly inside the server block" for a full site conf; depth 0 is the top
 * level of a snippet, which is what gets spliced into that same server block. Anything
 * deeper belongs to another context and cannot collide with either.
 */
export function locationKeysAtDepth(text: string, wantDepth: number): string[] {
  const keys: string[] = [];
  let depth = 0;
  for (const raw of text.split('\n')) {
    const line = stripComment(raw).trim();
    if (!line) continue;
    // Read the directive BEFORE this line's own opening brace changes the depth.
    const match = /^location\s+(.+?)\s*\{/.exec(line);
    if (match && depth === wantDepth) keys.push(normalizeLocationKey(match[1]!));
    for (const ch of line) {
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
    }
  }
  return keys;
}

/**
 * Reason the next `ddev start` will die on `[emerg] duplicate location`, or null when it
 * will not.
 *
 * A collision requires all of: at least one `.ddev/nginx/*.conf` snippet; a
 * `.ddev/nginx_full/*.conf` that actually pulls the snippets in; and a location key
 * declared in both.
 */
export function findDdevNginxIncludeCollisions(input: {
  /** `.ddev/nginx_full/*.conf` — each one a full server block. */
  siteConfs: NginxConfFile[];
  /** `.ddev/nginx/*.conf` — spliced inside every server block above. */
  snippets: NginxConfFile[];
}): string | null {
  const snippetOwner = new Map<string, string>();
  for (const snippet of input.snippets) {
    for (const key of locationKeysAtDepth(snippet.content, 0)) {
      if (!snippetOwner.has(key)) snippetOwner.set(key, snippet.name);
    }
  }
  if (snippetOwner.size === 0) return null;

  for (const site of input.siteConfs) {
    if (!site.content.includes(SNIPPET_INCLUDE_DIR)) continue;
    const clashes = locationKeysAtDepth(site.content, 1).filter((key) => snippetOwner.has(key));
    if (clashes.length === 0) continue;

    const unique = [...new Set(clashes)];
    const snippetName = snippetOwner.get(unique[0]!)!;
    return (
      `${DDEV_NGINX_INCLUDE_PREFIX} .ddev/nginx_full/${site.name} and .ddev/nginx/${snippetName} ` +
      `both declare ${unique.map((k) => `\`location ${k}\``).join(', ')}. DDEV ends every ` +
      `server block with \`include /mnt/ddev_config/nginx/*.conf;\`, so .ddev/nginx/*.conf is ` +
      `spliced INSIDE .ddev/nginx_full/${site.name}'s own server block and nginx aborts with ` +
      `"[emerg] duplicate location". The web container then exits and \`ddev start\` fails. ` +
      `Declare each location in exactly ONE of the two files: keep the shared rules in ` +
      `.ddev/nginx/${snippetName} (DDEV includes it in every server block, so it applies to ` +
      `both) and delete them from .ddev/nginx_full/${site.name}.`
    );
  }
  return null;
}

/** Read `.conf` files out of one `.ddev/<dir>`; empty when the directory is absent or
 *  unreadable. `*.conf` only, matching what nginx's own glob loads — `Dockerfile.example`
 *  style samples and READMEs sit in these directories and are never active. */
async function readConfDir(workspace: string, dir: string): Promise<NginxConfFile[]> {
  const abs = path.join(workspace, '.ddev', dir);
  const names = await readdir(abs).catch(() => null);
  if (names === null) return [];
  const files: NginxConfFile[] = [];
  for (const name of names.filter((n) => n.endsWith('.conf')).sort()) {
    const content = await readFile(path.join(abs, name), 'utf8').catch(() => null);
    if (content !== null) files.push({ name, content });
  }
  return files;
}

/**
 * Read the workspace and apply {@link findDdevNginxIncludeCollisions}.
 *
 * Returns null when nothing is wrong, when the project has no `.ddev/nginx/` snippets (the
 * common case — nothing can be spliced, so nothing can collide), or when the tree cannot be
 * read: an unreadable workspace is the boot's problem to report, not this check's.
 */
export async function checkDdevNginxIncludes(workspace: string): Promise<string | null> {
  const snippets = await readConfDir(workspace, 'nginx');
  if (snippets.length === 0) return null;
  const siteConfs = await readConfDir(workspace, 'nginx_full');
  return findDdevNginxIncludeCollisions({ siteConfs, snippets });
}
