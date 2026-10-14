import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { getCliProviderMetadata, logger, type CliProviderName } from '@haive/shared';
import { isPersonaId, parsePromptTemplate, type PromptStepEntry } from '@haive/shared/modularity';
import {
  MAX_PERSONA_BODY_BYTES,
  readTemplatePersonas,
  resolvePersonaMaskPolicy,
} from './agent-isolation.js';

/** Recorded when a task starts and one of its prompt steps names a persona the repository tree
 *  cannot give it. A warning only: the dispatch reader is authoritative and fails the step. */
export const AGENT_PERSONA_UNRESOLVED_EVENT = 'agent_persona.unresolved';

export interface UnresolvedPersona {
  personaId: string;
  stepIds: string[];
  reason: string;
}

function personaIdsByStep(
  customSteps: Record<string, PromptStepEntry> | undefined,
): Map<string, string[]> {
  const byStep = new Map<string, string[]>();
  for (const [stepId, entry] of Object.entries(customSteps ?? {})) {
    const parsed = parsePromptTemplate(entry.template);
    if (!parsed.ok) continue;
    const ids = new Set<string>();
    for (const token of parsed.tokens) {
      if (token.kind === 'agent' && isPersonaId(token.id)) ids.add(token.id);
    }
    if (ids.size > 0) byStep.set(stepId, [...ids]);
  }
  return byStep;
}

/**
 * The early warning for prompt-step personas: reads each persona of the task's pinned steps from
 * the repository clone with the dispatch reader and records one event per id it cannot read.
 *
 * Never throws and never changes task or step state. The tree a step reads from is created after
 * the start, so a persona may exist only on the base: this is a hint, and a lookup that errors
 * records nothing rather than a false "unresolved". A start that runs again records again.
 */
export async function checkPinnedStepPersonas(args: {
  db: Database;
  taskId: string;
  repoPath: string;
  customSteps: Record<string, PromptStepEntry> | undefined;
  /** The name of the CLI the step dispatches to, resolved as dispatch resolves it. */
  providerNameFor: (stepId: string) => Promise<CliProviderName | null>;
  record: (unresolved: UnresolvedPersona) => Promise<void>;
}): Promise<void> {
  const byStep = personaIdsByStep(args.customSteps);
  if (byStep.size === 0) return;

  const unresolved = new Map<string, UnresolvedPersona>();
  try {
    const task = await args.db.query.tasks.findFirst({
      where: eq(schema.tasks.id, args.taskId),
      columns: { repositoryId: true },
    });
    if (!task?.repositoryId) return;

    const mask = await resolvePersonaMaskPolicy(args.db, args.taskId, args.repoPath);
    if (mask === null) return;

    for (const [stepId, ids] of byStep) {
      const providerName = await args.providerNameFor(stepId);
      const metadata = providerName ? getCliProviderMetadata(providerName) : null;
      const providerAgentsDir =
        metadata?.agentFileFormat === 'markdown' ? metadata.projectAgentsDir : null;
      let remaining = MAX_PERSONA_BODY_BYTES;
      for (const id of ids) {
        const result = await readTemplatePersonas({
          workerTree: args.repoPath,
          providerAgentsDir,
          ids: [id],
          policy: mask.policy,
          loadTracked: mask.loadTracked,
          budget: remaining,
        });
        if (result.ok) {
          remaining -= result.used;
          continue;
        }
        const known = unresolved.get(id);
        if (known) known.stepIds.push(stepId);
        else unresolved.set(id, { personaId: id, stepIds: [stepId], reason: result.failure });
      }
    }
  } catch (err) {
    logger.warn({ err, taskId: args.taskId }, 'start-time persona check could not run');
    return;
  }

  for (const entry of unresolved.values()) {
    try {
      await args.record(entry);
    } catch (err) {
      logger.warn({ err, taskId: args.taskId }, 'could not record an unresolved persona event');
    }
  }
}
