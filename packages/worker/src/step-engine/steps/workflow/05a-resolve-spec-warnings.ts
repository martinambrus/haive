import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FormSchema, InfoSection } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';
import { parseCorrectorOutput } from './05-phase-0b5-spec-quality.js';
import { retrievalGuidanceLines } from '../_retrieval-guidance.js';
import { loadOutstandingSpecFeedback } from './_spec-feedback.js';

// The spec-quality (05) amended spec is written here so the user can hand-edit
// it in the Terminal tab (the workspace mounts at ctx.sandboxWorkdir, RW for
// cloned/volume repos). The worker-FS path is ctx.repoPath + this; the terminal
// sees it at ctx.sandboxWorkdir + this.
const SPEC_REVIEW_REL = '.haive/spec-review.md';

interface QualityFinding {
  dimension?: string;
  severity?: string;
  comment?: string;
}

interface SpecQualityOutput {
  verdict?: string;
  score?: number;
  findings?: QualityFinding[];
  spec?: string;
}

type ResolveAction = 'continue' | 'manual' | 'agent';

interface ResolveWarningsDetect {
  findings: string[];
  warnCount: number;
  errorCount: number;
  /** The spec-quality amended spec (the working draft). */
  spec: string;
  /** In-terminal path of the editable spec file. */
  specFilePath: string;
  /** True on a spec revise round (gate-1 rejected the prior spec, not yet
   *  re-approved). The form auto-submits ("continue as-is") then, advancing the
   *  re-drafted spec straight to the gate-1 re-review instead of re-gating here. */
  revising: boolean;
  /** True when the broad auditor (04a) contributed findings — the form then
   *  defaults to the agent fix (validate-then-act) instead of "continue". */
  hasAuditFindings: boolean;
}

interface ResolveWarningsApply {
  /** Final spec body after this checkpoint — passed to gate 1 + implementation. */
  spec: string;
  action: ResolveAction;
}

function formatFinding(f: QualityFinding): string {
  const sev = (f.severity ?? 'info').toUpperCase();
  const dim = f.dimension ?? 'general';
  return `[${sev}] ${dim}: ${f.comment ?? ''}`;
}

async function loadQuality(ctx: StepContext): Promise<SpecQualityOutput> {
  const q = await loadPreviousStepOutput(ctx.db, ctx.taskId, '05-phase-0b5-spec-quality');
  return (q?.output as SpecQualityOutput | null) ?? {};
}

/** Findings from the broad spec auditor (04a). Merged with the narrow 05 findings
 *  so the existing validate-then-act corrector resolves both sets. */
async function loadAuditFindings(ctx: StepContext): Promise<QualityFinding[]> {
  const a = await loadPreviousStepOutput(ctx.db, ctx.taskId, '04a-spec-audit');
  const findings = (a?.output as { findings?: QualityFinding[] } | null)?.findings;
  return Array.isArray(findings) ? findings : [];
}

/** Fallback spec body when 05 did not run (e.g. plan_tasklist): the 04 draft. */
async function loadDraftSpec(ctx: StepContext): Promise<string> {
  const plan = await loadPreviousStepOutput(ctx.db, ctx.taskId, '04-phase-0b-pre-planning');
  const out = (plan?.output as { spec?: string; summary?: string } | null) ?? {};
  return out.spec ?? out.summary ?? '';
}

function specReviewFsPath(ctx: StepContext): string {
  return path.join(ctx.repoPath, SPEC_REVIEW_REL);
}

const FIX_RULES = [
  'You are fixing the remaining findings on a tech spec before it goes to a human approval',
  'gate. A reviewer produced the findings below against the spec.',
  '',
  'Do NOT blindly trust the reviewer. For EACH finding, FIRST validate it against the actual',
  'spec text and the codebase: confirm it is real, correctly described, relevant, and not',
  'already addressed. To check the codebase, use this order:',
  ...retrievalGuidanceLines(),
  'Fix ONLY the findings you validated as real and relevant; ignore the rest. Edit the spec',
  'minimally and precisely — do not add polish, expand scope, or reword what already works.',
  "Preserve the spec's presentation sections verbatim unless a finding targets them: the",
  '`## Comprehension Quiz`, any ```mermaid fences, and any ```before/```after fence pairs',
  'must survive your amendment.',
  '',
  'Emit ONE JSON object inside a ```json fenced code block with the shape:',
  '{ "amendedSpec": "<the FULL revised spec body — never a diff or partial snippet>" }',
  'If no finding is valid, return the current spec unchanged in amendedSpec.',
] as const;

export const resolveSpecWarningsStep: StepDefinition<ResolveWarningsDetect, ResolveWarningsApply> =
  {
    metadata: {
      id: '05a-resolve-spec-warnings',
      workflowType: 'workflow',
      index: 5.5,
      title: 'Resolve spec warnings',
      description:
        'Surfaces the spec reviewer’s remaining findings before approval — continue as-is, hand-edit the spec in the Terminal, or have an agent fix them.',
      requiresCli: false,
    },

    // Skip entirely (→ straight to gate 1) when the spec-quality pass left no findings.
    async shouldRun(ctx: StepContext): Promise<boolean> {
      const q = await loadQuality(ctx);
      const qf = Array.isArray(q.findings) ? q.findings.length : 0;
      if (qf > 0) return true;
      return (await loadAuditFindings(ctx)).length > 0;
    },

    async detect(ctx: StepContext): Promise<ResolveWarningsDetect> {
      const q = await loadQuality(ctx);
      const auditFindings = await loadAuditFindings(ctx);
      const findings = [...(Array.isArray(q.findings) ? q.findings : []), ...auditFindings];
      const spec = q.spec || (await loadDraftSpec(ctx));
      // Materialize the spec to a workspace file for hand-editing, but only if
      // absent so a re-detect (e.g. CLI-provider change) doesn't clobber edits.
      const fsPath = specReviewFsPath(ctx);
      try {
        await access(fsPath);
      } catch {
        await mkdir(path.dirname(fsPath), { recursive: true });
        await writeFile(fsPath, spec, 'utf8');
      }
      return {
        findings: findings.map(formatFinding),
        warnCount: findings.filter((f) => f.severity === 'warn').length,
        errorCount: findings.filter((f) => f.severity === 'error').length,
        spec,
        specFilePath: `${ctx.sandboxWorkdir}/${SPEC_REVIEW_REL}`,
        revising: (await loadOutstandingSpecFeedback(ctx)).length > 0,
        hasAuditFindings: auditFindings.length > 0,
      };
    },

    form(_ctx, detected): FormSchema {
      const infoSections: InfoSection[] = [
        {
          title: `Remaining findings (${detected.errorCount} error / ${detected.warnCount} warn)`,
          preview: `${detected.findings.length} finding(s)`,
          body:
            detected.findings.length > 0
              ? detected.findings.map((f) => `- ${f}`).join('\n')
              : '_No findings recorded._',
          defaultOpen: true,
        },
      ];
      return {
        title: 'Resolve spec warnings',
        description: [
          'The spec reviewer left the findings below. The approved spec was written to',
          `\`${detected.specFilePath}\` — open the **Terminal** tab to hand-edit it, then pick`,
          '"use my terminal edits". Or have an agent fix them (pick the CLI on this card), or',
          'continue to approval as-is.',
        ].join('\n'),
        infoSections,
        fields: [
          {
            type: 'radio',
            id: 'action',
            label: 'How do you want to handle these findings?',
            options: [
              { value: 'continue', label: 'Continue — send the spec to approval as-is' },
              { value: 'manual', label: `Use my terminal edits to ${detected.specFilePath}` },
              {
                value: 'agent',
                label: 'Have an agent fix them (uses the CLI picked on this card)',
              },
            ],
            default: detected.revising
              ? 'continue'
              : detected.hasAuditFindings
                ? 'agent'
                : 'continue',
            required: true,
          },
        ],
        submitLabel: 'Continue',
        // On a spec revise (gate-1 rejected the prior spec), auto-submit the default
        // "continue as-is" so the re-drafted + re-reviewed spec advances straight to the
        // gate-1 re-review. First pass (no outstanding rejection) gates so the user can
        // hand-edit or agent-fix the remaining findings.
        autoSubmit: detected.revising ? true : undefined,
      };
    },

    llm: {
      requiredCapabilities: ['tool_use'],
      timeoutMs: 60 * 60 * 1000,
      // The fixing agent only runs when the user chose "agent".
      skipIf: (args) => (args.formValues as { action?: string }).action !== 'agent',
      buildPrompt: (args) => {
        const detected = args.detected as ResolveWarningsDetect;
        return [
          ...FIX_RULES,
          '',
          '=== Findings to address ===',
          detected.findings.length > 0
            ? detected.findings.map((f) => `- ${f}`).join('\n')
            : '(none)',
          '',
          '=== Current spec body ===',
          detected.spec || '(empty)',
        ].join('\n');
      },
    },

    async apply(ctx, args): Promise<ResolveWarningsApply> {
      const detected = args.detected as ResolveWarningsDetect;
      const action = ((args.formValues as { action?: string }).action ??
        'continue') as ResolveAction;

      if (action === 'agent') {
        const fixed = parseCorrectorOutput(args.llmOutput ?? null);
        const spec =
          fixed?.amendedSpec && fixed.amendedSpec.trim().length > 0
            ? fixed.amendedSpec
            : detected.spec;
        ctx.logger.info(
          { action, amended: Boolean(fixed?.amendedSpec) },
          'resolve-spec-warnings: agent fix applied',
        );
        return { spec, action };
      }

      if (action === 'manual') {
        let spec = detected.spec;
        try {
          const edited = await readFile(specReviewFsPath(ctx), 'utf8');
          if (edited.trim().length > 0) spec = edited;
        } catch (err) {
          ctx.logger.warn(
            { err },
            'resolve-spec-warnings: could not read edited spec; using 05 spec',
          );
        }
        ctx.logger.info({ action }, 'resolve-spec-warnings: using terminal edits');
        return { spec, action };
      }

      ctx.logger.info({ action: 'continue' }, 'resolve-spec-warnings: continue as-is');
      return { spec: detected.spec, action: 'continue' };
    },
  };
