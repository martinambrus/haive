import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import type { FormSchema } from '@haive/shared';
import {
  TYPE_DRAFT_MESSAGE_EVENT,
  TYPE_DRAFT_MESSAGE_MAX_CHARS,
  type TypeDraftAssistantTurn,
  type TypeDraftUserTurn,
} from '@haive/shared/modularity';
import { readStepCatalog } from '@haive/shared/modularity-server';
import { stepRegistry, type StepRegistry } from '../../registry.js';
import {
  RetryableParseError,
  type StepContext,
  type StepDefinition,
} from '../../step-definition.js';
import { BASELINE_AGENT_SPECS, FRAMEWORK_AGENT_SPECS } from '../onboarding/_agent-templates.js';
import {
  TYPE_DRAFT_REPAIR_EVENT,
  buildDraftPrompt,
  deriveConversation,
  judgeDraftReply,
  parseDraftReply,
  readEditorState,
  type DraftCatalogStep,
  type DraftPersona,
  type TypeDraftDetect,
} from './_type-draft.js';

const STEP_ID = '01-type-draft';

interface TypeDraftApply {
  pass: 'answer' | 'repair' | 'collect';
  continueRequested: boolean;
  issues: number;
  error: string | null;
}

export async function loadDraftCatalog(
  db: Database,
  registry: StepRegistry = stepRegistry,
): Promise<DraftCatalogStep[]> {
  const [catalog, off] = await Promise.all([
    readStepCatalog(db, { ordered: true }),
    db
      .select({ moduleId: schema.modules.moduleId })
      .from(schema.modules)
      .where(isNotNull(schema.modules.deactivatedAt)),
  ]);
  const deactivated = new Set(off.map((m) => `module:${m.moduleId}`));
  return catalog.steps
    .filter((step) => !deactivated.has(step.source))
    .map((step) => ({
      entry: step.entry,
      description: registry.get(step.stepId)?.metadata.description ?? '',
    }));
}

export function collectPersonas(): DraftPersona[] {
  return [
    ...BASELINE_AGENT_SPECS.map((s) => ({
      id: s.id,
      title: s.title,
      description: s.description,
      framework: null,
    })),
    ...Object.entries(FRAMEWORK_AGENT_SPECS).flatMap(([framework, specs]) =>
      specs.map((s) => ({ id: s.id, title: s.title, description: s.description, framework })),
    ),
  ];
}

async function record(ctx: StepContext, eventType: string, payload: object): Promise<void> {
  await ctx.db.insert(schema.taskEvents).values({
    taskId: ctx.taskId,
    taskStepId: ctx.taskStepId,
    eventType,
    payload: payload as Record<string, unknown>,
  });
}

const UNREADABLE_REPLY =
  'The agent did not send a reply Haive could read, so there is no draft. Send your message again, or switch to another CLI.';

export const typeDraftStep: StepDefinition<TypeDraftDetect, TypeDraftApply> = {
  metadata: {
    id: STEP_ID,
    workflowType: 'type_draft',
    index: 0,
    title: 'Draft a task type',
    description:
      'Drafts a task type with an administrator, in conversation. The draft is loaded into the editor as unsaved changes; nothing is saved here.',
    requiresCli: true,
  },

  async detect(ctx): Promise<TypeDraftDetect> {
    const [steps, slugs, [task], rows] = await Promise.all([
      loadDraftCatalog(ctx.db),
      ctx.db
        .select({ slug: schema.taskTypeDefinitions.slug })
        .from(schema.taskTypeDefinitions)
        .orderBy(asc(schema.taskTypeDefinitions.slug)),
      ctx.db
        .select({ metadata: schema.tasks.metadata })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, ctx.taskId)),
      ctx.db
        .select({ eventType: schema.taskEvents.eventType, payload: schema.taskEvents.payload })
        .from(schema.taskEvents)
        .where(
          and(
            eq(schema.taskEvents.taskId, ctx.taskId),
            inArray(schema.taskEvents.eventType, [
              TYPE_DRAFT_MESSAGE_EVENT,
              TYPE_DRAFT_REPAIR_EVENT,
            ]),
          ),
        )
        .orderBy(asc(schema.taskEvents.createdAt)),
    ]);
    const editing = task?.metadata?.editingSlug;
    return {
      steps,
      personas: collectPersonas(),
      takenSlugs: slugs.map((row) => row.slug).filter((slug) => slug !== editing),
      ...deriveConversation(rows),
    };
  },

  llm: {
    requiredCapabilities: [],
    disableTools: true,
    toolProfile: 'none',
    skipAgentRules: true,
    timeoutMs: 10 * 60 * 1000,
    skipIf: ({ detected }) => {
      const d = detected as TypeDraftDetect;
      return d.pendingQuestion === null && d.repairPending === null;
    },
    buildPrompt: ({ detected }) => buildDraftPrompt(detected as TypeDraftDetect),
    bypassStub: () => ({ reply: 'test bypass: no draft', draft: null }),
    retry: { maxAttempts: 2, retryOn: (err) => err instanceof RetryableParseError },
  },

  form(_ctx, d): FormSchema | null {
    if (d.pendingQuestion !== null || d.repairPending !== null) return null;
    return {
      title: 'Draft a task type',
      description: 'Send your next message, or submit blank to end the conversation.',
      fields: [
        {
          type: 'textarea',
          id: 'message',
          label: 'Next message',
          description: 'Leave empty to finish.',
          required: false,
        },
        {
          type: 'textarea',
          id: 'draft',
          label: 'Editor state',
          description:
            'Sent by the task type editor: the draft as it stands there, as JSON. Leave empty when typing here.',
          required: false,
        },
      ],
    };
  },

  reviseLoop: {
    evaluate: (out) => (out.continueRequested ? { targetStepId: STEP_ID } : null),
  },

  async apply(ctx, args): Promise<TypeDraftApply> {
    const d = args.detected;
    if (d.pendingQuestion === null && d.repairPending === null) {
      const text =
        typeof args.formValues.message === 'string' ? args.formValues.message.trim() : '';
      if (!text) return { pass: 'collect', continueRequested: false, issues: 0, error: null };
      const state = readEditorState(args.formValues.draft);
      const turn: TypeDraftUserTurn = {
        role: 'user',
        body:
          text.length > TYPE_DRAFT_MESSAGE_MAX_CHARS
            ? `${text.slice(0, TYPE_DRAFT_MESSAGE_MAX_CHARS)}\n\n(message cut at ${TYPE_DRAFT_MESSAGE_MAX_CHARS} characters)`
            : text,
        ...(state.draft ? { draft: state.draft } : {}),
        ...(state.ignored ? { draftIgnored: state.ignored } : {}),
      };
      await record(ctx, TYPE_DRAFT_MESSAGE_EVENT, turn);
      return { pass: 'collect', continueRequested: true, issues: 0, error: null };
    }

    const repairing = d.repairPending !== null;
    const pass = repairing ? 'repair' : 'answer';
    const parsed = parseDraftReply(args.llmOutput);
    if (!parsed) {
      if (args.isFinalLlmAttempt === false) {
        throw new RetryableParseError('type draft reply unreadable, retrying');
      }
      const first = d.repairPending;
      await record(ctx, TYPE_DRAFT_MESSAGE_EVENT, {
        role: 'assistant',
        body: first ? first.reply : UNREADABLE_REPLY,
        draft: first ? first.draft : null,
        issues: first ? first.issues : [],
        warnings: first ? first.warnings : [],
        dropped: first ? first.dropped : [],
        ...(first ? {} : { error: 'unreadable-reply' }),
      } satisfies TypeDraftAssistantTurn);
      return {
        pass,
        continueRequested: true,
        issues: first ? first.issues.length : 0,
        error: first ? null : 'unreadable-reply',
      };
    }

    const verdict = judgeDraftReply(parsed, d);
    if (!repairing && verdict.draft !== null && verdict.issues.length > 0) {
      await record(ctx, TYPE_DRAFT_REPAIR_EVENT, verdict);
      return { pass, continueRequested: true, issues: verdict.issues.length, error: null };
    }
    await record(ctx, TYPE_DRAFT_MESSAGE_EVENT, {
      role: 'assistant',
      body: verdict.reply,
      draft: verdict.draft,
      issues: verdict.issues,
      warnings: verdict.warnings,
      dropped: verdict.dropped,
      ...(repairing ? { repaired: true as const } : {}),
    } satisfies TypeDraftAssistantTurn);
    return { pass, continueRequested: true, issues: verdict.issues.length, error: null };
  },
};
