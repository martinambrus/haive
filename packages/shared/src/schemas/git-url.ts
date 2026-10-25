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

// Git treats a leading <transport>:: as a remote helper, even when it resembles scp.
// Colons later in an ordinary URL/scp path retain their existing meaning.
const REMOTE_HELPER_SYNTAX = /^[^/:]+::/;

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
  if (REMOTE_HELPER_SYNTAX.test(value)) return null;
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
  if (REMOTE_HELPER_SYNTAX.test(value)) return false;
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

/** A Git credential is bound to a host, independently of its optional forge provider. */
export function credentialFitsGitRemote(
  credential: { host: string },
  remote: string | null | undefined,
): boolean {
  if (!remote || !isAllowedGitRemoteUrl(remote)) return false;
  const host = credential.host?.trim().toLowerCase();
  if (!host) return false;
  if (!remote.includes('://'))
    return parseScpLikeGitUrl(remote)?.host.toLowerCase() === host.replace(/:\d+$/, '');
  try {
    const url = new URL(remote);
    return url.protocol === 'ssh:'
      ? url.hostname.toLowerCase() === host.replace(/:\d+$/, '')
      : url.host.toLowerCase() === host.replace(url.protocol === 'https:' ? /:443$/ : /:80$/, '');
  } catch {
    return false;
  }
}

/** Only HTTP transports use username/password helpers. Pin protocol and port as well as hostname. */
export function gitCredentialTarget(
  remote: string | null | undefined,
): { protocol: string; host: string } | null {
  if (!remote || !isAllowedGitRemoteUrl(remote) || !/^https?:\/\//i.test(remote)) return null;
  const url = new URL(remote);
  // Unlike URL.host, Git's credential protocol keeps an explicitly written default port.
  const authority = remote.slice(remote.indexOf('://') + 3).split(/[/?#]/)[0]!;
  const host = authority.slice(authority.lastIndexOf('@') + 1).toLowerCase();
  return { protocol: url.protocol.slice(0, -1), host };
}

/** Remove URL credentials from display/persistence. Transport keeps a non-secret SSH login
 *  and the original address shape; diagnostics also omit query/fragment and malformed userinfo. */
export function redactGitUrl(url: string, forTransport = false): string {
  if (forTransport) {
    if (!url.includes('://')) return url;
    try {
      const parsed = new URL(url);
      if (!parsed.password && (parsed.protocol === 'ssh:' || !parsed.username)) return url;
      const start = url.indexOf('://') + 3;
      const authority = url.slice(start).split(/[/?#]/)[0]!;
      const at = authority.lastIndexOf('@');
      if (at < 0) return url;
      // Slice the original spelling: URL.toString() drops explicit default ports,
      // but Git includes them in its credential challenge. SSH's login is identity.
      const login = parsed.protocol === 'ssh:' ? authority.slice(0, at).split(':')[0] + '@' : '';
      return url.slice(0, start) + login + url.slice(start + at + 1);
    } catch {
      return url.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:/)?.[0] ?? '(unparseable URL)';
    }
  }
  let safe = url;
  if (safe.includes('://')) {
    try {
      const start = safe.indexOf('://') + 3;
      const end = safe.indexOf('/', start);
      const authority = safe.slice(start, end < 0 ? undefined : end);
      const at = authority.lastIndexOf('@');
      // file URLs cannot carry userinfo; retain the scheme-only malformed fallback.
      if (at >= 0 && /^file:/i.test(safe)) return 'file:';
      // Remove userinfo before interpreting a ? or # inside malformed credentials.
      const parsed = new URL(at >= 0 ? safe.slice(0, start) + safe.slice(start + at + 1) : safe);
      parsed.username = '';
      parsed.password = '';
      parsed.search = '';
      parsed.hash = '';
      if (!parsed.hostname && !parsed.pathname.startsWith('/')) {
        // Opaque URLs have no authority for URL to separate from userinfo.
        const start = safe.indexOf('://') + 3;
        const at = safe.lastIndexOf('@');
        if (at >= start) safe = safe.slice(0, start) + safe.slice(at + 1);
        safe = safe.split(/[?#]/)[0]!;
      } else {
        safe = parsed.toString();
      }
    } catch {
      // A malformed authority cannot be redacted reliably; keep only its scheme.
      safe = safe.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:/)?.[0] ?? '(unparseable URL)';
    }
  } else {
    safe = safe.slice(safe.lastIndexOf('@') + 1).split(/[?#]/)[0]!;
  }
  return safe;
}

/** Non-secret identity saved in approvals and PR stamps. Keep Git's authority spelling
 *  and SSH login without carrying query or fragment values into state. */
export function gitRemoteIdentity(url: string): string {
  return redactGitUrl(url, true).split(/[?#]/)[0]!;
}

/** Find the first letter-led scheme in one forward pass. Retrying a greedy
 *  scheme regex at every letter makes a long scheme-free word quadratic. */
function findUrlScheme(
  text: string,
  from: number,
): { start: number; authorityStart: number } | null {
  let start = -1;
  for (let index = from; index < text.length; index++) {
    const code = text.charCodeAt(index);
    const letter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    if (letter) {
      if (start < 0) start = index;
    } else if ((code >= 48 && code <= 57) || code === 43 || code === 45 || code === 46) {
      // Digits and +.- may continue a scheme, but cannot start one.
    } else {
      if (start >= 0 && text.startsWith('://', index)) {
        return { start, authorityStart: index + 3 };
      }
      start = -1;
    }
  }
  return null;
}

/** Diagnostic output can contain several URLs; use the same userinfo policy for each one. */
export function redactGitText(text: string): string {
  let output = '';
  let cursor = 0;
  for (let match = findUrlScheme(text, cursor); match; match = findUrlScheme(text, cursor)) {
    const { start, authorityStart } = match;
    const delimiter = text.slice(authorityStart).search(/[\s'"<>`]/);
    let end = delimiter < 0 ? text.length : authorityStart + delimiter;
    const first = text.slice(start, end);
    const slash = text.indexOf('/', authorityStart);
    // A path establishes the authority's end. Before a path, malformed userinfo
    // can contain quotes AND whitespace, so a text delimiter alone proves nothing.
    if (slash < 0 || slash >= end) {
      let ordinaryAuthority = false;
      try {
        const url = new URL(first);
        ordinaryAuthority = !!url.hostname && !url.username && !url.password;
      } catch {
        // An invalid authority is ambiguous: look for its @ before accepting a cut.
      }
      if (!ordinaryAuthority) {
        const next = findUrlScheme(text, authorityStart);
        const bound = Math.min(slash < 0 ? text.length : slash, next?.start ?? text.length);
        // Never search earlier authorities again when this interval has no @.
        const relativeAt = text.slice(authorityStart, bound).lastIndexOf('@');
        if (relativeAt >= 0) {
          const at = authorityStart + relativeAt;
          const suffixEnd = text.slice(at + 1).search(/[\s'"<>`]/);
          end = suffixEnd < 0 ? text.length : at + 1 + suffixEnd;
        }
      }
    }
    output += text.slice(cursor, start) + redactGitUrl(text.slice(start, end));
    cursor = end;
  }
  return output + text.slice(cursor);
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
  })
  .transform((value) => redactGitUrl(value, true));

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
