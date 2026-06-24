import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FormSchema, InfoSection } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { RetryableParseError } from '../../step-definition.js';
import { loadPreviousStepOutput, pathExists } from '../onboarding/_helpers.js';
import { loadTaskMeta } from './_task-meta.js';
import { parseJsonLoose } from '../_fenced-json.js';
import { INSIGHTS_INSTRUCTION } from './08e-insights-triage.js';
import { loadOutstandingSpecFeedback } from './_spec-feedback.js';
import { loadBusinessRequirements } from './_business-requirements.js';
import { isBugBranch } from './01-worktree-setup.js';

interface KbReference {
  id: string;
  title: string;
  exists: boolean;
}

interface PrePlanningDetect {
  taskTitle: string;
  taskDescription: string;
  discoverySummary: string;
  businessRequirements: string;
  relevantKbIds: string[];
  kbReferences: KbReference[];
  /** True when this task is a bug fix (isBugBranch on title/description/category).
   *  Steers the RAG retrieval guidance: bug fixes lean on run-books + learnings. */
  isBugFix: boolean;
  /** Latest gate-1 (06) spec rejection feedback not yet re-approved; pre-filled into the
   *  scope field and auto-submitted so a re-draft addresses it. Empty on the first run /
   *  after approval. */
  priorRejectionFeedback: string;
}

function kbHeading(text: string): string | null {
  const m = /^#\s+(.+)$/m.exec(text);
  return m?.[1]?.trim() ?? null;
}

async function resolveKbReferences(repoPath: string, ids: string[]): Promise<KbReference[]> {
  const dir = path.join(repoPath, '.claude', 'knowledge_base');
  const out: KbReference[] = [];
  for (const id of ids) {
    const full = path.join(dir, `${id}.md`);
    if (!(await pathExists(full))) {
      out.push({ id, title: id, exists: false });
      continue;
    }
    try {
      const text = await readFile(full, 'utf8');
      out.push({ id, title: kbHeading(text) ?? id, exists: true });
    } catch {
      out.push({ id, title: id, exists: false });
    }
  }
  return out;
}

interface PrePlanningApply {
  summary: string;
  spec: string;
  source: 'llm' | 'stub';
}

interface DiscoveryOutput {
  summary?: string;
  relevantKbIds?: string[];
}

export function parsePrePlanningOutput(raw: unknown): {
  summary: string;
  spec: string;
} | null {
  if (!raw) return null;
  let text: string;
  if (typeof raw === 'string') {
    text = raw;
  } else if (typeof raw === 'object') {
    const asObj = raw as Record<string, unknown>;
    if (typeof asObj.summary === 'string' && typeof asObj.spec === 'string') {
      return { summary: asObj.summary, spec: asObj.spec };
    }
    return null;
  } else {
    return null;
  }
  const parsed = parseJsonLoose(text);
  if (parsed == null) return null;
  if (
    typeof parsed === 'object' &&
    typeof (parsed as Record<string, unknown>).summary === 'string' &&
    typeof (parsed as Record<string, unknown>).spec === 'string'
  ) {
    const obj = parsed as Record<string, unknown>;
    return { summary: obj.summary as string, spec: obj.spec as string };
  }
  return null;
}

export function stubPrePlanning(detect: PrePlanningDetect): { summary: string; spec: string } {
  const title = detect.taskTitle || '(untitled task)';
  const description = detect.taskDescription || '(no description provided)';
  const summary = [
    `Pre-planning draft for: ${title}`,
    '',
    description,
    '',
    detect.discoverySummary ? 'Discovery context incorporated.' : 'Discovery context unavailable.',
  ].join('\n');
  const specLines = [
    `# Spec: ${title}`,
    '',
    '## Goal',
    description,
    '',
    '## Discovery context',
    detect.discoverySummary || '(none)',
    '',
    '## Relevant knowledge base',
    detect.relevantKbIds.length > 0
      ? detect.relevantKbIds.map((id) => `- ${id}`).join('\n')
      : '- (none)',
    '',
    '## Approach',
    '- (to be filled in during implementation phase)',
    '',
    '## Risks',
    '- (none identified)',
    '',
    '## Acceptance criteria',
    '- (to be filled in before gate 1)',
    // The presentation-convention sections below keep the stub aligned with
    // the prompt contract so bypass smokes and dev flows exercise the same
    // renderer shapes (table, mermaid, quiz) a real LLM spec produces. All
    // lines are static — interpolating the description into task-list items
    // would break the quiz shape on multi-line input.
    '',
    '## Files to change',
    '',
    '| File | Change |',
    '| --- | --- |',
    '| (to be determined) | (stub spec) |',
    '',
    '```mermaid',
    'graph LR',
    '  A[Task] --> B[Draft spec]',
    '  B --> C[Quality review]',
    '  C --> D[Gate 1 approval]',
    '```',
    '',
    '## Comprehension Quiz',
    '',
    '### Q1: What is the goal of this task?',
    '- [x] Deliver the change described in the Goal section above',
    '- [ ] Refactor unrelated subsystems',
    '- [ ] No goal has been defined yet',
    '> Explanation: See the Goal section at the top of this spec.',
    '',
    '### Q2: What happens to this draft spec next?',
    '- [ ] It goes straight to implementation',
    '- [x] It passes the spec-quality review loop, then Gate 1 approval',
    '- [ ] It is discarded',
    '> Explanation: Phase 0b.5 reviews the spec before the Gate 1 approval step.',
    '',
    '### Q3: Which input grounds the claims in this spec?',
    '- [ ] The git commit history',
    '- [ ] CI logs',
    '- [x] The discovery summary from phase 0a',
    '> Explanation: See the Discovery context section.',
  ];
  return { summary, spec: specLines.join('\n') };
}

export const phase0bPrePlanningStep: StepDefinition<PrePlanningDetect, PrePlanningApply> = {
  metadata: {
    id: '04-phase-0b-pre-planning',
    workflowType: 'workflow',
    index: 4,
    title: 'Phase 0b: Pre-planning',
    description:
      'Produces a draft specification for the task using the discovery summary as context.',
    requiresCli: false,
  },

  async detect(ctx: StepContext): Promise<PrePlanningDetect> {
    const meta = await loadTaskMeta(ctx.db, ctx.taskId);
    const prev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '03-phase-0a-discovery');
    const output = (prev?.output as DiscoveryOutput | null) ?? {};
    const ids = Array.isArray(output.relevantKbIds) ? output.relevantKbIds : [];
    const kbReferences = await resolveKbReferences(ctx.repoPath, ids);
    // Approved business requirements ground the technical spec when present — the
    // humanized 03b2 version if it ran, else 03b's raw draft.
    const businessRequirements = (await loadBusinessRequirements(ctx)).requirements;
    return {
      taskTitle: meta.title,
      taskDescription: meta.description,
      discoverySummary: output.summary ?? '',
      businessRequirements,
      relevantKbIds: ids,
      kbReferences,
      isBugFix: isBugBranch(meta.title, meta.description, meta.category),
      priorRejectionFeedback: await loadOutstandingSpecFeedback(ctx),
    };
  },

  form(_ctx, detected): FormSchema {
    const infoSections: InfoSection[] = [];
    if (detected.discoverySummary) {
      infoSections.push({
        title: 'Discovery summary',
        preview: `${detected.discoverySummary.length} chars`,
        body: detected.discoverySummary,
      });
    }
    if (detected.kbReferences.length > 0) {
      const lines = detected.kbReferences.map((kb) =>
        kb.exists ? `- ${kb.id}: ${kb.title}` : `- ${kb.id}: (file not found in repo)`,
      );
      infoSections.push({
        title: 'Relevant knowledge base files',
        preview: `${detected.kbReferences.length} file(s)`,
        body: lines.join('\n'),
      });
    }
    const revising = detected.priorRejectionFeedback.length > 0;
    return {
      title: 'Phase 0b: Pre-planning',
      description: [
        `Task: ${detected.taskTitle || '(untitled)'}`,
        '',
        detected.taskDescription || '(no description)',
        '',
        revising
          ? 'You rejected the previous spec at Gate 1. Your review feedback is pre-filled below — edit it if needed, then submit to re-draft the spec addressing it.'
          : detected.discoverySummary
            ? 'Discovery summary and KB files available below — expand to inspect.'
            : 'Discovery summary not available.',
      ].join('\n'),
      infoSections: infoSections.length > 0 ? infoSections : undefined,
      fields: [
        {
          type: 'textarea',
          id: 'scope',
          label: revising ? 'Revision feedback for the spec' : 'Scope / constraints (optional)',
          rows: 4,
          default: detected.priorRejectionFeedback || undefined,
          placeholder: 'Explicit boundaries, out-of-scope items, hard constraints.',
        },
      ],
      submitLabel: revising ? 'Re-draft with this feedback' : 'Draft spec',
      // On a revise (Gate 1 rejected the previous spec), auto-submit the pre-filled
      // feedback so the spec is re-drafted immediately — the user already authored it at
      // the Gate 1 review. First run leaves this unset so the user provides scope first.
      autoSubmit: revising ? true : undefined,
    };
  },

  llm: {
    requiredCapabilities: ['tool_use'],
    timeoutMs: 60 * 60 * 1000,
    buildPrompt: (args) => {
      const detected = args.detected as PrePlanningDetect;
      const values = args.formValues as { scope?: string };
      const revising = detected.priorRejectionFeedback.length > 0;
      const scopeVal = (values.scope ?? '').trim();
      return [
        'If a `.claude/agents/technical-spec-writer.md` agent definition exists in the repo, follow',
        'it; otherwise follow the protocol below.',
        'You are the pre-planning phase of an engineering workflow.',
        'Produce a concise draft specification for the task below.',
        'Emit ONE JSON object inside a ```json fenced code block with the shape:',
        '{ "summary": "<short rationale>", "spec": "<markdown spec body>" }',
        'The spec body must include sections: Goal, Approach, Risks, Acceptance criteria.',
        'Where the change touches them, the spec must also address the operational and lifecycle',
        'dimensions a reviewer will check: observability (logging/metrics for the new behavior),',
        'rollback (how to undo it), data/schema migration impact (safe and reversible), and backward',
        'compatibility for existing callers and stored data. Omit a dimension only when it genuinely',
        'does not apply to this change.',
        'Ground every claim in the discovery summary — do not invent details.',
        '',
        'Knowledge retrieval — use the `rag_search` MCP tool; it returns ranked, TYPED snippets:',
        '- KB articles + indexed code: the project’s documented behavior and the real implementation.',
        '- LEARNINGS (paths under `.claude/learnings/`): durable lessons from PRIOR runs. Search them to',
        '  avoid repeating past mistakes on similar work and fold the relevant ones into the Risks section.',
        detected.isBugFix
          ? '- RUN-BOOKS (`.claude/knowledge_base/investigations/`): past bug investigations (symptom → root cause → fix). This task is a BUG FIX — search them FIRST for this class of bug; quote the prior symptom/root cause and ground the Approach in what resolved it before.'
          : '- RUN-BOOKS (`.claude/knowledge_base/investigations/`): past bug investigations. Lower priority for this NEW-FEATURE task, but still worth checking when extending a historically-buggy area.',
        '',
        'Presentation conventions for the spec body (the Haive web renderer detects and upgrades these):',
        '1. REQUIRED final section `## Comprehension Quiz` with 3-5 questions that test understanding',
        '   of THIS change (goal, affected components, risks) — never generic trivia. Each question',
        '   uses EXACTLY this GFM shape (machine-detected):',
        '   ### Q1: <question text>',
        '   - [ ] <wrong answer>',
        '   - [x] <correct answer>',
        '   - [ ] <wrong answer>',
        '   > Explanation: <one or two sentences citing the spec section that answers it>',
        '   Exactly one [x] per question; VARY the position of the correct option across questions.',
        '2. ENCOURAGED: one or two ```mermaid fenced diagrams where component interaction explains the',
        '   change better than prose (e.g. `graph LR` of the 2-3 affected components and the data flow,',
        '   or a sequence diagram for a new flow). Keep each diagram under 15 nodes.',
        '3. Use a GFM table for the files-to-change overview. File-level code excerpts go in normal',
        '   fenced code blocks (the renderer auto-collapses blocks longer than ~12 lines).',
        '4. For before/after comparisons (UI, API, config), emit two ADJACENT fenced blocks whose',
        '   info-strings are exactly `before` and `after` — the renderer shows them side-by-side.',
        '',
        `Task title: ${detected.taskTitle || '(untitled)'}`,
        `Task description: ${detected.taskDescription || '(none)'}`,
        revising
          ? `=== Reviewer feedback to address in this revised spec ===\n${scopeVal || detected.priorRejectionFeedback}`
          : `Scope guidance: ${scopeVal || '(none)'}`,
        '',
        '=== Discovery summary ===',
        detected.discoverySummary || '(none)',
        ...(detected.businessRequirements
          ? ['', '=== Approved business requirements ===', detected.businessRequirements]
          : []),
        '',
        `Relevant KB ids: ${detected.relevantKbIds.join(', ') || '(none)'}`,
        '',
        INSIGHTS_INSTRUCTION,
      ].join('\n');
    },
    retry: { maxAttempts: 3, retryOn: (e) => e instanceof RetryableParseError },
  },

  async apply(ctx, args): Promise<PrePlanningApply> {
    const parsed = parsePrePlanningOutput(args.llmOutput ?? null);
    if (parsed) {
      ctx.logger.info({ source: 'llm' }, 'pre-planning spec parsed');
      return { summary: parsed.summary, spec: parsed.spec, source: 'llm' };
    }
    if (!args.isFinalLlmAttempt) {
      throw new RetryableParseError('pre-planning spec output unparseable — retrying');
    }
    const stub = stubPrePlanning(args.detected);
    ctx.logger.info({ source: 'stub' }, 'pre-planning spec stubbed');
    return { summary: stub.summary, spec: stub.spec, source: 'stub' };
  },
};
