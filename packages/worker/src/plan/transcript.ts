import { fencedAgentBlock } from '../step-engine/steps/_untrusted-repo.js';

/** A conversation for a prompt: the newest whole turns within `maxChars` (the newest always, since it
 *  may be the request being answered), with a count of the earlier ones left out. The user's turns
 *  are the operator speaking and never fenced; the agent's own may have quoted a repository file. */
export function recentTurns(
  transcript: { role: string; body: string }[],
  maxChars: number,
): string {
  const turns = transcript.map((m) =>
    m.role === 'user' ? `User: ${m.body}` : `You:\n${fencedAgentBlock(m.body)}`,
  );
  let kept = 0;
  let size = 0;
  while (kept < turns.length) {
    const next = turns[turns.length - 1 - kept]!.length;
    if (kept > 0 && size + next > maxChars) break;
    size += next;
    kept += 1;
  }
  const dropped = turns.length - kept;
  return [
    ...(dropped > 0 ? [`(${dropped} earlier turns of this conversation are not shown)`] : []),
    ...turns.slice(turns.length - kept),
  ].join('\n\n');
}
