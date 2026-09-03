/**
 * Which sections of a source document the plan does not appear to cover.
 *
 * Deterministic on purpose. Document candidates remain a human decision because
 * this is a heuristic shortlist, not a judge. Semantic leaf completion is a
 * separate automatic pass with an explicit persisted stopping state.
 */

/** A heading in the source document, with the text beneath it. */
export interface DocSection {
  /** `## 4.4 SRS and mastery contract` -> `4.4 SRS and mastery contract`. */
  title: string;
  /** Heading depth: 2 for `##`, 3 for `###`. */
  level: number;
  /** Line number in the document, for the reader to go and look. */
  line: number;
  /** The section's own text, used as the brief when re-decomposing it. */
  body: string;
  /** Which input the section came from — an original filename, or the sidecar's
   *  original. A plan can be built from several documents at once, and "§4.2
   *  Reporting" means nothing to a reader who has three files open. */
  source: string;
}

export interface CoverageCandidate {
  title: string;
  line: number;
  /** The input this heading is in. Carried through so the gate can attribute a
   *  gap, and so two files' line 12 are two different gaps. */
  source: string;
  /** Distinctive terms from the heading that appear NOWHERE in the plan. */
  missingTerms: string[];
  /** How many plan nodes matched two or more of the heading's terms. */
  matchedNodes: number;
  /** 0..1 — the share of the heading's terms present anywhere in the plan. */
  score: number;
}

/** Words that carry no subject. Matching on these finds every section in every
 *  plan, which is the same as matching on nothing. */
const STOP = new Set(
  `the a an and or of to for in on with by from is are be as at into per its this that not no
   using use used all any each new must may shall when then if than which what where who whom while
   also only both same other others one two three four five six seven eight nine ten first second
   third section see above below etc via out over under between during after before document rules
   rule contract contracts model layout surface policy boundary boundaries state states`.split(
    /\s+/,
  ),
);

/** Terms a heading is ABOUT. Short words are dropped because they match
 *  everywhere; a numbering prefix (`4.5a`) is not a subject. */
export function headingTerms(title: string): string[] {
  const withoutNumber = title.replace(/^[\d.]+[a-z]?\s+/i, '');
  return [
    ...new Set(
      withoutNumber
        .toLowerCase()
        .replace(/[—–\-,:()/[\]]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 3 && !STOP.has(w)),
    ),
  ];
}

/** Sections no NODE is about, worst first.
 *
 *  Coverage is per-node, deliberately. Asking whether a heading's words appear
 *  anywhere in the corpus is nearly free to satisfy: MEASURED, removing a
 *  92-node component from a 791-node plan still left every term present
 *  somewhere in the remaining megabyte of node bodies, so that test reported no
 *  gaps at all. What matters is whether SOME node is about the subject.
 *
 *  Node bodies are still read — a subject introduced in a body and not the title
 *  is covered — but the terms must co-occur in ONE node rather than be scattered
 *  across the plan.
 */
export function findCoverageGaps(
  sections: DocSection[],
  nodeTexts: string[],
  opts: { threshold?: number } = {},
): CoverageCandidate[] {
  const threshold = opts.threshold ?? 0.5;
  const lowered = nodeTexts.map((t) => t.toLowerCase());

  const out: CoverageCandidate[] = [];
  for (const section of sections) {
    const terms = headingTerms(section.title);
    // A heading with no distinctive words says nothing to look for. Reporting it
    // would be reporting the absence of a question, not of an answer.
    if (terms.length === 0) continue;

    // The single node that best matches this heading, and how much of it that
    // node accounts for.
    let best: string[] = [];
    let matchedNodes = 0;
    for (const text of lowered) {
      const hit = terms.filter((t) => text.includes(t));
      if (hit.length >= Math.min(2, terms.length)) matchedNodes += 1;
      if (hit.length > best.length) best = hit;
    }
    const score = best.length / terms.length;
    if (score >= threshold) continue;
    out.push({
      title: section.title,
      line: section.line,
      source: section.source,
      missingTerms: terms.filter((t) => !best.includes(t)),
      matchedNodes,
      score: Number(score.toFixed(2)),
    });
  }
  // Worst first, then by source so one file's gaps stay together in the gate's
  // list, then by line within it.
  return out.sort(
    (a, b) => a.score - b.score || a.source.localeCompare(b.source) || a.line - b.line,
  );
}

/** Split a markdown document into its `##`+ sections, each carrying its own text. */
export function parseDocSections(markdown: string, source = ''): DocSection[] {
  const lines = markdown.split('\n');
  const heads: { title: string; level: number; line: number; at: number }[] = [];
  lines.forEach((raw, i) => {
    const m = /^(#{2,6})\s+(.*\S)\s*$/.exec(raw);
    if (m) heads.push({ title: m[2]!, level: m[1]!.length, line: i + 1, at: i });
  });
  return heads.map((h, i) => ({
    title: h.title,
    level: h.level,
    line: h.line,
    body: lines.slice(h.at + 1, heads[i + 1]?.at ?? lines.length).join('\n'),
    source,
  }));
}

/** A node that should have been decomposed and was not. */
export interface StructuralGap {
  nodeId: string;
  title: string;
  /** Why it is suspect, in the words the gate will show. */
  reason: string;
}

/**
 * Components the build left undecomposed, and expansions it lost.
 *
 * This is the signal that would have caught the real defect. A term-coverage
 * scan would NOT have: when a component was left with zero children, its own
 * title and body still named its subject, so every word of the corresponding
 * document section was present. The tree SHAPE was the tell, not the vocabulary
 * — MEASURED twice, on two separate builds.
 *
 * `decision`, `research` and `external` nodes are excluded because the frontier
 * deliberately never expands them: a decision is not decomposed, it is made.
 */
const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const BUILD_ATTEMPT_RE = new RegExp(`^plan-expand-(${UUID_SOURCE})-p(\\d+)$`, 'i');
const CONTINUE_ATTEMPT_RE = new RegExp(`^plan-continue-b(\\d+)-(${UUID_SOURCE})-p(\\d+)$`, 'i');
/** The trailing `-r<N>` is the gate round that dispatched the repair, present
 *  since manual repairs became re-dispatchable. Optional so rows written before
 *  that still resolve to their focus node rather than silently going unmatched —
 *  an unmatched row drops out of the attempt map, which reads as "never
 *  attempted". */
const RECOVERY_ATTEMPT_RE = new RegExp(`^cover-node-(${UUID_SOURCE})(?:-r(\\d+))?$`, 'i');

export interface ExpansionAttemptRow {
  agentId: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  errorMessage: string | null;
  createdAt?: Date | null;
}

function expansionAttemptKey(
  agentId: string,
): { nodeId: string; order: readonly [number, number, number] } | null {
  const recovery = RECOVERY_ATTEMPT_RE.exec(agentId);
  if (recovery) return { nodeId: recovery[1]!, order: [2, 0, Number(recovery[2] ?? 1)] };
  const continuation = CONTINUE_ATTEMPT_RE.exec(agentId);
  if (continuation) {
    return {
      nodeId: continuation[2]!,
      order: [1, Number(continuation[1]), Number(continuation[3])],
    };
  }
  const build = BUILD_ATTEMPT_RE.exec(agentId);
  if (build) return { nodeId: build[1]!, order: [0, 0, Number(build[2])] };
  return null;
}

function isLaterAttempt(
  candidate: readonly [number, number, number],
  current: readonly [number, number, number],
): boolean {
  for (let index = 0; index < candidate.length; index += 1) {
    if (candidate[index] === current[index]) continue;
    return candidate[index]! > current[index]!;
  }
  return false;
}

/**
 * One effective attempt per focus node. A clean retry must supersede an older
 * failure, while a later failure must not be hidden by an earlier clean row.
 * Persisted creation time is authoritative. Agent-id lifecycle and wave/batch
 * order provide the deterministic fallback used by older/test rows without it.
 */
export function latestExpansionAttempts<T extends ExpansionAttemptRow>(
  agents: T[],
): Map<string, T> {
  const latest = new Map<string, { row: T; order: readonly [number, number, number] }>();
  for (const row of agents) {
    const attempt = expansionAttemptKey(row.agentId);
    if (!attempt) continue;
    const current = latest.get(attempt.nodeId);
    const candidateTime = row.createdAt?.getTime();
    const currentTime = current?.row.createdAt?.getTime();
    const isLaterByTime =
      candidateTime !== undefined &&
      currentTime !== undefined &&
      candidateTime !== currentTime &&
      candidateTime > currentTime;
    const isEarlierByTime =
      candidateTime !== undefined &&
      currentTime !== undefined &&
      candidateTime !== currentTime &&
      candidateTime < currentTime;
    if (
      !current ||
      isLaterByTime ||
      (!isEarlierByTime && isLaterAttempt(attempt.order, current.order))
    ) {
      latest.set(attempt.nodeId, { row, order: attempt.order });
    }
  }
  return new Map([...latest].map(([nodeId, value]) => [nodeId, value.row]));
}

export function findStructuralGaps(
  nodes: { id: string; title: string; kind: string; parentId: string | null }[],
  agents: {
    agentId: string;
    status: 'pending' | 'running' | 'done' | 'failed';
    errorMessage: string | null;
  }[],
  prefixes: { failure: string; partial: string },
): StructuralGap[] {
  const hasChild = new Set(nodes.map((n) => n.parentId).filter((p): p is string => !!p));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const latestAttempts = latestExpansionAttempts(agents);
  const out: StructuralGap[] = [];

  for (const n of nodes) {
    if (n.kind !== 'component' || hasChild.has(n.id) || n.parentId === null) continue;
    // A leaf component is normal — most of the plan is leaves. Only one whose
    // expansion was ATTEMPTED and produced nothing is suspect, which is what the
    // agent rows below decide.
    const agent = latestAttempts.get(n.id);
    if (agent && (agent.status === 'failed' || agent.errorMessage?.startsWith(prefixes.failure))) {
      out.push({
        nodeId: n.id,
        title: n.title,
        reason:
          agent.status === 'failed'
            ? 'its decomposition terminal failed before producing children'
            : 'its decomposition was rejected and lost',
      });
    }
  }

  // Losses that did not leave a childless node: a wave that was thinned rather
  // than rejected outright. Reported because a silently smaller patch is how a
  // plan loses content with nothing to see.
  for (const [id, a] of latestAttempts) {
    if (!a.errorMessage?.startsWith(prefixes.partial)) continue;
    const node = byId.get(id);
    if (!node || out.some((g) => g.nodeId === node.id)) continue;
    const dropped = a.errorMessage.split('; ').length;
    out.push({
      nodeId: node.id,
      title: node.title,
      reason: `${dropped} operation(s) were dropped from its decomposition`,
    });
  }
  return out;
}
