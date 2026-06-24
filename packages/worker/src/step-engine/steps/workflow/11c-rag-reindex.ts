import type { FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';
import { probeOllama } from '../onboarding/_rag-embed.js';
import type { RagMode, RagToolingPrefs } from '../onboarding/_rag-connection.js';
import {
  collectKbFiles,
  collectCodeFiles,
  resolveRagSyncPrefs,
  runRagIndexSync,
} from './_rag-index.js';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

interface RagReindexDetect {
  ragConfigured: boolean;
  ragMode: RagMode;
  ragToolingPrefs: RagToolingPrefs | null;
  projectName: string;
  worktreePath: string;
  kbFileCount: number;
  codeFileCount: number;
  ollamaReachable: boolean;
}

interface RagReindexApply {
  performed: boolean;
  reason: string;
  inserted: number;
  updated: number;
  skipped: number;
  deleted: number;
}

/** Resolve the worktree the learning phase wrote into (mirrors 11-phase-8-learning
 *  / 11b-kb-commit): the worktree path from 01-worktree-setup, falling back to the
 *  repo workspace when there is no worktree row. */
async function resolveWorkspace(ctx: StepContext): Promise<string> {
  const prev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-worktree-setup');
  const out = prev?.output as { worktreePath?: string } | null;
  return out?.worktreePath ?? ctx.workspacePath;
}

/* ------------------------------------------------------------------ */

export const ragReindexStep: StepDefinition<RagReindexDetect, RagReindexApply> = {
  metadata: {
    id: '11c-rag-reindex',
    workflowType: 'workflow',
    // After 11b-kb-commit (11.5), before 11a-gate-4-push (12) and worktree cleanup
    // (14): the worktree still exists and now carries the committed KB / learnings
    // / investigations plus this task's implemented code, so the re-index makes
    // them searchable THIS run and propagates any KB deletions to RAG.
    index: 11.7,
    title: 'Re-index knowledge base into RAG',
    description:
      'Incrementally re-indexes the worktree (updated knowledge base, learnings, bug investigations, and implemented code) into the RAG vector store so this run’s knowledge is immediately searchable and removals are deleted. Skipped if no RAG infrastructure is configured.',
    requiresCli: false,
    // Nothing to sync / RAG off is a clean no-op; let it be skippable.
    allowSkip: true,
  },

  async detect(ctx: StepContext): Promise<RagReindexDetect> {
    await ctx.emitProgress('Loading RAG configuration...');
    const resolved = await resolveRagSyncPrefs(ctx);
    const worktreePath = await resolveWorkspace(ctx);

    let kbFileCount = 0;
    let codeFileCount = 0;
    let ollamaReachable = false;

    if (resolved.ragConfigured && resolved.ragToolingPrefs) {
      await ctx.emitProgress('Counting source files...');
      kbFileCount = (await collectKbFiles(worktreePath)).length;
      codeFileCount = (await collectCodeFiles(worktreePath)).length;

      if (resolved.ragToolingPrefs.ollamaUrl) {
        await ctx.emitProgress('Testing Ollama connectivity...');
        ollamaReachable = await probeOllama(resolved.ragToolingPrefs.ollamaUrl);
      }
    }

    return {
      ragConfigured: resolved.ragConfigured,
      ragMode: resolved.ragMode,
      ragToolingPrefs: resolved.ragToolingPrefs,
      projectName: resolved.projectName,
      worktreePath,
      kbFileCount,
      codeFileCount,
      ollamaReachable,
    };
  },

  form(_ctx, detected): FormSchema {
    if (!detected.ragConfigured) {
      return {
        title: 'Re-index knowledge base into RAG',
        description: 'No RAG configuration found from onboarding. Re-index will be skipped.',
        fields: [{ type: 'checkbox', id: 'runReindex', label: 'Run RAG re-index', default: false }],
        submitLabel: 'Continue',
      };
    }

    return {
      title: 'Re-index knowledge base into RAG',
      description: [
        `RAG mode: ${detected.ragMode}`,
        `KB files: ${detected.kbFileCount}`,
        `Code files: ${detected.codeFileCount}`,
        `Ollama: ${detected.ollamaReachable ? 'reachable' : 'unavailable (hash fallback)'}`,
        'Re-indexes the committed knowledge base, learnings, and implemented code. Unchanged chunks are skipped via content hashing; removed KB sections are deleted from RAG.',
      ].join('\n'),
      fields: [
        {
          type: 'checkbox',
          id: 'runReindex',
          label: 'Re-index the updated knowledge base + code into RAG',
          default: true,
        },
      ],
      submitLabel: 'Continue',
    };
  },

  async apply(ctx, args): Promise<RagReindexApply> {
    const detected = args.detected as RagReindexDetect;
    const values = args.formValues as { runReindex?: boolean };

    if (!values.runReindex || !detected.ragConfigured || !detected.ragToolingPrefs) {
      ctx.logger.info('rag re-index disabled or not configured');
      return {
        performed: false,
        reason: 'disabled by user or not configured',
        inserted: 0,
        updated: 0,
        skipped: 0,
        deleted: 0,
      };
    }

    return runRagIndexSync(ctx, {
      repoPath: detected.worktreePath,
      prefs: detected.ragToolingPrefs,
      projectName: detected.projectName,
      ollamaReachable: detected.ollamaReachable,
    });
  },
};
