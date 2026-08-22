import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { CONFIG_KEYS, configService } from '@haive/shared';
import { MiningRetryError, MiningWaveError } from '../../step-definition.js';
import type {
  StepContext,
  StepDefinition,
  AgentMiningDispatch,
  AgentMiningResult,
} from '../../step-definition.js';
import {
  didNotCompleteIssue,
  miningOutcome,
  shouldRerollMiningAgent,
  shouldRetryMiningTerminalFailure,
} from '../../mining-failure.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';
import { resolveSpecView } from './_spec-artifact.js';
import { agentDefinitionGuidance, retrievalGuidanceLines } from '../_retrieval-guidance.js';
import { REPO_IS_DATA_LINES } from '../_untrusted-repo.js';
import { appAuthPromptLines, type AppLoginOutcome } from './_app-auth.js';
import { hasAnyKey, parseAgentJson, parseReviewJson } from './_agent-json.js';
import {
  changedFilesBlock,
  collectImplementationFiles,
  fileCoverage,
  type FileCoverage,
  type ImplementationFileSet,
} from './_impl-changes.js';
import { loadAppBootOutput } from './_task-meta.js';
import { resolveAppReach } from '../../../queues/cli-exec/app-reach.js';
import { INSIGHTS_INSTRUCTION } from './08e-insights-triage.js';
import { PROMPT_DEFECT_INSTRUCTION } from './_prompt-defect.js';
import { isStepGuidanceEnabled } from '../../guidance-context.js';
import { coerceReviewSeverity, isBlockingSeverity, severityRank } from '@haive/shared/review';
import type { ReviewSeverity } from '@haive/shared/review';
import { findingFingerprint, recordReviewFindings, splitLocation } from './_review-findings.js';

// Phase 7 — Adversarial QA (legacy phase7-adversarial-qa.md). Opt-in per task
// (tasks.adversarial_qa_level: poc|standard|enterprise). After code review and
// before gate 2, N adversarial agents actively try to BREAK the change — edge
// cases, auth bypass, injection, logic flaws — and report proof-of-concept
// findings. Proof-of-concept only: no persistence, no data deletion, no prod
// disruption. Findings are reviewed by the human at gate 1.5 (08d2-adversarial-qa-
// review): it decides whether to send them back to implementation or accept them,
// and they also surface at gate 2. Formless; gated by shouldRun.
//
// Each prompt defers to the repo's onboarded adversarial agent definition
// (.claude/agents/<id>.md — Haive onboards all six) when present, and embeds a
// condensed persona inline as the fallback, the same convention as 08a/08b/08c.

const QA_TIMEOUT_MS = 45 * 60 * 1000;

type QaLevel = 'poc' | 'standard' | 'enterprise';

interface AdversaryDef {
  id: string;
  title: string;
  persona: string;
}

// Roster, cumulative by level (poc ⊂ standard ⊂ enterprise).
const ADVERSARIES: AdversaryDef[] = [
  {
    id: 'edge-case-breaker',
    title: 'Edge Case Breaker',
    persona:
      'Attack boundaries and degenerate inputs: null/empty/whitespace, zero and negative, max/overflow, huge payloads, unicode and encoding tricks, missing/extra fields, and concurrent/duplicate requests. Find inputs the change mishandles.',
  },
  {
    id: 'workflow-disruptor',
    title: 'Workflow Disruptor',
    persona:
      'Break the user flow: out-of-order steps, double-submit, back/forward navigation, refresh mid-flow, abandoned sessions, and state that survives when it should not. Find flows that corrupt or leak state.',
  },
  {
    id: 'auth-bandit',
    title: 'Auth Bandit',
    persona:
      'Attack authentication and authorization: missing access checks, horizontal/vertical privilege escalation, IDOR, session fixation/replay, and forced browsing to privileged paths. Find any privileged action reachable without the right identity.',
  },
  {
    id: 'injection-infector',
    title: 'Injection Infector',
    persona:
      'Attempt injection at every untrusted sink: SQL/NoSQL, XSS (stored/reflected), command, template, header, and path traversal. Trace each input to its sink and confirm exploitability with a non-destructive proof.',
  },
  {
    id: 'logic-lunatic',
    title: 'Logic Lunatic',
    persona:
      'Attack business logic: race conditions, time-of-check/time-of-use, negative-quantity and rounding abuse, replayed or reordered operations, and invariant violations. Find ways to reach an impossible or unfair state.',
  },
  {
    id: 'chaos-creator',
    title: 'Chaos Creator',
    persona:
      'Think laterally: combine weaknesses, abuse error paths and partial failures, exhaust resources, and exploit framework-specific defaults. Find the creative attack the other reviewers would miss.',
  },
];

function rosterForLevel(level: QaLevel): AdversaryDef[] {
  if (level === 'poc') return ADVERSARIES.slice(0, 2);
  if (level === 'standard') return ADVERSARIES.slice(0, 4);
  return ADVERSARIES.slice(0, 6);
}

interface AdversarialDetect {
  level: QaLevel;
  spec: string;
  implementationFiles: ImplementationFileSet;
  appUrl: string | null;
  /** The session 08a left the shared browser in. 08d drives the SAME browser, so this
   *  is inherited rather than established — it only has to be stated. */
  appLogin: AppLoginOutcome | null;
  debtBlock: string;
  /** Learned-guidance capture is on for this task: each adversary is invited to name an
   *  INSTRUCTION defect behind what it found. Resolved in detect() and carried on the
   *  payload because the prompt builder is pure. */
  promptDefectCapture: boolean;
}

interface AdversarialFinding {
  severity: ReviewSeverity;
  category?: string;
  location?: string;
  poc?: string;
  impact?: string;
  fix?: string;
  /** What the verifier panel made of this finding's PoC. Only blocking findings are
   *  verified, so everything else stays undefined and reads as unverified.
   *
   *  `not_reproduced` DOWNGRADES: the finding stops blocking but is still shown at gate
   *  1.5, labelled. It is deliberately not a dismissal — the developer keeps the call,
   *  which is why the recorded row's disposition stays `open` rather than becoming
   *  `dismissed_refuted`.
   *
   *  `untestable` is NOT a downgrade: the panel never got to run the PoC at all. Kept
   *  distinct from `unverified` only so gate 1.5 can say which one it was — both block. */
  verification?: 'reproduced' | 'not_reproduced' | 'unverified' | 'untestable';
}

interface AdversarialApply {
  /** True when a roster was DISPATCHED — not when one of them succeeded. Gate 2 skips its
   *  whole adversarial row on `ran: false`, so keying this on success meant a roster that
   *  was entirely killed rendered as "no QA step ran" instead of "QA did not complete". */
  ran: boolean;
  level: QaLevel | null;
  findings: AdversarialFinding[];
  counts: { critical: number; high: number; total: number };
  blocking: boolean;
  /** At least one adversary left a hole: killed before finishing, or unreadable output.
   *  Non-blocking (the agent failed, not the code) but never OK at gate 2. */
  qaIncomplete: boolean;
  /** How much of the change the adversaries were actually given as attack surface; null
   *  when the step replayed a pre-coverage detect output. */
  coverage: FileCoverage | null;
}

const adversaryOutputSchema = z.object({
  verdict: z.enum(['PASS', 'NEEDS_FIXES', 'FAIL']).optional(),
  findings: z
    .array(
      z.object({
        severity: z
          .unknown()
          .optional()
          .transform((v) => coerceReviewSeverity(v, 'low')),
        category: z.string().optional(),
        location: z.string().optional(),
        poc: z.string().optional(),
        impact: z.string().optional(),
        fix: z.string().optional(),
      }),
    )
    .default([]),
});

/** Parse one adversarial agent's JSON; null when unparseable. */
export function parseAdversaryOutput(raw: unknown): AdversarialFinding[] | null {
  return parseReviewJson(raw, (candidate) => {
    const parsed = adversaryOutputSchema.safeParse(candidate);
    if (!parsed.success) return null;
    return parsed.data.findings;
  });
}

/* --------------------------------------------------------------------------- */
/* PoC verification. A blocking adversarial finding sends the whole change back   */
/* to be reimplemented, and until this existed nothing checked one: 08d's header  */
/* says its findings "are reviewed by the human at gate 1.5", so a PoC that does  */
/* not run, does not do what it claims, or names code unconnected to the          */
/* behaviour cost the developer an afternoon to discover. 08c has refuted its     */
/* blocking findings for a while; this is the same idea on a running app.         */
/*                                                                               */
/* REPRODUCER, not 08c's refuter. 08c's claims are static and refutable by        */
/* reading, which is why its bar is a cited file:line. These are runtime claims,  */
/* so the verifier EXECUTES the PoC and reports what it saw. Reproduction         */
/* confirms; non-reproduction refutes.                                            */
/* --------------------------------------------------------------------------- */

const QA_VERIFY_PREFIX = 'qaverify-';

/** Blocking findings verified per round. Same reason 08c caps its refuters: a round that
 *  raises twenty blocking findings must not spend sixty invocations proving them. */
const MAX_VERIFIED = 8;

/** The angles one PoC is verified from. Each lens changes where a verifier spends its
 *  effort; none of them changes the bar for a downgrade, which is the same for all three.
 *
 *  Three rather than one because a single generic verifier finds the first reason a PoC
 *  looks fine and stops — and the three map the distinct ways a PoC can be wrong while
 *  still appearing to work: it never ran, it ran against something that only exists in
 *  this sandbox, or it ran and succeeded for a reason unrelated to the code blamed. */
const VERIFY_LENSES = [
  {
    id: 'execute',
    title: 'executes',
    lines: [
      'YOUR LENS: EXECUTION. Run the PoC exactly as written. Does it run at all, and does it',
      'produce the observable the finding claims — the status code, the response body, the',
      'state change, the error? A PoC that 404s, is refused, needs a step the finding never',
      'mentions, or produces something milder than claimed has not demonstrated the finding.',
    ],
  },
  {
    id: 'target',
    title: 'target real',
    lines: [
      'YOUR LENS: TARGET. Is the thing being broken real, and would it exist in a DEFAULT',
      'installation? A file this sandbox happens to have, a half-finished installer state, a',
      'debug setting this environment turned on, or a fixture another agent created is not a',
      'property of the project. Check how the target got there before accepting it.',
    ],
  },
  {
    id: 'linkage',
    title: 'code linkage',
    lines: [
      'YOUR LENS: LINKAGE. The finding blames specific code. Read it, and decide whether it is',
      'what actually produces the behaviour you observed. A PoC can succeed for an unrelated',
      'reason — a different handler, a web-server rule, a redirect — while the cited code is',
      'never reached. If the citation does not explain the observation, say so.',
    ],
  },
] as const;

type VerifyLens = (typeof VERIFY_LENSES)[number];

/** Lenses one PoC is verified through. Below the full panel this runs ONE generic verifier
 *  rather than a subset, for 08c's reason: a two-lens panel cannot be unanimous about what
 *  the third would have caught, which is a worse bargain than one honest generalist. */
function verifyLensesFor(lensCount: number): (VerifyLens | null)[] {
  return lensCount >= VERIFY_LENSES.length ? [...VERIFY_LENSES] : [null];
}

/** Deterministic, so the id is the same on the apply() that dispatches the wave and the
 *  apply() that reads it back. Keyed on the finding, suffixed by lens — the same shape as
 *  08c's refuters, and the reason the LENS rather than this id is the configurable seat. */
function verifierAgentId(fingerprint: string, lens: VerifyLens | null): string {
  return `${QA_VERIFY_PREFIX}${fingerprint.slice(0, 16)}${lens ? `-${lens.id}` : ''}`;
}

/** Is this finding's proof one that can only be run against a live endpoint?
 *
 *  Keyed on the LOCATION parsing as an http(s) URL, which the adversary prompt asks for
 *  explicitly ("file:line or URL") — a structural signal, not a guess at what the PoC prose
 *  means. Deliberately not a scan of `poc` for words like "curl": that would be reading an
 *  ephemeral value, and getting it wrong here silently drops a finding from verification.
 *
 *  A file:line finding is NOT runtime-only even when its PoC mentions a request: the verifier
 *  can still read the code path and say what it found. Only the ones with nowhere to point a
 *  request are skipped. */
export function isRuntimeOnlyFinding(f: Pick<AdversarialFinding, 'location'>): boolean {
  const loc = f.location?.trim();
  if (!loc) return false;
  try {
    return ['http:', 'https:'].includes(new URL(loc).protocol);
  } catch {
    return false;
  }
}

/** The reviewer-agnostic key a finding is verified under. findingFingerprint with an empty
 *  reviewer id — the same call 08c uses to collapse one bug reported by two reviewers. */
function verifyKey(f: AdversarialFinding): string {
  const { path } = splitLocation(f.location);
  return findingFingerprint('', path, f.impact ?? f.category ?? '');
}

/** The verifier's report. `reproduced` is deliberately NOT a plain boolean.
 *
 *  A verifier that cannot reach the app has, with only true/false available, no way to say
 *  so — and its honest write-up ("no network route from this sandbox, curl
 *  https://x.ddev.site/ failed") clears `hasObservation` on the strength of the URL alone.
 *  An environmental fault then parses as a legitimate non-reproduction, and because every
 *  lens shares the same broken network the failures are perfectly correlated, so the
 *  all-lenses-must-agree rule below buys nothing against it. A real defect gets downgraded.
 *
 *  The fix is structural rather than a pattern that rejects unreachability prose: the wording
 *  of a CLI's connection error is an ephemeral value and would break the day it is reworded,
 *  silently and in the unsafe direction. */
const verifySchema = z.object({
  reproduced: z.union([z.boolean(), z.literal('could_not_test')]),
  observation: z.string().optional(),
});

/** Does the verifier's prose actually report something it SAW?
 *
 *  The runtime analogue of 08c's `hasFileLineEvidence`, and structural in exactly the same
 *  way: it proves the verifier wrote down a concrete artefact, not that the artefact is
 *  true. A bare "I could not reproduce this" is what it exists to reject, because that
 *  sentence is free to write and would silently downgrade a real defect.
 *
 *  A status code, a URL, or a quoted fragment is what a real observation carries; the
 *  length floor stops a lone stray number passing as one. */
const OBSERVATION_RE = /https?:\/\/|`[^`]+`|\b\d{3}\b/;
const MIN_OBSERVATION_CHARS = 40;

export function hasObservation(text: unknown): boolean {
  return (
    typeof text === 'string' &&
    text.trim().length >= MIN_OBSERVATION_CHARS &&
    OBSERVATION_RE.test(text)
  );
}

/** One verifier's verdict, or null when it did not give a usable one. Null covers the
 *  unparseable, the killed, and — deliberately — the negative with nothing observed.
 *
 *  `could_not_test` carries no observation requirement: the whole point of it is that there
 *  was nothing to observe. It is not a vote against the finding, so it can never downgrade
 *  one. */
export function verifyVerdict(
  raw: unknown,
): 'reproduced' | 'not_reproduced' | 'could_not_test' | null {
  // parseAgentJson with our OWN key gate, not parseReviewJson: that one admits only
  // candidates carrying `verdict` or `findings` — a reviewer's report shape — and a
  // verifier emits neither, so it would reject every valid verdict. Same reason 08c's
  // isRefuted gates on `refuted` itself.
  const parsed = parseAgentJson(raw, (candidate) => {
    if (!hasAnyKey(candidate, ['reproduced'])) return null;
    const r = verifySchema.safeParse(candidate);
    return r.success ? r.data : null;
  });
  if (!parsed) return null;
  if (parsed.reproduced === 'could_not_test') return 'could_not_test';
  if (parsed.reproduced) return 'reproduced';
  return hasObservation(parsed.observation) ? 'not_reproduced' : null;
}

/** The panel's verdict for one finding.
 *
 *  ANY lens reproducing it settles it — one successful reproduction is a demonstration,
 *  and the other lenses failing to repeat it does not undo that. A downgrade needs EVERY
 *  lens to report non-reproduction WITH an observation; one silent, unreadable, killed or
 *  unevidenced voter leaves the finding standing.
 *
 *  That is 08c's asymmetry applied here: gate 1.5 defaults to accepting what it is shown,
 *  so a wrongly-downgraded RCE is worse than a blocking finding the developer waves off.
 *
 *  `untestable` is the unanimous could-not-test, reported separately from `unverified` only
 *  so gate 1.5 can distinguish "nobody could run this" from "the panel disagreed". Both keep
 *  the finding blocking; the ONLY verdict that stops one blocking is still `not_reproduced`. */
export function verificationForFinding(
  results: AgentMiningResult[],
  fingerprint: string,
  lenses: (VerifyLens | null)[],
): 'reproduced' | 'not_reproduced' | 'unverified' | 'untestable' {
  const verdicts = lenses.map((lens) => {
    const outcome = miningOutcome(results, verifierAgentId(fingerprint, lens));
    return outcome.kind === 'done' ? verifyVerdict(outcome.raw) : null;
  });
  if (verdicts.some((v) => v === 'reproduced')) return 'reproduced';
  if (verdicts.length === 0) return 'unverified';
  // Checked before the downgrade, and both are unanimity tests, so a mixed panel — one lens
  // that could not test, one that tested and found nothing — falls through to `unverified`
  // rather than downgrading on the strength of a single voter.
  if (verdicts.every((v) => v === 'could_not_test')) return 'untestable';
  if (verdicts.every((v) => v === 'not_reproduced')) return 'not_reproduced';
  return 'unverified';
}

/** Human terminal label for a verifier: name the finding it is checking and the lens, so a
 *  fan-out of N verifications does not render as N identical terminals. */
export function verifierTitle(
  f: Pick<AdversarialFinding, 'severity' | 'location' | 'impact' | 'category'>,
  index: number,
  total: number,
  lens?: VerifyLens | null,
): string {
  const what = (f.impact ?? f.category ?? 'finding').replace(/\s+/g, ' ').trim().slice(0, 60);
  const where = f.location ? ` @ ${f.location.slice(0, 40)}` : '';
  const which = lens ? ` [${lens.title}]` : '';
  return `Verify ${index + 1}/${total}${which}: [${f.severity}] ${what}${where}`;
}

function buildVerifyPrompt(
  d: AdversarialDetect,
  f: AdversarialFinding,
  lens: VerifyLens | null,
): string {
  return [
    'You are a POC VERIFIER. An adversarial QA agent reported the finding below against a',
    'change, and acting on it will send the whole change back to be reimplemented. Your job',
    'is to RUN its proof-of-concept and report what actually happens — not to agree with it,',
    'not to fix anything, and not to go looking for other problems.',
    '',
    'Reproduced means YOU observed the claimed effect yourself, by executing the PoC as',
    'written. Not that the code looks like it would do that, and not that a similar thing',
    'happened. If the PoC needs a step the finding never mentions, say so and treat it as',
    'not reproduced — a proof a developer cannot follow is not a proof.',
    '',
    ...(lens ? lens.lines : []),
    '',
    ...SAFETY,
    '',
    ...REPO_IS_DATA_LINES,
    '',
    '=== The finding you are verifying ===',
    `Severity as filed: ${f.severity}`,
    `Location: ${f.location ?? '(none given)'}`,
    `Category: ${f.category ?? '(none given)'}`,
    `Impact claimed: ${f.impact ?? '(none given)'}`,
    `Proof of concept: ${f.poc ?? '(none given — that alone is grounds for not reproduced)'}`,
    '',
    // Address and reachability come from the dispatcher's reach block; see buildAdversaryPrompt.
    ...(d.appUrl
      ? appAuthPromptLines(d.appLogin ?? { attempted: false, ok: false, reason: '' })
      : []),
    '',
    'Do NOT edit code and do NOT run git.',
    ...SEARCH_LADDER,
    '',
    'When finished emit ONE JSON object inside a ```json fenced code block with EXACTLY this',
    'shape:',
    '{ "reproduced": true|false|"could_not_test", "observation": "<what you actually saw>" }',
    '',
    'Use "could_not_test" — NOT false — when the ENVIRONMENT stopped you running the PoC at',
    'all: you could not reach the running app, the runtime is down, or the run has no access',
    'to the surface the PoC needs. That is different from the under-specified proof above,',
    'which is a judgement about the finding and stays false. Reporting false here would',
    'downgrade a finding nobody ever tested, which is the one mistake this step cannot',
    'afford. Say what you tried in `observation` anyway.',
    '',
    '`observation` is REQUIRED when you report reproduced:false, and it must record what you',
    'OBSERVED — the request you issued and the status and body you got back, or the command',
    'and its output. "Could not reproduce" on its own is rejected and your verdict is',
    'discarded: it is free to write, and discarding a real defect on it is the one outcome',
    'this check exists to prevent. Quote the concrete artefact.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Roster size per level — exported for the unit test. */
export function adversaryIdsForLevel(level: QaLevel): string[] {
  return rosterForLevel(level).map((a) => a.id);
}

const SEARCH_LADDER = [
  'When you need context, search in this order:',
  ...retrievalGuidanceLines(),
] as const;

const SAFETY = [
  'SAFETY: proof-of-concept ONLY. Do NOT persist changes, delete or corrupt data, exfiltrate',
  'secrets, or disrupt any running service. Demonstrate exploitability with the minimum',
  'non-destructive proof and stop.',
] as const;

function buildAdversaryPrompt(a: AdversaryDef, d: AdversarialDetect): string {
  return [
    agentDefinitionGuidance(
      a.id,
      [
        `If a \`.claude/agents/${a.id}.md\` agent definition exists in the repo, follow it;`,
        'otherwise follow the persona below.',
      ].join('\n'),
    ),
    `You are ${a.title}, an adversarial QA agent. Your job is to BREAK the implemented change.`,
    a.persona,
    '',
    ...SAFETY,
    '',
    ...REPO_IS_DATA_LINES,
    '',
    changedFilesBlock(
      d.implementationFiles,
      'Changed files (attack surface)',
      'Determine the changed files from the workspace.',
    ),
    // The app's address and what can actually dial it are stated by the reach block the
    // dispatcher prepends to every prompt. Repeating the URL here would restate it without
    // the method, which is the shape that had agents reaching for a curl the sandbox could
    // not make. The login state is not in that block, so it stays.
    ...(d.appUrl
      ? appAuthPromptLines(d.appLogin ?? { attempted: false, ok: false, reason: '' })
      : []),
    d.debtBlock ? `\n${d.debtBlock}` : '',
    'Do NOT edit code and do NOT run git.',
    ...SEARCH_LADDER,
    '',
    'When finished emit ONE JSON object inside a ```json fenced code block with EXACTLY this shape:',
    '{ "verdict": "PASS|NEEDS_FIXES|FAIL", "findings": [{ "severity": "critical|high|medium|low", "category": "<attack type>", "location": "file:line or URL", "poc": "<non-destructive proof>", "impact": "<what could happen>", "fix": "<recommendation>" }] }',
    '',
    '=== Spec (the intended behavior) ===',
    d.spec || '(no spec recorded)',
    '',
    INSIGHTS_INSTRUCTION,
    d.promptDefectCapture ? `\n${PROMPT_DEFECT_INSTRUCTION}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export const adversarialQaStep: StepDefinition<AdversarialDetect, AdversarialApply> = {
  metadata: {
    id: '08d-adversarial-qa',
    workflowType: 'workflow',
    index: 8.9,
    title: 'Phase 7: Adversarial QA',
    description:
      'Adversarial agents actively try to break the change (edge cases, auth, injection, logic). Findings surface at gate 2. Opt-in per task.',
    requiresCli: false,
  },

  async shouldRun(ctx: StepContext): Promise<boolean> {
    const task = await ctx.db.query.tasks.findFirst({
      where: eq(schema.tasks.id, ctx.taskId),
      columns: { adversarialQaLevel: true },
    });
    const level = task?.adversarialQaLevel;
    return level === 'poc' || level === 'standard' || level === 'enterprise';
  },

  async detect(ctx: StepContext): Promise<AdversarialDetect> {
    const task = await ctx.db.query.tasks.findFirst({
      where: eq(schema.tasks.id, ctx.taskId),
      columns: { adversarialQaLevel: true },
    });
    const level = (task?.adversarialQaLevel ?? 'poc') as QaLevel;

    const worktree = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-worktree-setup');
    const wt = worktree?.output as { worktreePath?: string } | null;
    const workspace = wt?.worktreePath ?? ctx.workspacePath;

    // Section index + a pointer to the on-disk `.haive/spec.md` gate 1 wrote, not the whole
    // document: this agent is a fresh CLI process that only needs to know what the change
    // must deliver, and can Read any section it needs in full.
    const spec = (await resolveSpecView(ctx)).text;

    const boot = await loadAppBootOutput(ctx.db, ctx.taskId);
    const browser = await loadPreviousStepOutput(ctx.db, ctx.taskId, '08a-browser-verify');
    const browserOut = browser?.output as { appUrl?: string; appLogin?: AppLoginOutcome } | null;
    const appUrl = browserOut?.appUrl ?? boot?.appUrl ?? null;
    // Absent on rows written before app login existed, and on the probe/manual paths
    // that never attempt one — both mean "not logged in", which is what the adversaries
    // are then told.
    const appLogin = browserOut?.appLogin ?? null;

    // DAG debt (07b/08c pattern).
    let debtBlock = '';
    const dagPlan = await ctx.db.query.taskDagPlans.findFirst({
      where: eq(schema.taskDagPlans.taskId, ctx.taskId),
      columns: { mode: true },
    });
    if (dagPlan?.mode === 'dag') {
      const issues = await ctx.db
        .select({
          issueKey: schema.taskDagIssues.issueKey,
          title: schema.taskDagIssues.title,
          debtItems: schema.taskDagIssues.debtItems,
        })
        .from(schema.taskDagIssues)
        .where(eq(schema.taskDagIssues.taskId, ctx.taskId));
      const lines = issues
        .filter((i) => ((i.debtItems ?? []) as unknown[]).length > 0)
        .map((i) => `- ${i.issueKey} (${i.title}): ${JSON.stringify(i.debtItems).slice(0, 500)}`);
      if (lines.length > 0) {
        debtBlock = [
          'KNOWN TECHNICAL DEBT (documented compromises): only flag these if they are actually',
          'exploitable; do not report them as new issues otherwise.',
          ...lines,
        ].join('\n');
      }
    }

    return {
      level,
      spec,
      implementationFiles: await collectImplementationFiles(ctx, workspace),
      appUrl,
      appLogin,
      debtBlock,
      promptDefectCapture: await isStepGuidanceEnabled(ctx.db, ctx.taskId),
    };
  },

  agentMining: {
    // NO toolProfile on purpose — this is the one fan-out that needs the full surface.
    // buildAdversaryPrompt hands each agent the running app's URL "for runtime attacks"
    // and asks for a proof located at a URL, so chrome-devtools and ddev-control are the
    // tools the step is built around. Do not add 'rag_only' here to match its siblings.
    requiredCapabilities: ['tool_use'],
    timeoutMs: QA_TIMEOUT_MS,
    // Same bargain as 08c: an adversary's confirmed exploits are worth banking before
    // the SIGKILL. Its proofs are non-destructive, so it writes nothing to lose. And the
    // same limit: the wind-down is a steer, so a non-steerable provider (codex, gemini,
    // amp, antigravity) gets none and is killed with zero grace.
    softTimeout: true,
    async selectAgents({ detected }): Promise<AgentMiningDispatch[]> {
      // No bypass stub for mining; return [] under test bypass (08c pattern).
      if (process.env.HAIVE_TEST_BYPASS_LLM === '1') return [];
      const d = detected as AdversarialDetect;
      // roleKey === agentId: the roster is a fixed catalog, so each adversary's id is
      // already the stable seat STEP_MINING_SEATS enumerates.
      return rosterForLevel(d.level).map((a) => ({
        agentId: a.id,
        agentTitle: a.title,
        prompt: buildAdversaryPrompt(a, d),
        roleKey: a.id,
      }));
    },
    // One re-roll per adversary. An adversary whose output cannot be read leaves a
    // hole in the attack surface that only shows up as a qa-gap finding; re-rolling
    // it is cheaper than the human deciding what to do about the gap. The same holds
    // for one killed before it finished, which retryOnInvocationFailure re-rolls at the
    // barrier — on the next rung of its per-agent timeout ladder when the cause was a
    // budget kill, since an identical re-run just buys the same kill twice.
    retry: { maxAttempts: 2, retryOnInvocationFailure: shouldRetryMiningTerminalFailure },
  },

  async apply(ctx, args): Promise<AdversarialApply> {
    const allResults: AgentMiningResult[] = args.agentMiningResults ?? [];
    // On the SECOND pass this batch carries the verifier wave as well as the adversaries.
    // The loop below parses every result as adversary output, so an unsplit batch would
    // read each verifier as an adversary that emitted garbage and raise a qa-gap finding
    // for it — inventing holes in the attack surface out of the wave that was checking it.
    const results = allResults.filter((r) => !r.agentId.startsWith(QA_VERIFY_PREFIX));
    const detected = args.detected;

    // Aggregate findings across agents; dedupe by location keeping highest severity.
    const byLocation = new Map<string, AdversarialFinding>();
    const unlocated: AdversarialFinding[] = [];
    const unreadable: string[] = [];
    // Every finding as REPORTED, before the location merge below collapses them, with the
    // adversary and invocation that raised it. The merge keeps one finding per location and
    // drops the rest outright — impact, PoC and fix included — so recording post-merge threw
    // away both the losing finding and any idea of who found what. It also made the loss
    // unmeasurable: the merge runs before the write, so nothing downstream could tell a run
    // with no collisions from one that silently dropped half its findings.
    //
    // This list is TELEMETRY ONLY. `byLocation` / `unlocated` / `findings` and every gate and
    // blocking decision below are untouched, so what reaches the developer is unchanged.
    const reported: {
      finding: AdversarialFinding;
      agentId: string;
      invocationId: string | null;
    }[] = [];
    for (const r of results) {
      const raw = r.status === 'done' ? (r.output ?? r.rawOutput) : null;
      const parsed = raw == null ? null : parseAdversaryOutput(raw);
      if (parsed == null) {
        // The adversary reported nothing usable. Two causes, one consequence: it RAN and
        // emitted output the jsonrepair salvage could not read, or it was KILLED before it
        // finished (budget, orphan, preemption). Neither is evidence of "no vulnerabilities"
        // — re-roll it while it has budget, and once spent surface a visible QA-gap finding
        // so the hole shows at gate 2 instead of passing as a clean attack surface.
        unreadable.push(r.agentId);
        unlocated.push({
          severity: 'medium',
          category: 'qa-gap',
          impact:
            r.status === 'done'
              ? `Adversarial agent "${r.agentId}" produced unparseable output — its findings may be missing; re-run adversarial QA.`
              : didNotCompleteIssue(`Adversarial agent "${r.agentId}"`, r.errorMessage),
        });
        continue;
      }
      for (const f of parsed) {
        reported.push({ finding: f, agentId: r.agentId, invocationId: r.invocationId ?? null });
        const key = (f.location ?? '').trim().toLowerCase();
        if (!key) {
          unlocated.push(f);
          continue;
        }
        const existing = byLocation.get(key);
        // severityRank is ascending in severity: critical=0, low=3.
        if (!existing || severityRank(f.severity) < severityRank(existing.severity)) {
          byLocation.set(key, f);
        }
      }
    }
    // Re-roll the adversaries whose output could not be read, while they have budget.
    // Only these are re-dispatched; the other adversaries' completed rows stand. One that
    // DIED is re-rolled only when its failure was transient — the same veto
    // retryOnInvocationFailure applies at the barrier, which this path used to bypass.
    // `unreadable` stays UNFILTERED for qaIncomplete: an adversary that cannot be re-rolled
    // still leaves a hole in the attack surface.
    const rerollable = unreadable.filter((id) => shouldRerollMiningAgent(results, id));
    if (rerollable.length > 0 && args.isFinalMiningAttempt === false) {
      throw new MiningRetryError(rerollable);
    }

    // Consolidate: sort by severity (critical → low), like the legacy phase-7b consolidator.
    const findings = [...byLocation.values(), ...unlocated].sort(
      (a, b) => severityRank(a.severity) - severityRank(b.severity),
    );
    const critical = findings.filter((f) => f.severity === 'critical').length;
    const high = findings.filter((f) => f.severity === 'high').length;
    // Dispatched, not succeeded — see AdversarialApply.ran.
    const ran = results.length > 0;
    const qaIncomplete = unreadable.length > 0;

    // PoC verification. Blocking findings only: those are the ones that send the change
    // back to be reimplemented, so those are the ones worth spending invocations proving.
    const blockingFindings = findings.filter((f) => isBlockingSeverity(f.severity));
    const waveRan = allResults.some((r) => r.agentId.startsWith(QA_VERIFY_PREFIX));

    // Whether there is a running app to run a PoC against. Resolved on BOTH passes, for the
    // same reason the lens count is: the pass that dispatches and the pass that reads back
    // have to agree about which findings were sent, or a finding excluded from the wave comes
    // back looking like one whose panel went silent. Only paid for when there is something to
    // verify.
    const reach =
      blockingFindings.length > 0 ? await resolveAppReach(ctx.db, ctx.taskId) : { mode: 'none' };
    const provablyUntestable = (f: AdversarialFinding): boolean =>
      reach.mode === 'none' && isRuntimeOnlyFinding(f);

    if (waveRan) {
      // Lens count is read on BOTH passes — the one that dispatches and the one that reads
      // back — so the agent ids cannot disagree. An admin who changes it mid-step leaves the
      // panel short a voter, which fails closed (a missing verdict keeps the finding).
      const lenses = verifyLensesFor(
        await configService.getNumber(CONFIG_KEYS.QA_VERIFY_LENSES, VERIFY_LENSES.length),
      );
      for (const f of blockingFindings) {
        const panel = verificationForFinding(allResults, verifyKey(f), lenses);
        // The panel wins whenever it actually said something. The reach is re-probed on this
        // pass and can disagree with the one that dispatched — a runner recovering between
        // the two passes must not discard a verdict that was genuinely recorded, least of all
        // a reproduction. Only the findings that were skipped come back with nothing at all,
        // and those are the ones this relabels from `unverified` to the truer `untestable`.
        f.verification = panel === 'unverified' && provablyUntestable(f) ? 'untestable' : panel;
      }
      const downgraded = blockingFindings.filter((f) => f.verification === 'not_reproduced');
      if (downgraded.length > 0) {
        ctx.logger.info(
          { blocking: blockingFindings.length, downgraded: downgraded.length },
          'adversarial QA: blocking findings whose PoC no verifier could reproduce (shown as advisory, not dismissed)',
        );
      }
      // Distinct signal, not a variant of the line above: this one says the ENVIRONMENT
      // failed, not the finding. It is the operator's cue that the panel is running blind.
      const untestable = blockingFindings.filter((f) => f.verification === 'untestable');
      if (untestable.length > 0) {
        ctx.logger.warn(
          { blocking: blockingFindings.length, untestable: untestable.length },
          'adversarial QA: blocking findings no verifier could test at all (still blocking)',
        );
      }
    } else if (args.miningWaveExhausted !== true && blockingFindings.length > 0) {
      if (await configService.getBoolean(CONFIG_KEYS.QA_VERIFY_ENABLED, true)) {
        const lenses = verifyLensesFor(
          await configService.getNumber(CONFIG_KEYS.QA_VERIFY_LENSES, VERIFY_LENSES.length),
        );
        // A finding located at a URL, with no app running, cannot be verified by anyone: the
        // panel would spend three invocations to report could_not_test unanimously. Dropped
        // from the wave and marked untestable directly, which blocks exactly the same.
        const verifiable = blockingFindings.filter((f) => !provablyUntestable(f));
        if (verifiable.length < blockingFindings.length) {
          ctx.logger.warn(
            {
              blocking: blockingFindings.length,
              untestable: blockingFindings.length - verifiable.length,
            },
            'adversarial QA: no running app, so runtime findings go to the gate untested (still blocking)',
          );
        }
        // Worst first (severityRank ascending in severity), so a capped wave spends its
        // invocations on the findings that cost most if they are wrong.
        const wave = [...verifiable]
          .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
          .slice(0, MAX_VERIFIED);
        if (wave.length < verifiable.length) {
          ctx.logger.warn(
            { total: verifiable.length, verifying: wave.length },
            'more blocking findings than verifiers; the overflow goes to the gate unverified',
          );
        }
        if (wave.length === 0) {
          // Nothing left to check: every blocker is a runtime one and nothing is running.
          // Marked here and NOT dispatched — an empty MiningWaveError would park the step on
          // a fan-out with no agents in it, waiting for verdicts that can never arrive.
          for (const f of blockingFindings) f.verification = 'untestable';
        } else {
          ctx.logger.info(
            { count: wave.length, lenses: lenses.length },
            'dispatching PoC verifiers for blocking adversarial findings',
          );
          throw new MiningWaveError(
            wave.flatMap((f, i) =>
              lenses.map((lens) => ({
                agentId: verifierAgentId(verifyKey(f), lens),
                agentTitle: verifierTitle(f, i, wave.length, lens),
                prompt: buildVerifyPrompt(detected, f, lens),
                // The agent id is per-FINDING and unbounded; the LENS is the stable seat.
                roleKey: lens ? `qa-verify:${lens.id}` : 'qa-verify',
              })),
            ),
          );
        }
      }
    }

    // A finding whose PoC no verifier could reproduce stops blocking. It is NOT removed:
    // it stays in `findings` and reaches gate 1.5 labelled, because the developer keeps the
    // call. Anything unverified still blocks — doubt keeps the finding.
    const blocking = blockingFindings.some((f) => f.verification !== 'not_reproduced');

    // Recorded PRE-dedupe, one row per adversary that actually reported the finding, so
    // `reviewer_id` names an adversary the way the column's own contract says it should
    // and a finding stays attributable to the model that raised it. The merge above still
    // decides everything the developer sees; this only stops the losers vanishing.
    //
    // Identity-based membership: the survivors are the exact objects the merge kept, so a
    // finding that lost is not in the set even when a sibling elsewhere reads identically.
    const survivors = new Set<AdversarialFinding>(findings);
    // Counted over `reported`, NOT as findings.length - survivors.size: `unlocated` also
    // collects the synthetic qa-gap entries raised for unreadable agents, which no adversary
    // reported, so differencing the two totals would under-count and can go negative.
    const dropped = reported.filter(({ finding }) => !survivors.has(finding)).length;
    if (dropped > 0) {
      // The number that decides whether the location-only dedupe key is worth widening.
      // Nothing recorded it before, which is why the loss could never be quantified.
      ctx.logger.info(
        { reported: reported.length, dropped },
        'adversarial QA: findings merged away by the location dedupe (recorded, not gated)',
      );
    }
    await recordReviewFindings(
      ctx,
      '08d-adversarial-qa',
      reported
        .filter(({ finding: f }) => (f.impact ?? f.category ?? '').trim().length > 0)
        .map(({ finding: f, agentId, invocationId }) => {
          const { path, lines } = splitLocation(f.location);
          return {
            reviewerId: agentId,
            cliInvocationId: invocationId,
            severity: f.severity,
            issue: f.impact || (f.category as string),
            path,
            lines,
            fix: f.fix,
            // Honest to the column's meaning: "contributed to the step's blocking
            // decision". A finding the merge dropped contributed nothing, however severe
            // it reads on its own — and neither did one the verifier panel downgraded,
            // which is why this mirrors the `blocking` computed above rather than
            // re-deriving from severity.
            blocking:
              survivors.has(f) &&
              isBlockingSeverity(f.severity) &&
              f.verification !== 'not_reproduced',
            // `raw` is the finding object, so it carries `verification` for free — the
            // observation itself lives in the verifier's own invocation output.
            raw: f,
          };
        }),
    );

    ctx.logger.info(
      {
        level: detected.level,
        agents: results.length,
        findings: findings.length,
        blocking,
        qaIncomplete,
        unreadable,
      },
      'adversarial QA complete',
    );

    return {
      ran,
      level: ran ? detected.level : null,
      findings,
      counts: { critical, high, total: findings.length },
      blocking,
      qaIncomplete,
      coverage: fileCoverage(detected.implementationFiles),
    };
  },
};
