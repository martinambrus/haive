import { z } from 'zod';

/**
 * A URL git may be pointed at.
 *
 * `z.string().url()` is NOT sufficient on its own, and that is the whole reason
 * this exists. It delegates to the WHATWG URL parser, which accepts any scheme
 * — MEASURED, it accepts `file:///etc/passwd`, `ext::sh -c whoami` and
 * `javascript:alert(1)` without complaint.
 *
 * `file:` is the one that matters. MEASURED on the dev stack:
 * `git ls-remote file:///tmp/src` succeeds against any readable repository on
 * the worker's filesystem, and EVERY user's repositories live under one shared
 * volume at `/var/lib/haive/repos/<userId>/<repoId>`. A remote of
 * `file:///var/lib/haive/repos/<someone else>/<repo>` therefore fetches another
 * account's work into your own, and the plan pull then reconciles that
 * repository's committed `.haive-data/plan.json` into your plan. Nothing about
 * that is a network operation, so no firewall or credential check sees it.
 *
 * `ext:` — git's "run this command as the transport" scheme — is refused by git
 * itself with `fatal: transport 'ext' not allowed`, verified with
 * `protocol.ext.allow` unset, so it is not the hole it first looks like. It is
 * excluded here anyway: relying on a default in another tool for a property this
 * one depends on is exactly the sort of thing that changes without notice.
 *
 * An ALLOWLIST rather than a deny-list, because the set of things git can be
 * asked to do keeps growing and a deny-list only ever covers what was known when
 * it was written.
 *
 * `https` is what the product actually supports end to end — every `git_*`
 * repository source is https, and the stored credential is a username/password
 * pair that only an http(s) credential helper can supply. `ssh` is allowed
 * because a key-based remote is a legitimate setup handled outside Haive, and
 * `http` because a self-hosted server on a LAN without TLS is a real thing. The
 * anonymous `git://` protocol is deliberately absent: it is unauthenticated and
 * unencrypted, nothing in the product references it, and no stored repository
 * uses it.
 */
const ALLOWED_GIT_URL_SCHEMES = new Set(['https:', 'http:', 'ssh:']);

/** A user in an scp-style address. Must START alphanumeric, which is what keeps
 *  a leading `-` out — an argument that begins with a dash can be read as an
 *  option by whatever it is handed to. */
const SCP_USER = '[A-Za-z0-9][A-Za-z0-9._~+-]*';
/** One hostname label: alphanumeric at both ends, hyphens only inside. Excludes
 *  `/` and `:` by construction, so `foo/bar:baz` cannot pass as a host, and
 *  excludes `=` and a leading `-`, so `-oProxyCommand=sh` cannot become an ssh
 *  option. */
const SCP_HOST_LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?';
const SCP_LIKE = new RegExp(
  `^(?:(${SCP_USER})@)?(${SCP_HOST_LABEL}(?:\\.${SCP_HOST_LABEL})*):(.+)$`,
);

export interface ScpLikeGitUrl {
  user: string | null;
  host: string;
  /** Verbatim, and NOT rewritten into a URL path. In scp-style a path without a
   *  leading slash is relative to the remote user's home; `ssh://host/path` is
   *  absolute. Normalising one into the other silently changes which repository
   *  is meant, so the address is stored exactly as typed and handed to git. */
  path: string;
}

/**
 * Parse `[user@]host:path`, or null if it is not that.
 *
 * The caller must already have established there is no `://` in the string —
 * that is git's OWN test for "this is a URL, not an scp-style address", and
 * using the same one is what stops this validator and git disagreeing about
 * which of the two a string is.
 */
export function parseScpLikeGitUrl(value: string): ScpLikeGitUrl | null {
  const m = SCP_LIKE.exec(value);
  if (!m) return null;
  const user = m[1] ?? null;
  const host = m[2]!;
  // STRICTER THAN GIT, deliberately. git imposes nothing here, so `javascript:
  // alert(1)` and `data:text/plain,hi` are addresses to a host called
  // "javascript" or "data" as far as it is concerned — inert, since neither
  // resolves, but a URL validator that accepts them is one nobody can read and
  // trust. A real scp address carries a user (`git@…`) or a dotted host
  // (`github.com:…`); a bare `word:rest` is far likelier to be a mistyped URL.
  // The cost is one documented case — a single-label LAN host with no user must
  // be written `ssh://gitserver/repo.git` — and the message says so.
  if (!user && !host.includes('.')) return null;
  return { user, host, path: m[3]! };
}

/** git's own rule for telling a URL from an scp-style address. */
function looksLikeUrl(value: string): boolean {
  return value.includes('://');
}

export function isAllowedGitRemoteUrl(value: string): boolean {
  if (looksLikeUrl(value)) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return false;
    }
    // A host is required for the same reason `file:` is excluded: a scheme that
    // parses but names no server is not pointing at a remote.
    return ALLOWED_GIT_URL_SCHEMES.has(parsed.protocol) && parsed.hostname.length > 0;
  }
  // scp-style is ssh, which is already an allowed scheme — this is the same
  // permission written the way people actually type it.
  return parseScpLikeGitUrl(value) !== null;
}

export const gitRemoteUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine(isAllowedGitRemoteUrl, {
    message:
      'must be an https, http or ssh URL, or an scp-style address with a user or a ' +
      'dotted host (git@github.com:owner/repo.git). A local file:// path is not a ' +
      'remote; for a single-word host write ssh://host/path.',
  });

/* MEASURED against git 2.54.0, which is what decides whether any of this is
 * right:
 *   file:///tmp/src   reads the local repository        -> must stay blocked
 *   /tmp/src          reads the local repository        -> must stay blocked
 *   file:/tmp/src     "cannot run ssh" (host "file")    -> inert; rejected here
 *                                                          anyway, having neither
 *                                                          a user nor a dotted host
 *   tmp/src           "does not appear to be a git repository"
 * The middle case is why the split is on `://` rather than on a scheme list of
 * this module's own devising: git resolves a schemeless colon form as a HOST, so
 * keying on anything else would let the two disagree about what a string means. */
