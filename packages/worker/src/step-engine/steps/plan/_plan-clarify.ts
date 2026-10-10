import { stripNodeRefPrefix } from '@haive/shared/plan';
import type { FormSchema } from '@haive/shared';
import { parseAgentJson } from '../workflow/_agent-json.js';
import {
  REPO_IS_DATA_AUTHORING_LINES,
  REPO_IS_DATA_ONE_CLASS_LINES,
  UNTRUSTED_FENCE_LEGEND,
  collapseToLine,
  fencedAgentBlock,
} from '../_untrusted-repo.js';
import { PLAN_PATCH_CONTRACT } from './_plan-prompt.js';
import type { PlanBuildDetect } from './01-plan-build.js';

export interface ClarifyQuestion {
  id: string;
  topic: string;
  question: string;
  why: string;
  suggestions: string[];
}

export interface ClarifyAnswer {
  questionId: string;
  answer: string;
  /** The owner clicked one of the questioner's suggestions: their choice, but agent-written text,
   *  so it is fenced like the question. Absent for an answer they typed. */
  suggested?: boolean;
}

export interface ClarifyVerdict {
  questionId: string;
  status: 'settled' | 'open';
  note: string;
}

export interface ClarifyOutcome {
  summary: string;
  verdicts: ClarifyVerdict[];
  dropped: string[];
}

export interface ClarifyRound {
  round: number;
  questions: ClarifyQuestion[];
  nothingOpen: boolean;
  answers: ClarifyAnswer[] | null;
  steer: string | null;
  action: 'continue' | 'build' | null;
  answered: boolean;
  outcome: ClarifyOutcome | null;
  integrated: boolean;
  /** Round 0 only: the root of the outline this task drafted, null once that root is deleted. */
  rootId: string | null;
}

export type ClarifyMove =
  | { kind: 'outline' }
  | { kind: 'ask'; round: number }
  | { kind: 'form'; round: number }
  | { kind: 'integrate'; round: number }
  | { kind: 'done' };

export const MAX_QUESTIONS_PER_ROUND = 8;
const MAX_SUGGESTIONS = 4;
const MAX_SUGGESTION_CHARS = 160;
const QUESTION_ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

/** One id per draft: an outline redrafted after its root was deleted needs a fresh mining row, since
 *  a step never re-sends an agent id it already has a row for. */
export const outlineAgentId = (earlierDrafts: number): string =>
  earlierDrafts === 0 ? 'clarify-outline' : `clarify-outline-${earlierDrafts + 1}`;
export const isOutlineAgent = (agentId: string): boolean =>
  /^clarify-outline(-\d+)?$/.test(agentId);
const ASK_AGENT_RE = /^clarify-ask-r(\d+)$/;
const INTEGRATE_AGENT_RE = /^clarify-integrate-r(\d+)$/;

export const askAgentId = (round: number): string => `clarify-ask-r${round}`;
export const integrateAgentId = (round: number): string => `clarify-integrate-r${round}`;
export const askRoundOf = (agentId: string): number | null => roundOf(ASK_AGENT_RE, agentId);
export const integrateRoundOf = (agentId: string): number | null =>
  roundOf(INTEGRATE_AGENT_RE, agentId);

function roundOf(re: RegExp, agentId: string): number | null {
  const m = re.exec(agentId);
  return m ? Number(m[1]) : null;
}

export const answerFieldId = (round: number, questionId: string): string =>
  `answer__r${round}__${questionId}`;
export const steerFieldId = (round: number): string => `steer__r${round}`;
export const actionFieldId = (round: number): string => `action__r${round}`;

/** True when the round carries something for the planner to fold in. */
export function hasContent(r: Pick<ClarifyRound, 'answers' | 'steer'>): boolean {
  return (r.answers?.length ?? 0) > 0 || Boolean(r.steer?.trim());
}

/**
 * Refuses a plan this task did not draft. The build route checks that a repository has no plan
 * when the task is created, but a deferred build can wait while its files upload, and a root
 * written meanwhile by another build or by hand would otherwise be questioned and patched as if
 * it were this task's outline; so would a root someone deleted and recreated while a round was
 * parked. Round 0, written with the outline, names the root it drafted, and only that root is
 * this task's. A node's `sourceTaskId` cannot say so, since every later patch rewrites it.
 */
export function assertOwnOutline(rootId: string | null, rounds: readonly ClarifyRound[]): void {
  if (rootId !== null && rounds.find((r) => r.round === 0)?.rootId !== rootId) {
    throw new Error(
      'This repository got a plan before this build started, and clarifying questions only shape a new outline. Skip this step to build into the existing plan, or change it through the plan chat.',
    );
  }
}

/** What the step does next, decided from the plan root and the stored rounds alone, so a Retry,
 *  a reopen and a fresh apply pass all reach the same answer. */
export function nextMove(hasRoot: boolean, rounds: readonly ClarifyRound[]): ClarifyMove {
  if (!hasRoot) return { kind: 'outline' };
  const last = rounds.at(-1);
  if (!last) return { kind: 'ask', round: 1 };
  if (!last.answered) return { kind: 'form', round: last.round };
  if (!last.integrated) return { kind: 'integrate', round: last.round };
  if (last.action === 'build') return { kind: 'done' };
  return { kind: 'ask', round: last.round + 1 };
}

/** The answers a submitted form carries for `round`, or null when the submit is not for it. */
export function readRoundAnswers(
  round: ClarifyRound,
  values: Record<string, unknown>,
): { answers: ClarifyAnswer[]; steer: string | null; action: 'continue' | 'build' } | null {
  const action = values[actionFieldId(round.round)];
  if (action !== 'continue' && action !== 'build') return null;
  const answers: ClarifyAnswer[] = [];
  for (const q of round.questions) {
    const raw = values[answerFieldId(round.round, q.id)];
    if (typeof raw === 'string' && raw.trim()) {
      const answer = raw.trim();
      answers.push({
        questionId: q.id,
        answer,
        ...(q.suggestions.includes(answer) ? { suggested: true } : {}),
      });
    }
  }
  const steer = values[steerFieldId(round.round)];
  return {
    answers,
    steer: typeof steer === 'string' && steer.trim() ? steer.trim() : null,
    action,
  };
}

/* ------------------------------------------------------------------ */
/* Reply parsing                                                       */
/* ------------------------------------------------------------------ */

/** The questioner's reply, or null when it holds no usable one. An empty list is usable only
 *  when the questioner said outright that nothing is open. */
export function parseQuestions(
  raw: unknown,
): { questions: ClarifyQuestion[]; nothingOpen: boolean } | null {
  return parseAgentJson(raw, (candidate) => {
    if (!candidate || typeof candidate !== 'object') return null;
    const c = candidate as Record<string, unknown>;
    if (!Array.isArray(c.questions)) return null;
    const nothingOpen = c.nothingOpen === true;
    const seen = new Set<string>();
    const questions: ClarifyQuestion[] = [];
    for (const item of c.questions) {
      if (!item || typeof item !== 'object') continue;
      const q = item as Record<string, unknown>;
      const id = typeof q.id === 'string' ? q.id.trim().toLowerCase() : '';
      const question = typeof q.question === 'string' ? q.question.trim() : '';
      if (!QUESTION_ID_RE.test(id) || seen.has(id) || !question) continue;
      seen.add(id);
      const suggestions = Array.isArray(q.suggestions)
        ? [
            ...new Set(
              q.suggestions
                .filter((s): s is string => typeof s === 'string')
                .map((s) => s.trim())
                .filter((s) => s && s.length <= MAX_SUGGESTION_CHARS),
            ),
          ].slice(0, MAX_SUGGESTIONS)
        : [];
      questions.push({
        id,
        topic: typeof q.topic === 'string' ? q.topic.trim() : '',
        question,
        why: typeof q.why === 'string' ? q.why.trim() : '',
        suggestions,
      });
      if (questions.length === MAX_QUESTIONS_PER_ROUND) break;
    }
    if (questions.length === 0 && !nothingOpen) return null;
    return { questions, nothingOpen };
  });
}

/** The planner's per-answer verdicts, read from the same reply object as its patch. Answers it
 *  gave no verdict for count as settled: the patch is what changed the plan, and re-asking a
 *  question the planner said nothing about would ask what the person already answered. */
export function parseVerdicts(raw: unknown, answers: readonly ClarifyAnswer[]): ClarifyVerdict[] {
  const listed =
    parseAgentJson(raw, (candidate) => {
      if (!candidate || typeof candidate !== 'object') return null;
      const c = candidate as Record<string, unknown>;
      return Array.isArray(c.verdicts) ? c.verdicts : null;
    }) ?? [];
  const byId = new Map<string, ClarifyVerdict>();
  for (const item of listed) {
    if (!item || typeof item !== 'object') continue;
    const v = item as Record<string, unknown>;
    if (typeof v.questionId !== 'string') continue;
    byId.set(v.questionId, {
      questionId: v.questionId,
      status: v.status === 'open' ? 'open' : 'settled',
      note: typeof v.note === 'string' ? v.note.trim() : '',
    });
  }
  return answers.map(
    (a) => byId.get(a.questionId) ?? { questionId: a.questionId, status: 'settled', note: '' },
  );
}

/**
 * Ops that would give a node a parent other than the root. The outline stays two levels until
 * 01 expands it, and a node under a component takes that component off 01's frontier for good
 * (`computeFrontier` expands leaves only), so the clarify step never writes one. `rootRef` is
 * the root's uuid, or, for the outline reply that creates it, its temporary ref.
 */
export function outsideOutline(
  ops: readonly unknown[],
  rootRef: string | null,
): { kept: unknown[]; dropped: string[] } {
  const rootOf = (ops: readonly unknown[]): string | null => {
    for (const op of ops) {
      const o = op as Record<string, unknown>;
      if (o?.op === 'upsert' && o.parentRef === null && typeof o.nodeRef === 'string') {
        return stripNodeRefPrefix(o.nodeRef);
      }
    }
    return null;
  };
  const root = rootRef ?? rootOf(ops);
  const kept: unknown[] = [];
  const dropped: string[] = [];
  for (const op of ops) {
    const o = op as Record<string, unknown>;
    // Folding answers into an owned outline never swaps its root: a deleted or second root would
    // leave round 0 naming none, and every later pass would refuse the plan as foreign.
    if (
      rootRef !== null &&
      ((o?.op === 'delete' && stripNodeRefPrefix(String(o.nodeRef)) === rootRef) ||
        (o?.op === 'upsert' && o.parentRef === null))
    ) {
      dropped.push(`${String(o.title ?? o.nodeRef)}: the outline keeps its root`);
      continue;
    }
    const parent =
      o?.op === 'upsert' && typeof o.parentRef === 'string'
        ? stripNodeRefPrefix(o.parentRef)
        : null;
    if (parent !== null && parent !== root) {
      dropped.push(`${String(o.title ?? o.nodeRef)}: only the root may hold new parts here`);
      continue;
    }
    kept.push(op);
  }
  return { kept, dropped };
}

/** Open questions arrive `todo` whatever the agent omitted: a `from_repo` outline greens every
 *  upsert without a status (`withMinedStatus`), and a question nobody answered is not done. */
export function openQuestionsTodo(ops: readonly unknown[]): unknown[] {
  return ops.map((op) => {
    const o = op as Record<string, unknown>;
    return o?.op === 'upsert' &&
      (o.kind === 'decision' || o.kind === 'research') &&
      o.status === undefined
      ? { ...o, status: 'todo' }
      : op;
  });
}

/* ------------------------------------------------------------------ */
/* Prompts                                                             */
/* ------------------------------------------------------------------ */

/** Appended to `buildRootPrompt` for the outline the questions are asked about. A REDRAFT, after
 *  the outline's root was deleted, also carries every answered round: those rounds stay integrated,
 *  so an outline drafted from the inputs alone would silently drop what the owner decided. */
export function outlineExtraLines(
  d: Pick<PlanBuildDetect, 'mode'>,
  rounds: readonly ClarifyRound[] = [],
): string[] {
  // Integrated rounds only: one answered but not yet folded in is integrated after the redraft,
  // and carrying it here as well would apply the same answer twice.
  const carried = rounds.filter((r) => r.round > 0 && r.integrated);
  const decided = carried.length > 0;
  return [
    ...(decided
      ? [
          [
            '## What the owner already decided',
            'This outline is being drafted AGAIN: the previous one was deleted after the owner had',
            'answered questions about it. Their answers below still stand. Build every one of them',
            'into this outline, and do not re-open as a `decision` node anything they settled.',
            '',
            UNTRUSTED_FENCE_LEGEND.join('\n'),
            '',
            ...historyLines(carried),
          ].join('\n'),
          '',
        ]
      : []),
    [
      '## Before anything is broken down',
      'The owner will be asked clarifying questions about this outline before it is expanded.',
      'So write ONLY what the brief, the attached files' +
        (d.mode === 'from_repo' ? ' and the code' : '') +
        ' state, plus assumptions so safe that',
      'nobody would ask about them. Every other assumption you would have to make, every point',
      'the inputs leave open, and every place two inputs conflict becomes its own `decision`',
      '(a choice to make) or `research` (needs investigating) node DIRECTLY under the root, with',
      'a body that states the question and the alternatives you see. Those nodes are what the',
      'owner will be asked about, so do not resolve them yourself. They do not count against the',
      'limit on major parts above.',
      ...(d.mode === 'from_repo'
        ? [
            '',
            'Give every one of those open `decision` and `research` nodes `"status": "todo"`',
            'explicitly: a node with no status is recorded as already built.',
          ]
        : []),
    ].join('\n'),
    '',
  ];
}

function briefLines(d: PlanBuildDetect): string[] {
  return [
    d.brief ? `What the owner wrote about it:\n${d.brief}` : 'The owner wrote no description.',
    '',
    ...(d.inputIndexPath
      ? [
          `Attached files are listed in ${d.inputIndexPath}; read it first, along with the files it`,
          'names, before deciding what is still open.',
          '',
        ]
      : []),
  ];
}

/** An answer as a prompt states it. Typed text is the owner speaking and stays unfenced; a
 *  clicked suggestion is the questioner's text, which a repository it read could have steered. */
function answerLines(a: ClarifyAnswer): string[] {
  return a.suggested
    ? ['The owner picked this answer the questioner had suggested:', fencedAgentBlock(a.answer)]
    : [`The owner answered: ${a.answer}`];
}

/** Earlier rounds as the next agent sees them. The questions and the planner's notes were
 *  written by agents and are fenced; the owner's answers and steering are the operator speaking
 *  and are not. */
function historyLines(rounds: readonly ClarifyRound[]): string[] {
  const out: string[] = [];
  for (const r of rounds) {
    if (!r.answered || r.round === 0) continue;
    out.push(`### Round ${r.round}`);
    for (const q of r.questions) {
      const answer = r.answers?.find((a) => a.questionId === q.id);
      const verdict = r.outcome?.verdicts.find((v) => v.questionId === q.id);
      out.push(`Question \`${q.id}\`:`, fencedAgentBlock(q.question));
      out.push(...(answer ? answerLines(answer) : ['The owner did not answer it.']));
      if (verdict) {
        out.push(`Planner's verdict: ${verdict.status}`);
        if (verdict.note) out.push(fencedAgentBlock(verdict.note));
      }
      out.push('');
    }
    if (r.steer) out.push(`The owner also said: ${r.steer}`, '');
  }
  return out.length > 0 ? out : ['(no earlier rounds)'];
}

export function buildAskPrompt(
  d: PlanBuildDetect,
  planMarkdown: string,
  rounds: readonly ClarifyRound[],
): string {
  return [
    `You are the questioner for the plan of "${collapseToLine(d.repoName)}". The plan below is only an`,
    'outline. Before it is broken down further, its owner answers your questions, so that what',
    'gets built is what they intend rather than what an agent assumed.',
    '',
    REPO_IS_DATA_ONE_CLASS_LINES.join('\n'),
    '',
    UNTRUSTED_FENCE_LEGEND.join('\n'),
    '',
    ...briefLines(d),
    '## The outline so far',
    fencedAgentBlock(planMarkdown),
    '',
    '## Earlier rounds',
    ...historyLines(rounds),
    '',
    '## What to do',
    `Ask at most ${MAX_QUESTIONS_PER_ROUND} questions whose answers would change the SHAPE of the`,
    'plan: what is in or out of scope, who the users are, the platforms and integrations, the',
    'data it holds, hard constraints (budget, deadline, hosting, compliance), and every open',
    '`decision` or `research` node in the outline. Look for assumptions the outline makes',
    'silently, and for places where the brief, the files and earlier answers contradict each',
    'other — name both sides of a contradiction in the question.',
    '',
    'Ask FIRST about every answer the planner marked `open`: say what was still unclear and',
    'ask it more precisely, under the same `id` the question had, so the owner sees it was',
    'asked before. Do not ask again what an earlier answer already settled.',
    '',
    'For each question give up to 4 short suggested answers the owner can click instead of',
    'typing, the likely options rather than every option. They can always write their own.',
    '',
    'Do not change any file or the plan. You only ask.',
    '',
    '## How to reply',
    'Reply with ONE ```json fenced block:',
    '```json',
    '{',
    '  "questions": [',
    '    { "id": "kebab-case-id", "topic": "1-4 words", "question": "One concrete question?",',
    '      "why": "What in the plan depends on the answer.",',
    '      "suggestions": ["short answer", "another"] }',
    '  ],',
    '  "nothingOpen": false',
    '}',
    '```',
    'Use `"nothingOpen": true` with an empty list ONLY when no answer could still change the',
    'plan. An empty list without it is treated as a failed reply.',
  ].join('\n');
}

export function buildIntegratePrompt(
  d: PlanBuildDetect,
  planMarkdown: string,
  rounds: readonly ClarifyRound[],
  round: ClarifyRound,
): string {
  const answered = round.questions.filter((q) => round.answers?.some((a) => a.questionId === q.id));
  const qa = answered.flatMap((q) => [
    `### \`${q.id}\``,
    fencedAgentBlock(q.question),
    ...answerLines(round.answers!.find((a) => a.questionId === q.id)!),
    '',
  ]);
  return [
    `You are shaping the outline of the plan for "${collapseToLine(d.repoName)}" with its owner, who`,
    'has just answered questions about it.',
    '',
    REPO_IS_DATA_AUTHORING_LINES.join('\n'),
    '',
    UNTRUSTED_FENCE_LEGEND.join('\n'),
    '',
    ...briefLines(d),
    'Here is the outline. Each node shows its id, kind, status, version and links.',
    '',
    fencedAgentBlock(planMarkdown),
    '',
    '## Earlier rounds',
    ...historyLines(rounds.filter((r) => r.round < round.round)),
    '',
    `## Round ${round.round}`,
    ...(qa.length > 0 ? qa : ['(no question was answered this round)', '']),
    ...(round.steer ? [`The owner also said: ${round.steer}`, ''] : []),
    '## What to do',
    'Fold what the owner said into the outline by PATCHING it:',
    '- An answer that settles an open `decision` or `research` node: append a `## Decision`',
    '  section to its body with the answer, and set its status to `done`.',
    '- An answer that changes scope: add, rename, rewrite or delete the parts it affects.',
    '- What the owner said beyond the questions is a direction from them: follow it.',
    '- A new open question their answers raise: a new `decision` node.',
    '',
    'Keep it an OUTLINE. Every new node goes DIRECTLY under the root; do not break a part down',
    '— that happens after these questions, and a node placed under a part is dropped.',
    ...(d.mode === 'from_repo'
      ? ['A node you create for something the code already implements gets `"status": "done"`.']
      : ['Nothing is built yet: leave the status of parts alone.']),
    '',
    'Then judge each answer. `settled` means it is in the plan and nothing about it needs asking',
    'again. `open` means it is ambiguous, incomplete, or contradicts the brief or another answer;',
    'say in `note` exactly what is still unclear, because the next question is built from it.',
    'Add this array to the same JSON object as your ops:',
    '```json',
    '"verdicts": [ { "questionId": "<id>", "status": "settled", "note": "" } ]',
    '```',
    '',
    PLAN_PATCH_CONTRACT,
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* Form                                                                */
/* ------------------------------------------------------------------ */

export function buildClarifyForm(rounds: readonly ClarifyRound[]): FormSchema | null {
  const round = rounds.at(-1);
  if (!round || round.answered) return null;
  const settled = rounds
    .filter((r) => r.integrated)
    .flatMap((r) =>
      (r.outcome?.verdicts ?? [])
        .filter((v) => v.status === 'settled')
        .map((v) => {
          const q = r.questions.find((x) => x.id === v.questionId);
          const a = r.answers?.find((x) => x.questionId === v.questionId);
          return q && a ? `- **${q.question}** ${a.answer}` : null;
        })
        .filter((line): line is string => line !== null),
    );
  const previous = rounds.at(-2);
  const dropped = previous?.outcome?.dropped ?? [];
  const reasked = new Map(
    (previous?.outcome?.verdicts ?? [])
      .filter((v) => v.status === 'open' && v.note)
      .map((v) => [v.questionId, v.note]),
  );

  return {
    title: `Clarifying questions, round ${round.round}`,
    description: [
      round.nothingOpen
        ? 'The questioner found nothing left open in the outline. Add anything you want changed below, or build the plan.'
        : 'Answer what you can and skip the rest. A short or unclear answer is fine: the planner says what is still open and it is asked again, more precisely.',
      '',
      'The outline on the Plan view already shows what the answers changed so far.',
    ].join('\n'),
    infoSections: [
      ...(settled.length > 0
        ? [
            {
              title: 'Settled so far',
              preview: `${settled.length} answer(s) in the plan`,
              body: settled.join('\n'),
            },
          ]
        : []),
      ...(dropped.length > 0
        ? [
            {
              title: 'Changes the planner could not make',
              preview: `${dropped.length} change(s) left out`,
              body: dropped.map((x) => `- ${x}`).join('\n'),
            },
          ]
        : []),
    ],
    fields: [
      ...(round.questions.length > 0
        ? [
            {
              type: 'accordion' as const,
              id: `questions__r${round.round}`,
              label: `Questions (${round.questions.length})`,
              items: round.questions.map((q) => ({
                title: q.question,
                description: [
                  q.topic ? `Topic: ${q.topic}` : '',
                  q.why ? `Why it matters: ${q.why}` : '',
                  reasked.has(q.id) ? `Asked again: ${reasked.get(q.id)}` : '',
                ]
                  .filter(Boolean)
                  .join('\n'),
                defaultOpen: true,
                fields: [
                  {
                    type: 'radio-with-textarea' as const,
                    id: answerFieldId(round.round, q.id),
                    label: 'Your answer',
                    predefined: q.suggestions.map((s) => ({ value: s, label: s })),
                    customLabel: 'My own answer',
                    placeholder: 'Type your answer, or leave it blank to skip.',
                    rows: 3,
                  },
                ],
              })),
            },
          ]
        : []),
      {
        type: 'textarea',
        id: steerFieldId(round.round),
        label: 'Anything else the planner should know or change (optional)',
        description:
          'Steer the plan your own way: scope to add or drop, constraints, things the questions missed.',
        rows: 4,
      },
      {
        type: 'radio',
        id: actionFieldId(round.round),
        label: 'Then',
        options: [
          { value: 'continue', label: 'Fold these in and ask me more' },
          { value: 'build', label: 'Fold these in and build the plan now' },
        ],
        default: round.nothingOpen ? 'build' : 'continue',
        required: true,
      },
    ],
    submitLabel: 'Send answers',
  };
}
