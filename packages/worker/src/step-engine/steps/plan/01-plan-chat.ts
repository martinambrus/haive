import { asc, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { CONFIG_KEYS, configService, type FormSchema } from '@haive/shared';
import { loadPlanNode, renderPlanMarkdown } from '@haive/shared/plan';
import type { StepDefinition } from '../../step-definition.js';
import { writePlanMirror } from '../../../plan/mirror.js';
import { PLAN_PATCH_CONTRACT, applyAgentPatch, parsePlanPatch } from './_plan-prompt.js';

/**
 * A conversation about ONE node that may patch ANY node.
 *
 * The agent is handed the whole plan rendered as markdown, not just the node in
 * focus. That is the point: a request made while looking at "Android" ("we
 * should test this on a real device") often belongs on the QA node, and a chat
 * that could only edit where it was opened would either refuse or put it in the
 * wrong place.
 *
 * The transcript lives in `plan_node_messages`, NOT in this step's output,
 * because the revise loop below resets the step row on every cycle and would
 * take the history with it.
 */

interface PlanChatDetect {
  repositoryId: string | null;
  nodeId: string | null;
  nodeTitle: string;
  nodeVersion: number;
  planMarkdown: string;
  transcript: { role: string; body: string }[];
  /** The turn this pass is answering — the newest user message with no reply
   *  after it. Null when the conversation is up to date, which is what ends it. */
  pendingQuestion: string | null;
}

interface PlanChatApply {
  applied: boolean;
  created: number;
  updated: number;
  deleted: number;
  linked: number;
  summary: string;
  /** True when the user submitted another message, which re-enters this step. */
  continueRequested: boolean;
  error: string | null;
}

function buildChatPrompt(d: PlanChatDetect): string {
  const history = d.transcript
    .map((m) => `${m.role === 'user' ? 'User' : 'You'}: ${m.body}`)
    .join('\n\n');
  return [
    'You are editing a project plan through conversation.',
    '',
    'Here is the WHOLE plan. Each node shows its id, kind, status and links.',
    '',
    d.planMarkdown,
    '',
    `## The user is looking at`,
    `${d.nodeTitle} (\`node:${d.nodeId}\`, version ${d.nodeVersion})`,
    '',
    '## Conversation so far',
    history || '(this is the first message)',
    '',
    '## What to do',
    'Answer the latest message by PATCHING the plan. You may patch any node, not only the one',
    'the user is looking at — if what they asked for belongs somewhere else in the tree, put it',
    'there and say so in your summary.',
    '',
    'If the message is a question rather than a change request, reply with an empty `ops` array',
    'and put the answer in `summary`. Do not change the plan to answer a question.',
    '',
    'Send `expectedVersion` with every change to an existing node, using the version shown',
    'beside it above.',
    '',
    PLAN_PATCH_CONTRACT,
  ].join('\n');
}

export const planChatStep: StepDefinition<PlanChatDetect, PlanChatApply> = {
  metadata: {
    id: '01-plan-chat',
    workflowType: 'plan_chat',
    index: 0,
    title: 'Plan conversation',
    description:
      'Answers a question about one part of the plan by patching the plan — anywhere in it, since the agent is given the whole tree.',
    requiresCli: true,
  },

  async shouldRun(): Promise<boolean> {
    return (await configService.getBoolean(CONFIG_KEYS.PLAN_CANVAS_ENABLED, true)) !== false;
  },

  async detect(ctx): Promise<PlanChatDetect> {
    const [task] = await ctx.db
      .select({ repositoryId: schema.tasks.repositoryId, metadata: schema.tasks.metadata })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, ctx.taskId))
      .limit(1);
    const repositoryId = task?.repositoryId ?? null;
    const nodeId = ((task?.metadata ?? {}) as { planNodeId?: string }).planNodeId ?? null;

    const empty: PlanChatDetect = {
      repositoryId,
      nodeId,
      nodeTitle: '',
      nodeVersion: 0,
      planMarkdown: '',
      transcript: [],
      pendingQuestion: null,
    };
    if (!repositoryId || !nodeId) return empty;

    const node = await loadPlanNode(ctx.db, repositoryId, nodeId);
    if (!node) return empty;

    const messages = await ctx.db
      .select({ role: schema.planNodeMessages.role, body: schema.planNodeMessages.body })
      .from(schema.planNodeMessages)
      .where(eq(schema.planNodeMessages.nodeId, nodeId))
      .orderBy(asc(schema.planNodeMessages.createdAt));

    // The pending turn is the newest user message with nothing after it. Derived
    // rather than stored: the step row resets every revise cycle, so anything
    // remembered on it would be gone by the next pass.
    const last = messages.at(-1);
    return {
      repositoryId,
      nodeId,
      nodeTitle: node.title,
      nodeVersion: node.version,
      planMarkdown: await renderPlanMarkdown(ctx.db, repositoryId, { focusNodeId: nodeId }),
      transcript: messages,
      pendingQuestion: last?.role === 'user' ? last.body : null,
    };
  },

  llm: {
    requiredCapabilities: ['tool_use'],
    toolProfile: 'rag_only',
    timeoutMs: 15 * 60 * 1000,
    // Nothing to answer means nothing to ask: a re-entry whose form was submitted
    // blank finalizes without spending an invocation.
    skipIf: ({ detected }) => (detected as PlanChatDetect).pendingQuestion === null,
    buildPrompt: ({ detected }) => buildChatPrompt(detected as PlanChatDetect),
    bypassStub: () => ({ summary: 'test bypass — no change', ops: [] }),
  },

  form(_ctx, detected): FormSchema | null {
    if (!detected.nodeId) return null;
    return {
      title: `Plan chat: ${detected.nodeTitle}`,
      description:
        'Ask for another change, or submit blank to end the conversation. The agent is given the whole plan, so a request that belongs on a different node lands there.',
      fields: [
        {
          type: 'textarea',
          id: 'message',
          label: 'Next message',
          description: 'Leave empty to finish.',
          required: false,
        },
      ],
    };
  },

  reviseLoop: {
    // Self-target: a non-blank message re-enters THIS step so the conversation
    // continues on ONE card instead of accumulating a step per turn. Uncapped and
    // human-gated — the form re-parks every cycle, so the user ends it by
    // submitting nothing.
    evaluate: (out) => (out.continueRequested ? { targetStepId: '01-plan-chat' } : null),
  },

  async apply(ctx, args): Promise<PlanChatApply> {
    const d = args.detected;
    const result: PlanChatApply = {
      applied: false,
      created: 0,
      updated: 0,
      deleted: 0,
      linked: 0,
      summary: '',
      continueRequested: false,
      error: null,
    };
    if (!d.repositoryId || !d.nodeId) return result;

    if (d.pendingQuestion !== null) {
      const patch = parsePlanPatch(args.llmOutput ?? null);
      if (!patch) {
        result.error = 'The agent did not reply with a usable patch.';
      } else {
        result.summary = patch.summary ?? '';
        try {
          if (patch.ops.length > 0) {
            const res = await applyAgentPatch(ctx.db, patch, {
              repositoryId: d.repositoryId,
              sourceTaskId: ctx.taskId,
              retryable: args.isFinalLlmAttempt !== true,
            });
            result.applied = true;
            result.created = res.created.length;
            result.updated = res.updated.length;
            result.deleted = res.deleted.length;
            result.linked = res.linked;
          }
        } catch (err) {
          // A conflict is reported to the USER rather than retried: the plan moved
          // under the agent, and the next turn re-reads it anyway.
          result.error = err instanceof Error ? err.message : String(err);
        }
      }

      // The assistant turn is recorded whatever happened, including the failure —
      // a transcript that silently omits a turn is worse than one that shows it
      // went wrong.
      await ctx.db.insert(schema.planNodeMessages).values({
        nodeId: d.nodeId,
        taskId: ctx.taskId,
        role: 'assistant',
        body:
          result.error !== null
            ? `${result.summary || 'Could not apply that.'}\n\n_${result.error}_`
            : result.summary || 'Done.',
        patchJson: patch
          ? { ops: patch.ops, ...(patch.summary ? { summary: patch.summary } : {}) }
          : null,
      });

      try {
        await writePlanMirror(ctx.db, d.repositoryId, ctx.repoPath);
      } catch (err) {
        ctx.logger.warn({ err }, 'plan mirror write failed (non-fatal)');
      }
    }

    const next = String((args.formValues as { message?: unknown }).message ?? '').trim();
    if (next) {
      await ctx.db.insert(schema.planNodeMessages).values({
        nodeId: d.nodeId,
        taskId: ctx.taskId,
        role: 'user',
        body: next,
      });
      result.continueRequested = true;
    }
    return result;
  },
};
