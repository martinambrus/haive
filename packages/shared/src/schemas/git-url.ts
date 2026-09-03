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

export const gitRemoteUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine(
    (value) => {
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        return false;
      }
      // A host is required for the same reason `file:` is excluded: a scheme
      // that parses but names no server is not pointing at a remote.
      return ALLOWED_GIT_URL_SCHEMES.has(parsed.protocol) && parsed.hostname.length > 0;
    },
    {
      message:
        'must be an https, http or ssh URL with a host — a local file:// path is not a remote, ' +
        'and scp-style git@host:path addresses are not supported',
    },
  );
