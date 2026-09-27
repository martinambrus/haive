import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GIT_CONFIG_SAFETY_ARGS, hardenGitArgs } from '@haive/shared/git-args';

const PACKAGES = fileURLToPath(new URL('../..', import.meta.url));

/** The one module allowed to start a git process without going through `hardenGitArgs` itself. */
const WRAPPER = 'worker/src/repo/git-exec.ts';

async function sources(pkg: string): Promise<{ rel: string; text: string }[]> {
  const root = path.join(PACKAGES, pkg, 'src');
  const out: { rel: string; text: string }[] = [];
  for (const rel of await readdir(root, { recursive: true })) {
    if (!rel.endsWith('.ts') || rel.endsWith('.test.ts')) continue;
    out.push({ rel: `${pkg}/src/${rel}`, text: await readFile(path.join(root, rel), 'utf8') });
  }
  return out;
}

describe('every host-side git process', () => {
  it('is started through the hardened argv', async () => {
    const offenders: string[] = [];
    for (const pkg of ['worker', 'api', 'shared']) {
      for (const { rel, text } of await sources(pkg)) {
        if (rel === WRAPPER) continue;
        // A git spawn is `<fn>('git', <args>` — the args must be the hardened form.
        for (const m of text.matchAll(
          /\b(?:exec|execFile|execFileAsync|execGit|spawn)\(\s*'git',\s*([^\n]*)/g,
        )) {
          if (m[1]!.startsWith('hardenGitArgs(')) continue;
          offenders.push(`${rel}:${text.slice(0, m.index).split('\n').length}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('hardenGitArgs', () => {
  it('prepends the safety config and leaves the caller argv verbatim', () => {
    const args = ['-c', 'credential.helper=!f() { :; }; f', 'push', 'origin', 'main'];
    const out = hardenGitArgs(args);
    expect(out.slice(0, GIT_CONFIG_SAFETY_ARGS.length)).toEqual([...GIT_CONFIG_SAFETY_ARGS]);
    // The caller's own `-c credential.helper=` and its helper stay adjacent, so the helper still
    // appends after the safety reset rather than being erased by something spliced between them.
    const at = out.indexOf('-c', GIT_CONFIG_SAFETY_ARGS.length);
    expect(out[at + 1]).toBe('credential.helper=!f() { :; }; f');
    expect(out).toContain('--receive-pack=git-receive-pack');
  });

  it('adds the flags `-c` cannot express, and only where git accepts them', () => {
    // MEASURED on git 2.54.0: a repository's remote.<name>.uploadpack survives `-c` naming the
    // default binary, so only the flag replaces it.
    expect(hardenGitArgs(['fetch', 'origin', 'main'])).toContain('--upload-pack=git-upload-pack');
    expect(hardenGitArgs(['pull', '--ff-only'])).toContain('--upload-pack=git-upload-pack');
    expect(hardenGitArgs(['push', 'origin', 'main'])).toContain('--receive-pack=git-receive-pack');
    // `status` rejects --no-textconv outright (exit 129), so it is never added there.
    expect(hardenGitArgs(['--no-optional-locks', 'status', '--porcelain'])).not.toContain(
      '--no-textconv',
    );
    expect(hardenGitArgs(['diff', 'HEAD'])).toContain('--no-textconv');
    expect(hardenGitArgs(['diff', 'HEAD'])).toContain('--no-ext-diff');
    expect(hardenGitArgs(['log', '-1', '--format=%H'])).toContain('--no-textconv');
    // An empty `-c diff.external=` makes git run the empty string instead of disabling the
    // helper (exit 128 on every patch diff), so the flag is the only lever.
    expect(hardenGitArgs(['diff', 'HEAD']).join(' ')).not.toContain('diff.external');
  });

  it('finds the subcommand behind git’s own options', () => {
    const out = hardenGitArgs(['-C', '/repo', '-c', 'x=y', 'fetch', 'origin']);
    expect(out[out.indexOf('fetch') + 1]).toBe('--upload-pack=git-upload-pack');
    expect(hardenGitArgs(['--git-dir=/repo/.git', 'diff'])).toContain('--no-textconv');
  });

  it('never adds a flag the caller already passed', () => {
    const once = hardenGitArgs(['fetch', '--upload-pack=/usr/bin/git-upload-pack', 'origin']);
    expect(once.filter((a) => a.startsWith('--upload-pack')).length).toBe(1);
    expect(once).toContain('--upload-pack=/usr/bin/git-upload-pack');
    const diff = hardenGitArgs(['diff', '--no-textconv', '--no-ext-diff', 'HEAD']);
    expect(diff.filter((a) => a === '--no-textconv').length).toBe(1);
    expect(diff.filter((a) => a === '--no-ext-diff').length).toBe(1);
  });
});
