import { gitRun } from './git-exec.js';

/** A failed HEAD resolution alone is not proof: an existing ref may be unreadable.
 * Require a named branch and a successful, silent enumeration with no matching ref. */
export async function provesUnbornHead(repoPath: string): Promise<boolean> {
  const symbolic = await gitRun(repoPath, ['symbolic-ref', '-q', 'HEAD']);
  if (symbolic.code !== 0 || symbolic.stderr !== '') return false;
  const ref = symbolic.stdout.trim();
  if (!/^refs\/heads\/[^\s]+$/.test(ref)) return false;
  const refs = await gitRun(repoPath, ['for-each-ref', '--format=%(refname)', '--', ref]);
  // Git can exit 0 while warning that a broken ref was ignored. Any diagnostic
  // leaves the answer unknown; no decision depends on its wording.
  return refs.code === 0 && refs.stdout === '' && refs.stderr === '';
}
