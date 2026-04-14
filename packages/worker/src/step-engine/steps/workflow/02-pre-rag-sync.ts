import path from 'node:path';
import type { FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { pathExists } from '../onboarding/_helpers.js';

interface RagSyncDetect {
  ragConfigured: boolean;
  ragScriptPath: string | null;
  kbFileCount: number;
}

interface RagSyncApply {
  performed: boolean;
  reason: string;
}

async function countKbFiles(repo: string): Promise<number> {
  const kb = path.join(repo, '.claude', 'knowledge_base');
  if (!(await pathExists(kb))) return 0;
  try {
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(kb, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && e.name.endsWith('.md')).length;
  } catch {
    return 0;
  }
}

export const preRagSyncStep: StepDefinition<RagSyncDetect, RagSyncApply> = {
  metadata: {
    id: '02-pre-rag-sync',
    workflowType: 'workflow',
    index: 2,
    title: 'Pre-workflow RAG sync',
    description:
      'Ensures the knowledge base is synchronised into the RAG vector store before the implementation phase starts. Skipped if no RAG infrastructure is configured.',
    requiresCli: false,
  },

  async detect(ctx: StepContext): Promise<RagSyncDetect> {
    const ragDir = path.join(ctx.repoPath, '.claude', 'rag');
    const ragConfigured = await pathExists(ragDir);
    let ragScriptPath: string | null = null;
    if (ragConfigured) {
      const candidates = ['populate.py', 'sync.py', 'embed.py'];
      for (const c of candidates) {
        const p = path.join(ragDir, c);
        if (await pathExists(p)) {
          ragScriptPath = p;
          break;
        }
      }
    }
    const kbFileCount = await countKbFiles(ctx.repoPath);
    return { ragConfigured, ragScriptPath, kbFileCount };
  },

  form(_ctx, detected): FormSchema {
    const summary = detected.ragConfigured
      ? `RAG directory detected. Knowledge base has ${detected.kbFileCount} file(s). Script: ${detected.ragScriptPath ?? 'not found'}.`
      : 'No .claude/rag directory found; RAG sync will be skipped for this task.';
    return {
      title: 'Pre-workflow RAG sync',
      description: summary,
      fields: [
        {
          type: 'checkbox',
          id: 'runSync',
          label: 'Run RAG sync before starting the workflow',
          default: detected.ragConfigured && detected.ragScriptPath !== null,
        },
      ],
      submitLabel: 'Continue',
    };
  },

  async apply(ctx, args): Promise<RagSyncApply> {
    const values = args.formValues as { runSync?: boolean };
    if (!values.runSync) {
      ctx.logger.info('rag sync disabled by user');
      return { performed: false, reason: 'disabled by user' };
    }
    if (!args.detected.ragConfigured || !args.detected.ragScriptPath) {
      ctx.logger.warn('rag sync requested but no script available');
      return { performed: false, reason: 'no rag script available' };
    }
    ctx.logger.info(
      { scriptPath: args.detected.ragScriptPath },
      'rag sync would run (deferred to dedicated worker)',
    );
    return { performed: false, reason: 'deferred to dedicated rag worker' };
  },
};
