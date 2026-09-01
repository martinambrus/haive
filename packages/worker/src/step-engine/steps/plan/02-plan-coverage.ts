import { readFile } from 'node:fs/promises';
import { and, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { FormSchema, FormValues } from '@haive/shared';
import { loadPlanSkeletons, renderPlanMarkdown } from '@haive/shared/plan';
import type { StepDefinition } from '../../step-definition.js';
import { MiningWaveError } from '../../step-definition.js';
import { shouldRetryMiningTerminalFailure } from '../../mining-failure.js';
import { writePlanMirror } from '../../../plan/mirror.js';
import { APPLY_FAILURE_PREFIX, PARTIAL_APPLY_PREFIX } from './01-plan-build.js';
import { PLAN_PATCH_CONTRACT, applyAgentPatch, parsePlanPatch } from './_plan-prompt.js';
import {
  findCoverageGaps,
  findStructuralGaps,
  parseDocSections,
  type CoverageCandidate,
  type StructuralGap,
} from './plan-coverage-scan.js';

/**
 * What the build did not cover, reported for a person to rule on.
 *
 * Runs after 01-plan-build and REPORTS. It never edits the plan on its own: an
 * agent asked "what is missing?" against a 200 KB document and 800 nodes always
 * finds something, so an autonomous fixer has no fixed point and would grow the
 * plan on every run. The human tick is the fixed point, and the model is spent
 * only on gaps someone confirmed.
 *
 * Detection is deterministic, and its PRIMARY signal is structural rather than
 * textual. That is not a shortcut — it is what the evidence says. A term-coverage
 * scan cannot see this class of defect: when a build left a component with zero
 * children, that component's own title and body still named its subject, so every
 * word of the matching document section was present. MEASURED further: removing
 * a 92-node component from a 791-node plan changed a term scan's verdict not at
 * all, because the remaining nodes still mention those words somewhere. Tree
 * shape and the build's own recorded losses are what actually detect it.
 */

interface CoverageDetect {
  repositoryId: string | null;
  structural: StructuralGap[];
  sections: CoverageCandidate[];
  /** Section bodies, so a confirmed gap can be handed to an agent as a brief. */
  sectionBodies: Record<string, string>;
  planMarkdown: string;
  nodeCount: number;
  docName: string | null;
}

interface CoverageApply {
  checked: number;
  structural: number;
  sections: number;
  dispatched: number;
  decision: 'clean' | 'accepted' | 'redecomposed';
}

/** One line per gap in the gate's list, and the value the multi-select stores. */
const structuralKey = (g: StructuralGap): string => `node:${g.nodeId}`;
const sectionKey = (c: CoverageCandidate): string => `doc:${c.line}`;
/** One derivation, used by both the dispatcher and the already-handled filter —
 *  two spellings of this would silently stop matching. */
const sectionAgentId = (key: string): string => `cover-${key.replace(/\W+/g, '-')}`;

export const planCoverageStep: StepDefinition<CoverageDetect, CoverageApply> = {
  metadata: {
    id: '02-plan-coverage',
    workflowType: 'plan_build',
    index: 1,
    title: 'Coverage check',
    description:
      'Reports what the build left undecomposed or lost, and offers to re-run the decomposition for the parts you pick.',
    // The check itself is deterministic; a CLI is spent only on the gaps a
    // person ticks, which is dispatched as mining from apply().
    requiresCli: false,
  },

  async detect(ctx): Promise<CoverageDetect> {
    const [task] = await ctx.db
      .select({ repositoryId: schema.tasks.repositoryId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, ctx.taskId))
      .limit(1);
    const repositoryId = task?.repositoryId ?? null;
    const empty: CoverageDetect = {
      repositoryId,
      structural: [],
      sections: [],
      sectionBodies: {},
      planMarkdown: '',
      nodeCount: 0,
      docName: null,
    };
    if (!repositoryId) return empty;

    const skeletons = await loadPlanSkeletons(ctx.db, repositoryId);
    if (skeletons.length === 0) return empty;

    // The build's OWN record of what it lost. Written by 01-plan-build on the
    // agent rows, which outlive the step output that a retry nulls.
    const agents = await ctx.db
      .select({
        agentId: schema.taskStepAgentMinings.agentId,
        status: schema.taskStepAgentMinings.status,
        errorMessage: schema.taskStepAgentMinings.errorMessage,
      })
      .from(schema.taskStepAgentMinings)
      .innerJoin(schema.taskSteps, eq(schema.taskSteps.id, schema.taskStepAgentMinings.taskStepId))
      .where(
        and(eq(schema.taskSteps.taskId, ctx.taskId), eq(schema.taskSteps.stepId, '01-plan-build')),
      );

    // What a previous pass of THIS step already re-decomposed. The build's agent
    // rows record "1 operation dropped" forever — that fact does not stop being
    // true once the gap is filled — so without this the report would re-offer
    // work already done, and running it twice would grow the plan for no reason.
    // Only a pass that actually LANDED counts: an agent whose own patch failed
    // leaves the item outstanding.
    const handled = new Set(
      (
        await ctx.db
          .select({
            agentId: schema.taskStepAgentMinings.agentId,
            status: schema.taskStepAgentMinings.status,
            errorMessage: schema.taskStepAgentMinings.errorMessage,
          })
          .from(schema.taskStepAgentMinings)
          .innerJoin(
            schema.taskSteps,
            eq(schema.taskSteps.id, schema.taskStepAgentMinings.taskStepId),
          )
          .where(
            and(
              eq(schema.taskSteps.taskId, ctx.taskId),
              eq(schema.taskSteps.stepId, '02-plan-coverage'),
            ),
          )
      )
        .filter((a) => a.status === 'done' && !a.errorMessage)
        .map((a) => a.agentId),
    );

    const structural = findStructuralGaps(
      skeletons.map((n) => ({
        id: n.id,
        title: n.title,
        kind: String(n.kind),
        parentId: n.parentId,
      })),
      agents,
      { failure: APPLY_FAILURE_PREFIX, partial: PARTIAL_APPLY_PREFIX },
    ).filter((g) => !handled.has(`cover-node-${g.nodeId}`));

    // The source document, when this build had one. A from_repo build has no
    // single authority to check against, so the section half simply does not run.
    let sections: CoverageCandidate[] = [];
    const sectionBodies: Record<string, string> = {};
    let docName: string | null = null;
    const [attachment] = await ctx.db
      .select({
        filename: schema.taskAttachments.filename,
        storedPath: schema.taskAttachments.storedPath,
      })
      .from(schema.taskAttachments)
      .where(eq(schema.taskAttachments.taskId, ctx.taskId))
      .limit(1);
    if (attachment) {
      try {
        const doc = await readFile(attachment.storedPath, 'utf8');
        const parsed = parseDocSections(doc);
        const texts = skeletons.map((n) => n.title);
        const bodies = await ctx.db
          .select({ id: schema.planNodes.id, body: schema.planNodes.body })
          .from(schema.planNodes)
          .where(eq(schema.planNodes.repositoryId, repositoryId));
        const byId = new Map(bodies.map((b) => [b.id, b.body ?? '']));
        sections = findCoverageGaps(
          parsed,
          skeletons.map((n, i) => `${texts[i] ?? ''} ${byId.get(n.id) ?? ''}`),
        ).filter((c) => !handled.has(sectionAgentId(sectionKey(c))));
        for (const c of sections) {
          sectionBodies[sectionKey(c)] = parsed.find((p) => p.line === c.line)?.body ?? '';
        }
        docName = attachment.filename;
      } catch (err) {
        // A document we cannot read is not a coverage failure. Report the
        // structural half rather than failing the step over a missing file.
        ctx.logger.warn({ err }, 'coverage: could not read the source document');
      }
    }

    return {
      repositoryId,
      structural,
      sections,
      sectionBodies,
      planMarkdown: await renderPlanMarkdown(ctx.db, repositoryId, { titlesOnly: true }),
      nodeCount: skeletons.length,
      docName,
    };
  },

  /** Null when there is nothing to show, so a clean build finishes unattended
   *  exactly as it did before this step existed. */
  form(_ctx, detected): FormSchema | null {
    const total = detected.structural.length + detected.sections.length;
    if (total === 0) return null;

    const options = [
      ...detected.structural.map((g) => ({
        value: structuralKey(g),
        label: `${g.title} — ${g.reason}`,
      })),
      ...detected.sections.map((c) => ({
        value: sectionKey(c),
        label: `§${c.title} — no node covers ${c.missingTerms.slice(0, 4).join(', ')}`,
      })),
    ];

    return {
      title: 'Coverage check',
      description: [
        `The plan has ${detected.nodeCount} nodes. ${total} thing(s) look unfinished:`,
        detected.structural.length > 0
          ? `${detected.structural.length} node(s) whose decomposition was lost or thinned.`
          : '',
        detected.sections.length > 0 && detected.docName
          ? `${detected.sections.length} section(s) of ${detected.docName} that no node appears to cover.`
          : '',
        '',
        'Re-running asks one agent per item to add what is missing. Accepting leaves the plan as it is — nothing here is deleted either way.',
      ]
        .filter(Boolean)
        .join('\n'),
      infoSections: [
        {
          title: 'What was found',
          preview: `${detected.structural.length} lost, ${detected.sections.length} uncovered`,
          body: options.map((o) => `- ${o.label}`).join('\n'),
          defaultOpen: true,
        },
      ],
      fields: [
        {
          type: 'radio',
          id: 'decision',
          label: 'What do you want to do?',
          options: [
            { value: 'redecompose', label: 'Re-run the decomposition for the items I pick' },
            { value: 'accept', label: 'Accept the plan as it is' },
          ],
          default: 'redecompose',
          required: true,
        },
        {
          type: 'multi-select',
          id: 'items',
          label: 'Which ones?',
          options,
          // Pre-ticked: a lost decomposition is a known loss, not a suggestion.
          // An uncovered section is a heuristic, so it starts unticked.
          defaults: detected.structural.map(structuralKey),
          visibleWhen: { field: 'decision', equals: 'redecompose' },
        },
        {
          type: 'textarea',
          id: 'note',
          label: 'Anything to tell the agents (optional)',
          rows: 3,
          visibleWhen: { field: 'decision', equals: 'redecompose' },
        },
      ],
      submitLabel: 'Record decision',
    };
  },

  agentMining: {
    requiredCapabilities: ['tool_use'],
    toolProfile: 'rag_only',
    // A recovery terminal is the last automated chance to replace missing plan
    // work. Retry transient infrastructure failures before returning control to
    // the gate; a final failure remains outstanding on a step retry because the
    // handled filter counts only clean, completed agents.
    retry: { maxAttempts: 2, retryOnInvocationFailure: shouldRetryMiningTerminalFailure },
    // Every agent of this step is dispatched from apply() once the user has
    // picked. Nothing fans out before the gate — the whole point is that the
    // model is spent only on confirmed gaps.
    async selectAgents() {
      return [];
    },
  },

  async apply(ctx, args): Promise<CoverageApply> {
    const d = args.detected;
    const result: CoverageApply = {
      checked: d.nodeCount,
      structural: d.structural.length,
      sections: d.sections.length,
      dispatched: 0,
      decision: 'clean',
    };
    if (!d.repositoryId || d.structural.length + d.sections.length === 0) return result;

    // Fold whatever the re-decomposition agents returned. Same applier as the
    // builder, so these patches inherit the last-block parser, the drop of
    // unresolvable refs, and `self`.
    const fold = args.newAgentMiningResults ?? args.agentMiningResults ?? [];
    if (fold.length > 0) {
      for (const r of fold) {
        if (r.status !== 'done') continue;
        const patch = parsePlanPatch(r.output ?? r.rawOutput);
        if (!patch || patch.ops.length === 0) continue;
        const self = /^cover-node-([0-9a-f-]{36})$/.exec(r.agentId)?.[1];
        await applyAgentPatch(ctx.db, patch, {
          repositoryId: d.repositoryId,
          sourceTaskId: ctx.taskId,
          retryable: false,
          ...(self ? { selfNodeId: self } : {}),
        }).catch(async (err: unknown) => {
          // Stamped so the item stays OUTSTANDING: the already-handled filter in
          // detect() counts only agents whose patch landed.
          ctx.logger.warn({ err, agentId: r.agentId }, 'coverage re-decomposition patch failed');
          await ctx.db
            .update(schema.taskStepAgentMinings)
            .set({
              errorMessage:
                `${APPLY_FAILURE_PREFIX} ${err instanceof Error ? err.message : String(err)}`.slice(
                  0,
                  2000,
                ),
            })
            .where(
              and(
                eq(schema.taskStepAgentMinings.taskStepId, ctx.taskStepId),
                eq(schema.taskStepAgentMinings.agentId, r.agentId),
              ),
            )
            .catch(() => undefined);
        });
      }
      // Every plan-step apply refreshes the committed mirror. Without it the
      // nodes this step recovered exist only in the database, and a restore or a
      // fresh clone silently drops exactly the work the check was run to get
      // back. Best-effort, as elsewhere: a mirror that cannot be written must
      // not undo the patches that just landed.
      try {
        await writePlanMirror(ctx.db, d.repositoryId, ctx.repoPath);
      } catch (err) {
        ctx.logger.warn({ err }, 'plan mirror write failed after coverage re-decomposition');
      }
      result.decision = 'redecomposed';
      result.dispatched = fold.length;
      return result;
    }

    const values = (args.formValues ?? {}) as FormValues;
    if (values.decision !== 'redecompose') {
      result.decision = 'accepted';
      return result;
    }
    const picked = Array.isArray(values.items) ? (values.items as string[]) : [];
    if (picked.length === 0) {
      result.decision = 'accepted';
      return result;
    }

    const note = typeof values.note === 'string' && values.note.trim() ? values.note.trim() : null;
    const dispatches = picked.map((key) => {
      const structural = d.structural.find((g) => structuralKey(g) === key);
      const section = d.sections.find((c) => sectionKey(c) === key);
      const subject = structural
        ? `the plan node "${structural.title}" (${structural.reason})`
        : `the source document section "${section?.title ?? key}"`;
      return {
        // The node id rides in the agent id so apply() can hand the patch a
        // `self` ref and the agent never transcribes a uuid.
        agentId: structural
          ? `cover-node-${structural.nodeId}`
          : `cover-${key.replace(/\W+/g, '-')}`,
        agentTitle: `Cover: ${(structural?.title ?? section?.title ?? key).slice(0, 60)}`,
        roleKey: 'expand',
        prompt: [
          `You are completing a project plan that is missing work under ${subject}.`,
          '',
          structural
            ? [
                'Its decomposition was attempted and lost, so it currently has no children.',
                'Rebuild the missing subtree: add the children that the failed terminal should',
                'have produced, plus any necessary descendants, until its leaves are taskable',
                'at the same granularity as the rest of the plan.',
              ].join(' ')
            : 'No node in the plan covers this section. Add what it describes, under whichever existing node fits best.',
          '',
          section ? `The section reads:\n\n${(d.sectionBodies[key] ?? '').slice(0, 20_000)}\n` : '',
          note ? `The user adds: ${note}\n` : '',
          'The plan as it stands (titles only):',
          '',
          d.planMarkdown.slice(0, 60_000),
          '',
          'Add ONLY what is missing. Do not restate nodes that already exist, and do not',
          'duplicate a sibling under a different name — the reader is looking at this plan',
          'and will see both.',
          '',
          PLAN_PATCH_CONTRACT,
        ]
          .filter(Boolean)
          .join('\n'),
      };
    });

    throw new MiningWaveError(
      dispatches,
      `coverage re-decomposition: ${dispatches.length} agent(s)`,
    );
  },
};
