import type { FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';

interface ImplementDetect {
  specSummary: string;
  spec: string;
  sandboxWorkspacePath: string;
  gateFeedback: string;
}

interface ImplementApply {
  summary: string;
  filesTouched: string[];
  notes: string;
  source: 'llm' | 'stub';
}

interface PrePlanningOutput {
  summary?: string;
  spec?: string;
}

interface Gate1Output {
  decision?: string;
  feedback?: string;
}

export function parseImplementOutput(raw: unknown): {
  summary: string;
  filesTouched: string[];
  notes: string;
} | null {
  if (!raw) return null;
  let text: string;
  if (typeof raw === 'string') {
    text = raw;
  } else if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.summary === 'string') {
      return normalise(
        obj.summary,
        obj.filesTouched,
        typeof obj.notes === 'string' ? obj.notes : '',
      );
    }
    return null;
  } else {
    return null;
  }
  const fenceMatch = /```json\s*([\s\S]*?)```/.exec(text);
  const body = fenceMatch?.[1];
  if (!body) return null;
  try {
    const parsed = JSON.parse(body);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).summary === 'string'
    ) {
      const obj = parsed as Record<string, unknown>;
      return normalise(
        obj.summary as string,
        obj.filesTouched,
        typeof obj.notes === 'string' ? (obj.notes as string) : '',
      );
    }
  } catch {
    return null;
  }
  return null;
}

function normalise(
  summary: string,
  filesTouchedRaw: unknown,
  notes: string,
): { summary: string; filesTouched: string[]; notes: string } {
  const filesTouched = Array.isArray(filesTouchedRaw)
    ? (filesTouchedRaw as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];
  return { summary, filesTouched, notes };
}

function stubImplement(detect: ImplementDetect): {
  summary: string;
  filesTouched: string[];
  notes: string;
} {
  return {
    summary:
      'Implementation phase was skipped — no CLI provider produced a change set. The spec remains the authoritative source of intent.',
    filesTouched: [],
    notes: detect.gateFeedback
      ? `Gate 1 feedback carried forward: ${detect.gateFeedback}`
      : 'No additional notes recorded.',
  };
}

export const phase2ImplementStep: StepDefinition<ImplementDetect, ImplementApply> = {
  metadata: {
    id: '07-phase-2-implement',
    workflowType: 'workflow',
    index: 7,
    title: 'Phase 2: Implement',
    description:
      'Delegates the spec to the active CLI provider for implementation inside the workspace and records a summary of what was changed.',
    requiresCli: false,
  },

  async detect(ctx: StepContext): Promise<ImplementDetect> {
    const plan = await loadPreviousStepOutput(ctx.db, ctx.taskId, '04-phase-0b-pre-planning');
    const gate = await loadPreviousStepOutput(ctx.db, ctx.taskId, '06-gate-1-spec-approval');
    const worktree = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-worktree-setup');
    const planOutput = (plan?.output as PrePlanningOutput | null) ?? {};
    const gateOutput = (gate?.output as Gate1Output | null) ?? {};
    const worktreeOutput = (worktree?.output as { sandboxWorktreePath?: string } | null) ?? {};
    if (!worktreeOutput.sandboxWorktreePath) {
      throw new Error(
        '07-phase-2-implement requires 01-worktree-setup to have produced sandboxWorktreePath',
      );
    }
    return {
      specSummary: planOutput.summary ?? '',
      spec: planOutput.spec ?? '',
      sandboxWorkspacePath: worktreeOutput.sandboxWorktreePath,
      gateFeedback: gateOutput.feedback ?? '',
    };
  },

  form(_ctx, detected): FormSchema {
    return {
      title: 'Phase 2: Implement',
      description: [
        `Workspace (inside sandbox): ${detected.sandboxWorkspacePath}`,
        `Spec length: ${detected.spec.length} chars`,
        detected.gateFeedback
          ? `Gate 1 feedback: ${detected.gateFeedback}`
          : 'No gate 1 feedback recorded.',
      ].join('\n'),
      fields: [
        {
          type: 'textarea',
          id: 'instructions',
          label: 'Additional implementation instructions (optional)',
          rows: 4,
          placeholder: 'Hard constraints, required files to touch, style overrides for this run.',
        },
      ],
      submitLabel: 'Implement',
    };
  },

  llm: {
    requiredCapabilities: ['tool_use', 'file_write'],
    timeoutMs: 60 * 60 * 1000,
    buildPrompt: (args) => {
      const detected = args.detected as ImplementDetect;
      const values = args.formValues as { instructions?: string };
      return [
        'You are the implementation phase of an engineering workflow.',
        'Apply the specification below to the workspace. You may read and write files freely inside the workspace.',
        'Prefer minimal, reviewable diffs. Follow existing conventions. Do not invent requirements.',
        'When finished emit ONE JSON object inside a ```json fenced code block with the shape:',
        '{ "summary": "<what changed and why>", "filesTouched": ["path/one", "path/two"], "notes": "<follow-ups or caveats>" }',
        '',
        `Workspace path: ${detected.sandboxWorkspacePath}`,
        `Your current working directory is already set to the workspace path above.`,
        `Gate 1 feedback: ${detected.gateFeedback || '(none)'}`,
        `Extra instructions: ${values.instructions ?? '(none)'}`,
        '',
        '=== Spec ===',
        detected.spec || '(empty spec — default to minimal safe change)',
      ].join('\n');
    },
  },

  async apply(ctx, args): Promise<ImplementApply> {
    const parsed = parseImplementOutput(args.llmOutput ?? null);
    if (parsed) {
      ctx.logger.info(
        { filesTouched: parsed.filesTouched.length, source: 'llm' },
        'implementation summary parsed',
      );
      return {
        summary: parsed.summary,
        filesTouched: parsed.filesTouched,
        notes: parsed.notes,
        source: 'llm',
      };
    }
    const stub = stubImplement(args.detected);
    ctx.logger.info({ source: 'stub' }, 'implementation stubbed');
    return {
      summary: stub.summary,
      filesTouched: stub.filesTouched,
      notes: stub.notes,
      source: 'stub',
    };
  },
};
