import { createHash } from 'node:crypto';
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
import { recordLedgerEntry } from '../../task-ledger.js';
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
  /** What the verifier panel made of this finding's PoC. EVERY finding with a PoC is
   *  verified, at a panel size matched to what a wrong verdict costs: blocking findings get
   *  the full unanimity panel, the rest get one generic verifier (see verificationTiers).
   *  A finding with no PoC, or one past its tier's cap, stays undefined and reads unverified.
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

/** Blocking root-cause GROUPS verified per round — not findings; one panel now answers for
 *  every finding sharing a cause. Same reason 08c caps its refuters: a round that raises
 *  twenty blocking findings must not spend sixty invocations proving them. */
const MAX_VERIFIED = 8;

/** Non-blocking root-cause GROUPS verified per round. Higher than MAX_VERIFIED because each
 *  costs ONE invocation rather than a panel, and because volume is exactly the problem here: a
 *  round that raised 26 findings, none of them blocking, verified nothing at all and handed all
 *  26 to a human to triage by hand. */
const MAX_VERIFIED_ADVISORY = 20;

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
 *  apply() that reads it back. Keyed on the root-cause GROUP, suffixed by lens — the same
 *  shape as 08c's refuters, and the reason the LENS rather than this id is the configurable
 *  seat.
 *
 *  Hashed rather than truncated: a group key is a path, and two paths sharing their first 16
 *  characters (`installer/actions_step_4.php` and `installer/actions_step_7.php` share 22)
 *  would collide onto one agent id and silently answer for each other's findings. */
export function verifierAgentId(groupKey: string, lens: VerifyLens | null): string {
  const hash = createHash('sha256').update(groupKey).digest('hex').slice(0, 16);
  return `${QA_VERIFY_PREFIX}${hash}${lens ? `-${lens.id}` : ''}`;
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

/** A file-like token: `functions.php`, `installer/rs2.php`, and — the case a naive pattern
 *  misses — a DOTFILE such as `.htaccess`, which has no word character before the dot.
 *  Deliberately not `FILE_LINE_EVIDENCE_RE` from _review-findings.ts: that one requires a
 *  trailing `:line`, and most of these locations do not carry one.
 *
 *  The extension repeats so a double one is taken whole: stopping at the first `\b` would
 *  read `a.test.ts` as `a.test` and put it in the same group as `a.test.js`.
 *
 *  The leading `\.?` is what separates a dotfile from a dot-DIRECTORY. Without it the first
 *  match on `.ddev/php/rs.ini` is the bare `.ddev`, which read as a dotfile and put every file
 *  under that directory in one group — MEASURED on the first live run, where
 *  `.ddev/apache/rs-hardening.conf`, `.ddev/php/dev-prepend.php` and `.ddev/php/rs.ini` shared
 *  a panel. `.htaccess` still matches: the optional prefix gives up and the extension branch
 *  takes the whole token. */
const FILE_TOKEN_RE = /(?:\.?[\w/-]+)?(?:\.[A-Za-z][A-Za-z0-9]{0,11})+\b/g;

/** The ROOT CAUSE a finding is verified under — the unit of one verifier panel.
 *
 *  Measured on the first production run: of 10 blocking findings, 6 named
 *  `installer/contents_step_7.php` and 2 named `installer/actions_step_4.php`, from 5 different
 *  adversaries, and every disproof came back with the same observation because they share a
 *  precondition rather than a line. 18 of 24 invocations re-probed one installer flow.
 *
 *  `location` is not a path. Adversaries write prose into it and splitLocation keeps whatever it
 *  cannot parse, so the real values look like `installer/contents_step_7.php:121 and
 *  installer/actions_step_7.php` or `.htaccess:16 vs installer/contents_step_2.php`. Grouping on
 *  the raw string groups nothing, which is why this keys on the FIRST file token instead.
 *
 *  A URL keys on origin + pathname so query strings do not fragment it, and — the reason the
 *  token scan is not simply run over everything — so a host like `ddev.site` is never mistaken
 *  for a file.
 *
 *  No recognisable token falls back to the finding's own fingerprint, i.e. a group of one.
 *  Fragmenting is the safe failure here: it costs invocations. Over-grouping would put two
 *  unrelated defects in front of one panel, which costs attention inside a prompt. */
export function rootCauseKey(f: AdversarialFinding): string {
  const raw = (f.location ?? '').trim();
  // isRuntimeOnlyFinding, not a local URL test: sharing the predicate is what guarantees a
  // group is uniformly runtime-only or uniformly not, which the dispatch below relies on to
  // drop whole groups rather than members.
  if (isRuntimeOnlyFinding(f)) {
    try {
      const u = new URL(raw);
      return `url:${u.origin}${u.pathname}`.toLowerCase();
    } catch {
      /* fall through to the token scan */
    }
  }
  const token = raw.match(FILE_TOKEN_RE)?.[0];
  if (token) return `file:${token.toLowerCase()}`;
  const { path } = splitLocation(f.location);
  return `fp:${findingFingerprint('', path, f.impact ?? f.category ?? '')}`;
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
const verdictSchema = z.object({
  /** 1-based position in the numbered list the prompt presented. */
  finding: z.number().int().positive(),
  reproduced: z.union([z.boolean(), z.literal('could_not_test')]),
  observation: z.string().optional(),
});

/** One panel now answers for EVERY finding sharing a root cause, so the report is a LIST.
 *  A verdict names the finding by its position in the numbered list the prompt gave it. */
const verifySchema = z.object({
  verdicts: z.array(verdictSchema).default([]),
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

/** Every verdict one verifier gave, keyed by the 1-based position the prompt numbered the
 *  finding at. A finding the verifier never answered for is simply absent from the map, which
 *  is what makes a short report fail closed rather than shift verdicts onto the wrong finding.
 *
 *  A single verdict is null when it is not usable. Null covers the unparseable, the killed,
 *  and — deliberately — the negative with nothing observed.
 *
 *  `could_not_test` carries no observation requirement: the whole point of it is that there
 *  was nothing to observe. It is not a vote against the finding, so it can never downgrade
 *  one. */
export type Verdict = 'reproduced' | 'not_reproduced' | 'could_not_test';

export function verifyVerdicts(raw: unknown): Map<number, Verdict> {
  // parseAgentJson with our OWN key gate, not parseReviewJson: that one admits only
  // candidates carrying `verdict` or `findings` — a reviewer's report shape — and a
  // verifier emits neither, so it would reject every valid verdict. Same reason 08c's
  // isRefuted gates on `refuted` itself.
  const parsed = parseAgentJson(raw, (candidate) => {
    if (!hasAnyKey(candidate, ['verdicts'])) return null;
    const r = verifySchema.safeParse(candidate);
    return r.success ? r.data : null;
  });
  const out = new Map<number, Verdict>();
  if (!parsed) return out;
  for (const v of parsed.verdicts) {
    // First verdict for a position wins. A verifier that answers twice for one finding has
    // contradicted itself, and taking the later answer would let a stray repeat overwrite a
    // reproduction.
    if (out.has(v.finding)) continue;
    if (v.reproduced === 'could_not_test') out.set(v.finding, 'could_not_test');
    else if (v.reproduced) out.set(v.finding, 'reproduced');
    else if (hasObservation(v.observation)) out.set(v.finding, 'not_reproduced');
  }
  return out;
}

/** The panel's verdict for ONE finding inside its root-cause group.
 *
 *  ANY lens reproducing it settles it — one successful reproduction is a demonstration,
 *  and the other lenses failing to repeat it does not undo that. A downgrade needs EVERY
 *  lens to report non-reproduction WITH an observation; one silent, unreadable, killed or
 *  unevidenced voter leaves the finding standing.
 *
 *  That is 08c's asymmetry applied here: gate 1.5 defaults to accepting what it is shown,
 *  so a wrongly-downgraded RCE is worse than a blocking finding the developer waves off.
 *
 *  One agent now answers for several findings, so there is a new way to end up with no
 *  verdict: a verifier that returns a SHORT list, or numbers a verdict at a position that is
 *  not in the group. Both land on the same fail-closed path as a killed voter — the position
 *  is absent from the map, the lens votes null, and the finding stays blocking. It is the one
 *  way grouping could silently lose a finding, so it is asserted in the tests rather than
 *  assumed from the shape of the code.
 *
 *  `untestable` is the unanimous could-not-test, reported separately from `unverified` only
 *  so gate 1.5 can distinguish "nobody could run this" from "the panel disagreed". Both keep
 *  the finding blocking; the ONLY verdict that stops one blocking is still `not_reproduced`. */
export function verificationForFinding(
  results: AgentMiningResult[],
  groupKey: string,
  /** 0-based position in the group; the prompt numbers it from 1. */
  index: number,
  lenses: (VerifyLens | null)[],
): 'reproduced' | 'not_reproduced' | 'unverified' | 'untestable' {
  const verdicts = lenses.map((lens) => {
    const outcome = miningOutcome(results, verifierAgentId(groupKey, lens));
    if (outcome.kind !== 'done') return null;
    return verifyVerdicts(outcome.raw).get(index + 1) ?? null;
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

/** The findings sharing one root cause, verified by one panel. */
export interface FindingGroup {
  key: string;
  findings: AdversarialFinding[];
}

/** One verification tier: the GROUPS in it, and the panel each group gets.
 *
 *  Two tiers because the cost of being WRONG differs by an order of magnitude, not because
 *  the findings differ. A wrongly dismissed blocking finding loses a defect that was one
 *  click from shipping, so those get the full unanimity panel. A wrongly dismissed low
 *  finding costs the reader one line, so those get one generic verifier — spending three
 *  sandboxed invocations to save a line of reading is the wrong trade.
 *
 *  A group inherits the highest tier of its members: one blocking member buys the whole group
 *  the full panel. Tiering exists to match panel size to what a wrong verdict costs, and the
 *  cost of the group is the cost of its worst member.
 *
 *  A finding with NO proof-of-concept is excluded from the advisory tier: there is nothing
 *  to execute, so a verifier could only guess, and guessing would fold the synthetic
 *  `qa-gap` entries that exist precisely to say an adversary never reported. Blocking
 *  findings are NOT excluded on that basis — a blocking claim with no proof is exactly the
 *  thing worth putting a panel on.
 *
 *  Returned by ONE function so the dispatch pass and the read-back pass cannot disagree
 *  about membership, ordering or caps — they call this with the same findings and the same
 *  lens count, and both are derived from the adversary output, which does not change
 *  between passes. */
interface VerificationTier {
  groups: FindingGroup[];
  lenses: (VerifyLens | null)[];
  /** How many GROUPS were dropped by this tier's cap, for the truncation warning. */
  overflow: number;
}

/** Findings one panel is asked about in a single prompt.
 *
 *  Grouping trades invocations for prompt length, and past some size that trade goes the wrong
 *  way: an enterprise roster can raise two dozen findings, and a small change concentrates them
 *  on one file, so an uncapped group would ask one verifier to run 24 proofs in one pass and
 *  get 24 shallow verdicts. Set to the size of the round that motivated this — 6 findings on
 *  one installer file — so that case stays a single panel.
 *
 *  An oversized cause SPLITS into further panels rather than dropping its tail: every finding
 *  is still verified, and the split is deterministic, so both passes number them identically. */
const MAX_GROUP_FINDINGS = 6;

/** Group findings by root cause, preserving first-seen order both between and within groups. */
function groupByRootCause(findings: AdversarialFinding[]): FindingGroup[] {
  const byKey = new Map<string, AdversarialFinding[]>();
  for (const f of findings) {
    const key = rootCauseKey(f);
    const members = byKey.get(key);
    if (members) members.push(f);
    else byKey.set(key, [f]);
  }
  const groups: FindingGroup[] = [];
  for (const [key, members] of byKey) {
    for (let i = 0; i < members.length; i += MAX_GROUP_FINDINGS) {
      const chunk = members.slice(i, i + MAX_GROUP_FINDINGS);
      // The first chunk keeps the bare key so the common case — a cause that fits — reads as
      // itself in the logs and in the agent id.
      groups.push({ key: i === 0 ? key : `${key}#${i / MAX_GROUP_FINDINGS + 1}`, findings: chunk });
    }
  }
  return groups;
}

export function verificationTiers(
  findings: AdversarialFinding[],
  lenses: (VerifyLens | null)[],
): VerificationTier[] {
  const eligible = findings.filter(
    (f) => isBlockingSeverity(f.severity) || (f.poc ?? '').trim().length > 0,
  );
  const groups = groupByRootCause(eligible);
  // Worst first (severityRank ascending in severity), so a capped tier spends its
  // invocations on the groups that cost most if they are wrong. A group ranks by its worst
  // member, the same member that decided its tier.
  const worst = (g: FindingGroup) => Math.min(...g.findings.map((f) => severityRank(f.severity)));
  const byWorst = (a: FindingGroup, b: FindingGroup) => worst(a) - worst(b);
  const blocking = groups
    .filter((g) => g.findings.some((f) => isBlockingSeverity(f.severity)))
    .sort(byWorst);
  const advisory = groups
    .filter((g) => !g.findings.some((f) => isBlockingSeverity(f.severity)))
    .sort(byWorst);
  return [
    {
      groups: blocking.slice(0, MAX_VERIFIED),
      lenses,
      overflow: Math.max(0, blocking.length - MAX_VERIFIED),
    },
    {
      groups: advisory.slice(0, MAX_VERIFIED_ADVISORY),
      lenses: [null],
      overflow: Math.max(0, advisory.length - MAX_VERIFIED_ADVISORY),
    },
  ];
}

/** Is there anything for the verifier wave to run? Mirrors verificationTiers' membership
 *  exactly — it is the same predicate, asked before the lens count is known. */
function hasVerifiable(findings: AdversarialFinding[]): boolean {
  return verificationTiers(findings, [null]).some((t) => t.groups.length > 0);
}

/** Human terminal label for a verifier: name what it is checking and the lens, so a fan-out
 *  of N verifications does not render as N identical terminals.
 *
 *  A group of one keeps the single-finding label — the impact reads better than a path. A
 *  larger group names its cause and its size, because no one member describes it. */
export function verifierTitle(
  group: FindingGroup,
  index: number,
  total: number,
  lens?: VerifyLens | null,
): string {
  const which = lens ? ` [${lens.title}]` : '';
  const head = `Verify ${index + 1}/${total}${which}`;
  const [f] = group.findings;
  if (!f) return head;
  if (group.findings.length === 1) {
    const what = (f.impact ?? f.category ?? 'finding').replace(/\s+/g, ' ').trim().slice(0, 60);
    const where = f.location ? ` @ ${f.location.slice(0, 40)}` : '';
    return `${head}: [${f.severity}] ${what}${where}`;
  }
  const worst = group.findings.reduce((a, b) =>
    severityRank(a.severity) <= severityRank(b.severity) ? a : b,
  );
  const cause = group.key.replace(/^(file|url|fp):/, '').slice(0, 50);
  return `${head}: [${worst.severity}] ${group.findings.length} findings @ ${cause}`;
}

function buildVerifyPrompt(
  d: AdversarialDetect,
  group: FindingGroup,
  lens: VerifyLens | null,
): string {
  const many = group.findings.length > 1;
  return [
    `You are a POC VERIFIER. ${many ? 'Adversarial QA agents reported the findings' : 'An adversarial QA agent reported the finding'} below against a`,
    `change, and acting on ${many ? 'them' : 'it'} will send the whole change back to be reimplemented. Your`,
    `job is to RUN ${many ? 'each proof-of-concept' : 'its proof-of-concept'} and report what actually happens — not to agree`,
    `with ${many ? 'them' : 'it'}, not to fix anything, and not to go looking for other problems.`,
    '',
    ...(many
      ? [
          `These ${group.findings.length} findings were grouped because they name the same place in the`,
          'code, so verifying them together saves re-establishing the same setup several times.',
          'They are SEPARATE claims and each gets its own verdict — do not decide one from',
          'another, and do not merge them. If a shared precondition is what fails, say so in',
          'each observation rather than answering once.',
          '',
        ]
      : []),
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
    `=== The finding${many ? 's' : ''} you are verifying ===`,
    ...group.findings.flatMap((f, i) => [
      `--- Finding ${i + 1} of ${group.findings.length} ---`,
      `Severity as filed: ${f.severity}`,
      `Location: ${f.location ?? '(none given)'}`,
      `Category: ${f.category ?? '(none given)'}`,
      `Impact claimed: ${f.impact ?? '(none given)'}`,
      `Proof of concept: ${f.poc ?? '(none given — that alone is grounds for not reproduced)'}`,
      '',
    ]),
    // Address and reachability come from the dispatcher's reach block; see buildAdversaryPrompt.
    ...(d.appUrl
      ? appAuthPromptLines(d.appLogin ?? { attempted: false, ok: false, reason: '' })
      : []),
    '',
    'Do NOT edit code and do NOT run git.',
    ...SEARCH_LADDER,
    '',
    'When finished emit ONE JSON object inside a ```json fenced code block with EXACTLY this',
    'shape, carrying one entry per finding above:',
    '{ "verdicts": [',
    '  { "finding": 1, "reproduced": true|false|"could_not_test", "observation": "<what you saw>" }',
    '] }',
    '',
    `\`finding\` is the number above, 1 to ${group.findings.length}. Emit an entry for EVERY one of them, even`,
    'the ones you could not test. A finding you leave out gets no verdict at all and goes to',
    'the developer as unverified, which wastes the run you just spent on it.',
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
      // Read back through the SAME tier split that dispatched, so each finding is scored
      // against the panel it actually got: the blocking tier against the full lens set, the
      // advisory tier against its single generic verifier.
      //
      // Every group is read, including ones the dispatch dropped as untestable. A group that
      // never ran has no rows, so every lens votes null and the finding stays blocking. Reading
      // them unconditionally is what keeps the INDEX stable: group membership is derived from
      // the findings alone and never from the reach probe, which is re-run on this pass and can
      // disagree with the one that dispatched. Filtering members by reach here would renumber
      // the group and hand each finding its neighbour's verdict.
      for (const tier of verificationTiers(findings, lenses)) {
        for (const group of tier.groups) {
          for (const [i, f] of group.findings.entries()) {
            const panel = verificationForFinding(allResults, group.key, i, tier.lenses);
            // The panel wins whenever it actually said something. The reach is re-probed on
            // this pass and can disagree with the one that dispatched — a runner recovering
            // between the two passes must not discard a verdict that was genuinely recorded,
            // least of all a reproduction. Only the findings that were skipped come back with
            // nothing at all, and those are the ones this relabels from `unverified` to the
            // truer `untestable`.
            f.verification = panel === 'unverified' && provablyUntestable(f) ? 'untestable' : panel;
          }
        }
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
    } else if (args.miningWaveExhausted !== true && hasVerifiable(findings)) {
      // hasVerifiable is checked BEFORE the config service: tier membership does not depend
      // on the lens count, so a round with nothing to verify — every finding non-blocking and
      // PoC-less, which is what a roster that produced only qa-gap entries looks like — should
      // not touch config at all. It also keeps the common no-op path free of an await.
      if (await configService.getBoolean(CONFIG_KEYS.QA_VERIFY_ENABLED, true)) {
        const lenses = verifyLensesFor(
          await configService.getNumber(CONFIG_KEYS.QA_VERIFY_LENSES, VERIFY_LENSES.length),
        );
        const tiers = verificationTiers(findings, lenses);
        for (const tier of tiers) {
          if (tier.overflow > 0) {
            ctx.logger.warn(
              {
                verifying: tier.groups.length,
                overflow: tier.overflow,
                panel: tier.lenses.length,
              },
              'more root causes than verifiers in this tier; the overflow goes to the gate unverified',
            );
          }
        }
        // A finding located at a URL, with no app running, cannot be verified by anyone: the
        // panel would spend its invocations to report could_not_test unanimously. Dropped
        // from the wave and marked untestable directly, which blocks exactly the same.
        //
        // Whole GROUPS, never members: a group's key is derived from the same
        // isRuntimeOnlyFinding predicate, so its members are uniformly runtime-only or
        // uniformly not, and dropping a member would renumber the group against the read-back.
        const dispatchable = tiers.map((tier) => ({
          ...tier,
          groups: tier.groups.filter((g) => !g.findings.every(provablyUntestable)),
        }));
        const skipped =
          tiers.reduce((n, t) => n + t.groups.length, 0) -
          dispatchable.reduce((n, t) => n + t.groups.length, 0);
        if (skipped > 0) {
          ctx.logger.warn(
            { untestable: skipped },
            'adversarial QA: no running app, so runtime findings go to the gate untested',
          );
        }
        const wave = dispatchable.flatMap((tier) =>
          tier.groups.flatMap((group, i) =>
            tier.lenses.map((lens) => ({
              agentId: verifierAgentId(group.key, lens),
              agentTitle: verifierTitle(group, i, tier.groups.length, lens),
              prompt: buildVerifyPrompt(detected, group, lens),
              // The agent id is per-GROUP and unbounded; the LENS is the stable seat.
              roleKey: lens ? `qa-verify:${lens.id}` : 'qa-verify',
            })),
          ),
        );
        if (wave.length === 0) {
          // Nothing left to check: every candidate is a runtime finding and nothing is
          // running. Marked here and NOT dispatched — an empty MiningWaveError would park the
          // step on a fan-out with no agents in it, waiting for verdicts that never arrive.
          for (const tier of tiers)
            for (const group of tier.groups)
              for (const f of group.findings) f.verification = 'untestable';
        } else {
          const counted = (t: (typeof dispatchable)[number] | undefined) => ({
            causes: t?.groups.length ?? 0,
            findings: t?.groups.reduce((n, g) => n + g.findings.length, 0) ?? 0,
          });
          ctx.logger.info(
            {
              blocking: counted(dispatchable[0]),
              advisory: counted(dispatchable[1]),
              invocations: wave.length,
            },
            'dispatching PoC verifiers: one panel per root cause, full panel for blocking causes',
          );
          throw new MiningWaveError(wave);
        }
      }
    }

    // A finding whose PoC no verifier could reproduce stops blocking. It is NOT removed:
    // it stays in `findings` and reaches gate 1.5 labelled, because the developer keeps the
    // call. Anything unverified still blocks — doubt keeps the finding.
    const blocking = blockingFindings.some((f) => f.verification !== 'not_reproduced');

    // Carry the disproved set forward as CONTEXT for later rounds. augmentPromptWithLedger
    // already injects the ledger into every mining prompt (step-runner), so this reaches the
    // next round's adversaries and verifiers with no plumbing of its own.
    //
    // Deliberately NOT a suppression list. A verdict is about a MOMENT, not about the defect:
    // this task's own history is the proof — the round-3 fixes introduced the case-sensitivity
    // bypass and the Apache parse failure the next round then found. Something disproved in
    // round 2 can be true in round 5, so the wording invites a re-raise and asks only for what
    // changed. Suppressing instead would fail silently, in the one direction this whole check
    // exists to prevent.
    const disproved = findings.filter((f) => f.verification === 'not_reproduced');
    if (disproved.length > 0) {
      await recordLedgerEntry(ctx.db, ctx.taskId, ctx.taskStepId, {
        stepId: '08d-adversarial-qa',
        round: ctx.round,
        kind: 'finding',
        text: [
          `Adversarial QA round ${ctx.round}: these proofs-of-concept were EXECUTED against the`,
          'running app and did not reproduce. They are recorded, not deleted. This is a result',
          'from that round only — later changes can make any of them true, so raise one again if',
          'you can, and say what changed:',
          ...disproved.map(
            (f) =>
              `- [${f.severity}] ${(f.category ?? 'issue').trim()}${f.location ? ` @ ${f.location}` : ''}: ${(f.impact ?? '').trim().slice(0, 160)}`,
          ),
        ].join('\n'),
      });
    }

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
