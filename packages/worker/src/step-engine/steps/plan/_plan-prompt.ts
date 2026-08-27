import { PLAN_PATCH_MAX_OPS } from '@haive/shared';
import { PlanPatchError, applyPlanPatch, type ApplyPlanPatchResult } from '@haive/shared/plan';
import type { Database } from '@haive/database';
import { RetryableParseError } from '../../step-definition.js';
import { parseJsonLoose } from '../_fenced-json.js';

/**
 * The one description of the patch contract every plan agent is given.
 *
 * Written once because three step sets emit it and a drifted copy would mean an
 * agent producing patches the applier rejects — which surfaces as a
 * RetryableParseError loop rather than an obvious error.
 */
export const PLAN_PATCH_CONTRACT = `## How to reply

Reply with ONE \`\`\`json fenced block and nothing else that matters. Its shape:

\`\`\`json
{
  "summary": "one line describing what you changed",
  "reply": "OPTIONAL. Prose a person reads. Only conversational steps ask for it; when they do, this is your answer to them, not a note about what you did.",
  "ops": [
    { "op": "upsert", "nodeRef": "tmp-api", "parentRef": "<parent uuid or another nodeRef>", "title": "Backend API", "kind": "component", "body": "markdown describing this part", "taskable": false },
    { "op": "upsert", "nodeRef": "<an existing node uuid>", "body": "revised text", "expectedVersion": 4 },
    { "op": "delete", "nodeRef": "<uuid>" },
    { "op": "link", "fromRef": "tmp-api", "toRef": "<uuid>", "kind": "depends_on", "note": "why" },
    { "op": "unlink", "fromRef": "<uuid>", "toRef": "<uuid>", "kind": "affects" }
  ]
}
\`\`\`

Rules:
- \`nodeRef\` is EITHER an existing node's uuid (to change it) OR a short temporary
  id you invent (to create one). A temporary id must appear in an \`upsert\` before
  anything else refers to it, which is how you build a subtree and link into it in
  one reply.
- A NEW node MUST carry \`parentRef\` and \`title\`. Use \`"parentRef": null\` ONLY for
  the plan root, and only when there is no root yet — a repository has exactly one.
- To CHANGE an existing node, send only the fields you are changing, plus its
  \`expectedVersion\` (shown beside each node below). If someone else changed it
  first the whole reply is rejected and nothing is written, so do not guess.
- \`kind\` is one of: \`component\` (a part of the system), \`decision\` (a choice to
  make or record), \`research\` (needs investigating first), \`external\` (a non-code
  blocker — legal, a domain, hosting, an account).
- \`taskable: true\` marks a leaf small enough that one developer task could
  implement it. Do not mark a node taskable if it still needs breaking down.
- \`codeLinks\` names the files that already implement a node, so the plan can later
  answer "if I change this, what else must change". Add it ONLY for a file you have
  actually looked at, and say in \`evidence\` what made you link it. A guessed path is
  worse than no path — it makes the impact view lie with a straight face. Links are
  additive; naming three files does not retract the ones already recorded.
  Put them on the node each file implements — usually a node you are CREATING, not
  the one you were asked to expand. Links banked on the parent leave every child
  answering "nothing" when the impact view asks what implements it.
  Naming a file in a title is a claim, not a link: a node called
  \`SMTP transport (smtp.php)\` still needs \`smtp.php\` in its \`codeLinks\`, or the
  plan only knows the filename as prose.

  \`\`\`json
  { "op": "upsert", "nodeRef": "<uuid>", "codeLinks": [
      { "repoPath": "src/auth/session.ts", "symbol": "createSession",
        "evidence": "the only place a session cookie is minted", "confidence": 0.9 } ] }
  \`\`\`
- \`ops\` is the ONLY thing that changes the plan. An empty array changes nothing,
  no matter what your prose says, so never report a change you did not send as an
  op — the reader is looking at the plan and will see that it did not happen.
- \`kind\` for links: \`depends_on\` (this cannot proceed until the target does),
  \`affects\` (changing the target forces a change here), \`implements\` (this
  realises the target).
- At most ${PLAN_PATCH_MAX_OPS} ops. Never invent a uuid — only use ones shown to you.
- Do not restate the whole plan. Send only what changes.`;

/** Extract a patch object from an agent's raw reply. Returns null when nothing
 *  patch-shaped is there, so the caller decides whether that is a retry or a
 *  legitimate "no change". */
export function parsePlanPatch(
  raw: unknown,
): { ops: unknown[]; summary?: string; reply?: string } | null {
  const parsed =
    typeof raw === 'string' ? parseJsonLoose(raw) : (raw as Record<string, unknown> | null);
  if (!parsed || typeof parsed !== 'object') return null;
  const summaryField = (parsed as { summary?: unknown }).summary;
  const replyField = (parsed as { reply?: unknown }).reply;
  const spoke = typeof summaryField === 'string' || typeof replyField === 'string';
  const rawOps = (parsed as { ops?: unknown }).ops;
  // A reply that CHANGES nothing often omits `ops` rather than sending `[]` —
  // measured on a live chat, where an answer carrying a full `reply` was thrown
  // away as unusable and the user saw an error instead of it. Absent ops on an
  // object that plainly spoke means "no operations".
  //
  // Only when it spoke, though: an object with neither field is not a patch
  // that changed nothing, it is something else entirely, and the build steps
  // rely on null there to re-roll rather than record an empty pass.
  if (!Array.isArray(rawOps) && !(rawOps === undefined && spoke)) return null;
  const ops = Array.isArray(rawOps) ? rawOps : [];
  const summary = summaryField;
  // `reply` is what a person reads; `summary` is a changelog line. Steps that
  // show the agent's words to a human need a field that MEANS that, because a
  // field documented as "what you changed" gets a description of the change
  // even when the step asks for an answer — measured twice on live chats, which
  // both came back as "Answered the question; no plan changes."
  const reply = replyField;
  return {
    ops,
    ...(typeof summary === 'string' ? { summary } : {}),
    ...(typeof reply === 'string' ? { reply } : {}),
  };
}

/** How much of a prose reply is kept in a transcript. A conversational turn is
 *  a paragraph or two; anything past this is a stream that lost its way. */
const CONVERSATIONAL_MAX = 8000;

/**
 * The part of a reply a person can read, for a turn that carried no patch.
 *
 * An agent asked to answer by patching sometimes answers in prose instead —
 * most usefully when it wants confirmation before writing anything. Recording
 * "the agent did not reply with a usable patch" throws that answer away and
 * leaves the user staring at an error where a reply should be, so the words are
 * kept even though the machine-readable part is missing.
 *
 * Fenced blocks are stripped: a block that reached here failed to parse, and
 * pasting a broken payload into a conversation helps nobody. Null when nothing
 * but those blocks was there.
 */
export function conversationalReply(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const prose = raw
    .replace(/```[\s\S]*?```/g, '')
    // Removing a block leaves the blank lines that surrounded it; three or more
    // in a row render as a hole in the transcript.
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!prose) return null;
  return prose.length > CONVERSATIONAL_MAX ? `${prose.slice(0, CONVERSATIONAL_MAX)}…` : prose;
}

/**
 * Apply an agent's patch, translating the applier's typed refusal into the
 * runner's retry signal.
 *
 * `invalid` becomes a RetryableParseError because that is exactly what it means
 * here — the model emitted something the contract does not allow, and
 * re-prompting can fix it. `conflict` and `not_found` do NOT retry: the plan
 * moved under the agent, so the same reply would be rejected again, and the next
 * round will read the new state anyway.
 */
export async function applyAgentPatch(
  db: Database,
  patch: { ops: unknown[]; summary?: string },
  opts: {
    repositoryId: string;
    sourceTaskId: string;
    retryable: boolean;
    /** HEAD at the time the agent read the tree, stamped on any code links it
     *  emitted so a stale one can be dated. */
    derivedAtCommit?: string | null;
  },
): Promise<ApplyPlanPatchResult> {
  try {
    return await applyPlanPatch(db, patch, {
      repositoryId: opts.repositoryId,
      origin: 'llm',
      sourceTaskId: opts.sourceTaskId,
      derivedAtCommit: opts.derivedAtCommit ?? null,
    });
  } catch (err) {
    if (err instanceof PlanPatchError && err.kind === 'invalid' && opts.retryable) {
      throw new RetryableParseError(`plan patch rejected: ${err.message}`);
    }
    throw err;
  }
}
