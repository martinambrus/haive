import type { FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { probeOllama } from '../onboarding/_rag-embed.js';
import { loadScopeExcludeGlobs } from '../onboarding/_scope.js';
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

interface RagSyncDetect {
  ragConfigured: boolean;
  ragMode: RagMode;
  ragToolingPrefs: RagToolingPrefs | null;
  projectName: string;
  kbFileCount: number;
  codeFileCount: number;
  ollamaReachable: boolean;
}

interface RagSyncApply {
  performed: boolean;
  reason: string;
  inserted: number;
  updated: number;
  skipped: number;
  deleted: number;
}

/* ------------------------------------------------------------------ */

export const preRagSyncStep: StepDefinition<RagSyncDetect, RagSyncApply> = {
  metadata: {
    id: '02-pre-rag-sync',
    workflowType: 'workflow',
    index: 2,
    title: 'Pre-workflow RAG sync',
    description:
      'Incrementally synchronises knowledge base and code files into the RAG vector store. Uses chunk hashing to skip unchanged content. Skipped if no RAG infrastructure is configured.',
    requiresCli: false,
    // Under auto-continue, run the sync on its default (runSync ticked when RAG is
    // configured) instead of parking; manual mode still gates for confirmation.
    autoSubmitDefaults: true,
  },

  async detect(ctx: StepContext): Promise<RagSyncDetect> {
    await ctx.emitProgress('Loading RAG configuration...');
    const resolved = await resolveRagSyncPrefs(ctx);

    let kbFileCount = 0;
    let codeFileCount = 0;
    let ollamaReachable = false;

    if (resolved.ragConfigured && resolved.ragToolingPrefs) {
      await ctx.emitProgress('Counting source files...');
      const scopeExclude = await loadScopeExcludeGlobs(ctx.db, ctx.taskId);
      kbFileCount = (await collectKbFiles(ctx.repoPath)).length;
      codeFileCount = (await collectCodeFiles(ctx.repoPath, scopeExclude)).length;

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
      kbFileCount,
      codeFileCount,
      ollamaReachable,
    };
  },

  form(_ctx, detected): FormSchema {
    if (!detected.ragConfigured) {
      return {
        title: 'Pre-workflow RAG sync',
        description: 'No RAG configuration found from onboarding. RAG sync will be skipped.',
        fields: [{ type: 'checkbox', id: 'runSync', label: 'Run RAG sync', default: false }],
        submitLabel: 'Continue',
      };
    }

    return {
      title: 'Pre-workflow RAG sync',
      description: [
        `RAG mode: ${detected.ragMode}`,
        `KB files: ${detected.kbFileCount}`,
        `Code files: ${detected.codeFileCount}`,
        `Ollama: ${detected.ollamaReachable ? 'reachable' : 'unavailable (hash fallback)'}`,
        'Unchanged chunks will be skipped via content hashing.',
      ].join('\n'),
      fields: [
        {
          type: 'checkbox',
          id: 'runSync',
          label: 'Run incremental RAG sync before starting the workflow',
          default: true,
        },
      ],
      submitLabel: 'Continue',
    };
  },

  async apply(ctx, args): Promise<RagSyncApply> {
    const detected = args.detected as RagSyncDetect;
    const values = args.formValues as { runSync?: boolean };

    if (!values.runSync || !detected.ragConfigured || !detected.ragToolingPrefs) {
      ctx.logger.info('rag sync disabled or not configured');
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
      repoPath: ctx.repoPath,
      prefs: detected.ragToolingPrefs,
      projectName: detected.projectName,
      ollamaReachable: detected.ollamaReachable,
    });
  },
};
