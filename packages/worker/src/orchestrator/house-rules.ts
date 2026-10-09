import picomatch from 'picomatch';
import { collapseToLine, HOUSE_RULE_ROLES, type HouseRuleMode } from '@haive/shared';
import {
  HOUSE_RULES_END,
  houseRuleBytes,
  houseRuleShortIds,
  houseRuleStampTitle,
  parseHouseRulesStamp,
  refusedHouseRuleText,
  renderHouseRuleEntry,
  validateHouseRuleGlobs,
  type EnforceSpec,
  type GlobalKbEntry,
  type GlobalKbErrorClass,
  type HouseRulesStamp,
} from '@haive/shared/global-kb';
import { withAgentRules } from './agent-rules.js';

export const HOUSE_RULES_MARKER = '<haive_house_rules>';

/** What one prompt may spend on the block, markers, framing and omission notice included. */
export const HOUSE_RULES_BUDGET_BYTES = 16_384;

const OMITTED_TITLES_NAMED = 8;

/** The framing a dispatch is shown, and the files its DAG issue plans to touch (`estimated_files`).
 *  `findings` words the review framing for a reviewer that answers with a list of findings. */
export interface HouseRulesRequest {
  mode: HouseRuleMode;
  estimatedFiles?: readonly string[];
  findings?: boolean;
}

const FINDINGS_STEPS: ReadonlySet<string> = new Set(['08c-code-review']);

export function houseRulesFor(
  stepId: string,
  role: string,
  estimatedFiles?: readonly string[],
): HouseRulesRequest | undefined {
  if (!Object.hasOwn(HOUSE_RULE_ROLES, stepId)) return undefined;
  const roles = HOUSE_RULE_ROLES[stepId]!;
  if (!Object.hasOwn(roles, role)) return undefined;
  const mode = roles[role]!;
  return {
    mode,
    ...(estimatedFiles ? { estimatedFiles } : {}),
    ...(mode === 'review' && FINDINGS_STEPS.has(stepId) ? { findings: true } : {}),
  };
}

/** Marks a dispatch that is shown no house rules; the source guard wants every call to say why. */
export function houseRulesOptOut(_reason: string): undefined {
  return undefined;
}

const escapeEnd = (text: string): string =>
  text.replaceAll(HOUSE_RULES_END, '<\\/haive_house_rules>');

/** As for the agent rules, only a block at position 0 is Haive's: a marker quoted further down can
 *  neither suppress nor replace the injection. A null block only strips. */
export function withHouseRules(prompt: string, block: string | null): string {
  let body = prompt;
  if (body.startsWith(HOUSE_RULES_MARKER)) {
    const end = body.indexOf(HOUSE_RULES_END);
    if (end !== -1) body = body.slice(end + HOUSE_RULES_END.length).replace(/^\n+/, '');
  }
  return block === null ? body : `${block}\n\n${body}`;
}

/** The prompt without the agent rules and house rules blocks Haive put at its top. */
export function stripHaivePreamble(prompt: string): string {
  return withHouseRules(withAgentRules(prompt, null).prompt, null);
}

export function houseRulesOf(spec: unknown): HouseRulesStamp | null {
  return parseHouseRulesStamp((spec as { houseRules?: unknown } | null)?.houseRules);
}

const FRAMING_SCOPE =
  'Each rule says where it applies; a glob without a "/" matches a file name at any depth.';

const WRITE_FRAMING = [
  `House rules an administrator has enforced on this install. ${FRAMING_SCOPE} Follow every one on the lines you write or specify; a rule beats the local convention of the code around it.`,
  'Do not rewrite untouched code to fit a rule. Report a place that breaks one as a similar site, in the similar-sites field of your output where it has one, else in your notes.',
  'A review finding or a diagnosis from a check never licenses breaking a rule: fix the finding in a way that keeps the rule, or leave it and say why.',
  "Only the approved spec or a person's directive, a fix a person directs included, can require breaking a rule. Then follow it and report the conflict where you report the above.",
  'A spec you write never restates these rules as requirements.',
].join('\n');

const REVIEW_SCOPE = `House rules an administrator has enforced on this install. ${FRAMING_SCOPE} Check every line this change wrote, and every file it deleted, against every rule below; a file listed with no line note counts as wholly written. A rule that lists files applies only to the files its globs match.`;

const REVIEW_RULE_ID = `"rule" as the rule's id, the code between "### Rule " and the colon in its heading`;

const REVIEW_WAIVER =
  "A known-debt entry never waives a rule, nor does a diagnosis or an honored constraint that came from a check. A diagnosis or an honored constraint that came from a person counts as a person's directive.";

const REVIEW_FRAMING = [
  REVIEW_SCOPE,
  `Report each violation as an issue with severity exactly "high", "file" as "path:line" and ${REVIEW_RULE_ID}.`,
  `${REVIEW_WAIVER} A violation outside the written lines goes to your report, never to the issues.`,
  'When the approved spec or a person\'s directive requires a violation, do not list it as an issue: list it under "rule_conflicts" as {"rule": "<id>", "file": "path:line", "reason": "<why>"}.',
  'The "rule" field of an issue and the top-level "rule_conflicts" list extend the JSON shape the output contract below gives: add both, even where it says to return exactly that shape.',
].join('\n');

const FINDINGS_REVIEW_FRAMING = [
  REVIEW_SCOPE,
  `Report each violation as a finding with severity exactly "high", "path" as the file, "lines" as the line range and ${REVIEW_RULE_ID}.`,
  `${REVIEW_WAIVER} A violation outside the written lines is never a finding: put it in your \`## INSIGHTS\` section.`,
  'When the approved spec or a person\'s directive requires a violation, do not list it as a finding: list it under "rule_conflicts" as {"rule": "<id>", "path": "path:line", "reason": "<why>"}.',
  'The "rule" field of a finding and the top-level "rule_conflicts" list extend the JSON shape the output contract below gives: add both, even where it says EXACTLY that shape.',
].join('\n');

const framingOf = (mode: HouseRuleMode, findings: boolean): string => {
  if (mode !== 'review') return WRITE_FRAMING;
  return findings ? FINDINGS_REVIEW_FRAMING : REVIEW_FRAMING;
};

export interface HouseRuleCandidate extends Pick<
  GlobalKbEntry,
  'id' | 'title' | 'category' | 'description' | 'body'
> {
  /** The approval hash, which `enforcementState` re-verified against the stored content. */
  hash: string;
  spec: EnforceSpec;
  enforcedAt: Date | null;
}

type Omitted = HouseRulesStamp['omitted'][number];
type Included = HouseRulesStamp['entries'][number];

interface GlobMatcher {
  glob: string;
  test: (path: string) => boolean;
}

/** In the sorted, de-duplicated order the scope line lists them; a glob with no "/" names a file at
 *  any depth, as in a gitignore. */
function compileGlobs(globs: readonly string[]): GlobMatcher[] {
  return [...new Set(globs)].sort().map((glob) => ({
    glob,
    test: picomatch(glob, glob.includes('/') ? { dot: true } : { dot: true, basename: true }),
  }));
}

// Not `files.some(matcher.test)`: a picomatch matcher reads its second argument as "return an object".
const firstMatchingGlob = (
  matchers: readonly GlobMatcher[],
  files: readonly string[],
): string | null =>
  matchers.find((matcher) => files.some((file) => matcher.test(file)))?.glob ?? null;

const refusedOf = (rule: HouseRuleCandidate): Omitted => ({
  id: rule.id,
  hash: rule.hash,
  title: houseRuleStampTitle(rule.title),
  why: 'refused',
});

/** Approvals are trusted from any store, so each row is checked again for what the API refuses to
 *  approve; a row that fails is named in the stamp, never thrown. */
export function vetHouseRules(rules: readonly HouseRuleCandidate[]): {
  usable: HouseRuleCandidate[];
  refused: Omitted[];
} {
  const usable: HouseRuleCandidate[] = [];
  const refused: Omitted[] = [];
  for (const rule of rules) {
    if (isUsable(rule)) usable.push(rule);
    else refused.push(refusedOf(rule));
  }
  return { usable, refused };
}

function isUsable(rule: HouseRuleCandidate): boolean {
  if (
    collapseToLine(rule.description) === '' ||
    refusedHouseRuleText(rule.title) !== null ||
    refusedHouseRuleText(rule.description ?? '') !== null ||
    refusedHouseRuleText(rule.body) !== null
  ) {
    return false;
  }
  if (rule.spec.mode === 'always') return true;
  if (validateHouseRuleGlobs(rule.spec.globs) !== null) return false;
  try {
    compileGlobs(rule.spec.globs);
    return true;
  } catch {
    return false;
  }
}

interface Ranked {
  rule: HouseRuleCandidate;
  why: Included['why'];
  /** 0 always; 1 matched by a written file, or unscoped; 2 matched only by the plan's estimate. */
  tier: number;
  size: number;
}

const provisionalId = (id: string): string => id.replaceAll('-', '').slice(0, 8);

function rank(
  rules: readonly HouseRuleCandidate[],
  changedFiles: readonly string[] | null,
  estimatedFiles: readonly string[],
): Ranked[] {
  const ranked: Ranked[] = [];
  for (const rule of rules) {
    const size = houseRuleBytes(rule, { enforce: rule.spec, shortId: provisionalId(rule.id) });
    if (rule.spec.mode === 'always') {
      ranked.push({ rule, why: { scope: 'always' }, tier: 0, size });
      continue;
    }
    if (changedFiles === null) {
      ranked.push({ rule, why: { scope: 'files', glob: null }, tier: 1, size });
      continue;
    }
    const matchers = compileGlobs(rule.spec.globs);
    const written = firstMatchingGlob(matchers, changedFiles);
    const estimated = written === null ? firstMatchingGlob(matchers, estimatedFiles) : null;
    const glob = written ?? estimated;
    if (glob !== null) {
      ranked.push({ rule, why: { scope: 'files', glob }, tier: written === null ? 2 : 1, size });
    }
  }
  return ranked.sort(
    (a, b) =>
      a.tier - b.tier ||
      (a.tier === 0
        ? (a.rule.enforcedAt?.getTime() ?? Infinity) - (b.rule.enforcedAt?.getTime() ?? Infinity)
        : a.size - b.size) ||
      (a.rule.id < b.rule.id ? -1 : a.rule.id > b.rule.id ? 1 : 0),
  );
}

function omissionLine(mode: HouseRuleMode, omitted: readonly Omitted[]): string {
  const count = omitted.length;
  const named = omitted
    .slice(0, OMITTED_TITLES_NAMED)
    .map((o) => `"${o.title}"`)
    .join('; ');
  const more = count > OMITTED_TITLES_NAMED ? `; and ${count - OMITTED_TITLES_NAMED} more` : '';
  const one = count === 1;
  const line =
    mode === 'review'
      ? `(${count} more enforced house ${one ? 'rule' : 'rules'} did not fit this prompt and ${one ? 'is' : 'are'} not part of this check: ${named}${more}. Do not report on ${one ? 'it' : 'them'}.)`
      : `(${count} more enforced house ${one ? 'rule' : 'rules'} did not fit this prompt and ${one ? 'is' : 'are'} not shown: ${named}${more}.)`;
  return escapeEnd(line);
}

function renderBlock(framing: string, kept: readonly Ranked[], notice: string): string {
  const ids = houseRuleShortIds(kept.map((k) => k.rule.id));
  const entries = kept.map((k) =>
    renderHouseRuleEntry(k.rule, { enforce: k.rule.spec, shortId: ids.get(k.rule.id)! }),
  );
  return [
    HOUSE_RULES_MARKER,
    framing,
    '',
    ...(entries.length === 0 ? [] : [entries.join('\n\n')]),
    ...(notice === '' ? [] : [notice]),
    HOUSE_RULES_END,
  ].join('\n');
}

const bytesOf = (text: string): number => Buffer.byteLength(text, 'utf8');

export interface HouseRuleSelection {
  status: 'ok' | 'disabled' | 'unavailable';
  errorClass?: GlobalKbErrorClass;
  entries: Included[];
  omitted: Omitted[];
  block: string | null;
}

export const disabledSelection = (): HouseRuleSelection => ({
  status: 'disabled',
  entries: [],
  omitted: [],
  block: null,
});

export const unavailableSelection = (errorClass: GlobalKbErrorClass): HouseRuleSelection => ({
  status: 'unavailable',
  errorClass,
  entries: [],
  omitted: [],
  block: null,
});

/**
 * Which rules a dispatch is shown, and the block that shows them. An unreadable change
 * (`changedFiles` null) puts every `files` rule in unscoped: never narrow on a measurement nobody
 * made. Over budget whole rules are left out, first fit: `always` rules first, oldest approval
 * first (a set within the API's cap always fits), then written-file matches before estimate-only
 * ones and smaller before larger. If every rule is left out the block is the framing and the
 * notice; it is null only when nothing was left out too.
 */
export function selectHouseRules(input: {
  mode: HouseRuleMode;
  findings?: boolean;
  rules: readonly HouseRuleCandidate[];
  refused?: readonly Omitted[];
  changedFiles: readonly string[] | null;
  estimatedFiles?: readonly string[];
  budgetBytes?: number;
}): HouseRuleSelection {
  const { mode, changedFiles } = input;
  const framing = framingOf(mode, input.findings === true);
  const budget = input.budgetBytes ?? HOUSE_RULES_BUDGET_BYTES;
  const ranked = rank(input.rules, changedFiles, input.estimatedFiles ?? []);

  // The notice counts against the budget but depends on what is left out, so its room only grows.
  let reserve = 0;
  for (;;) {
    const kept: Ranked[] = [];
    const left: Ranked[] = [];
    for (const candidate of ranked) {
      const trial = [...kept, candidate];
      if (bytesOf(renderBlock(framing, trial, '')) <= budget - reserve) kept.push(candidate);
      else left.push(candidate);
    }
    const leftOut: Omitted[] = left.map((r) => ({
      id: r.rule.id,
      hash: r.rule.hash,
      title: houseRuleStampTitle(r.rule.title),
      why: 'budget',
    }));
    const notice = leftOut.length === 0 ? '' : omissionLine(mode, leftOut);
    const needed = notice === '' ? 0 : bytesOf(`${notice}\n`);
    if (needed > reserve) {
      reserve = needed;
      continue;
    }
    const entries: Included[] = kept.map((r) => ({
      id: r.rule.id,
      hash: r.rule.hash,
      title: houseRuleStampTitle(r.rule.title),
      why: r.why,
    }));
    return {
      status: 'ok',
      entries,
      omitted: [...(input.refused ?? []), ...leftOut],
      block: kept.length === 0 && leftOut.length === 0 ? null : renderBlock(framing, kept, notice),
    };
  }
}

/** A block the CLI could not take moves its entries to the omitted: `entries` is what the prompt carries. */
export function houseRulesStampOf(
  mode: HouseRuleMode,
  selection: HouseRuleSelection,
  tooLarge = false,
): HouseRulesStamp {
  if (selection.status === 'disabled')
    return { mode, entries: [], omitted: [], reason: 'switched_off' };
  if (selection.status === 'unavailable') {
    return {
      mode,
      entries: [],
      omitted: [],
      reason: 'unavailable',
      errorClass: selection.errorClass ?? 'other',
    };
  }
  if (tooLarge) {
    return {
      mode,
      entries: [],
      omitted: [
        ...selection.omitted,
        ...selection.entries.map(({ id, hash, title }): Omitted => ({
          id,
          hash,
          title,
          why: 'budget',
        })),
      ],
      reason: 'too_large',
    };
  }
  return { mode, entries: selection.entries, omitted: selection.omitted };
}
