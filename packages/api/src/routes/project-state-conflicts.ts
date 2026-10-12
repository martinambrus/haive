import { Hono } from 'hono';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@haive/database';
import { logger } from '@haive/shared';
import {
  PROJECT_STATE_ANSWERS,
  conflictBody,
  isRenderUnit,
  type ProjectStateResolveResult,
} from '@haive/shared/project-state';
import { getDb } from '../db.js';
import { HttpError, type AppEnv } from '../context.js';
import { requireAuth } from '../middleware/auth.js';
import { resolveProjectStateConflict } from '../lib/project-state-resolve.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const answerSchema = z.strictObject({ answer: z.enum(PROJECT_STATE_ANSWERS) });

export const projectStateConflictRoutes = new Hono<AppEnv>();

async function requireOwnedRepository(userId: string, repositoryId: string): Promise<void> {
  if (!UUID_RE.test(repositoryId)) throw new HttpError(404, 'Repository not found');
  const repo = await getDb().query.repositories.findFirst({
    where: and(eq(schema.repositories.id, repositoryId), eq(schema.repositories.userId, userId)),
    columns: { id: true },
  });
  if (!repo) throw new HttpError(404, 'Repository not found');
}

projectStateConflictRoutes.get('/:id/project-state/conflicts', requireAuth, async (c) => {
  const repositoryId = c.req.param('id');
  await requireOwnedRepository(c.get('userId'), repositoryId);
  const rows = await getDb()
    .select()
    .from(schema.projectStateConflicts)
    .where(
      and(
        eq(schema.projectStateConflicts.repositoryId, repositoryId),
        isNull(schema.projectStateConflicts.resolvedAt),
      ),
    )
    .orderBy(asc(schema.projectStateConflicts.detectedAt), asc(schema.projectStateConflicts.unit));
  return c.json({
    conflicts: rows.filter((row) => isRenderUnit(row.unit)).map((row) => conflictBody(row)),
  });
});

function refusal(result: Exclude<ProjectStateResolveResult, { kind: 'resolved' }>): HttpError {
  switch (result.kind) {
    case 'not_found':
      return new HttpError(404, 'Question not found');
    case 'settled':
      return new HttpError(
        409,
        result.resolution === 'converged'
          ? 'The two copies of this setting now match, so there is nothing left to answer.'
          : 'This question was already answered the other way.',
        'project_state_conflict_settled',
      );
    case 'busy':
      return new HttpError(
        409,
        'An onboarding or an upgrade is using this repository. Answer once it has finished.',
        'project_state_conflict_busy',
      );
    case 'moved':
      return new HttpError(
        409,
        "The checkout's record moved while you were answering. Reload the question and answer it again.",
        'project_state_conflict_moved',
      );
    case 'no_local':
      return new HttpError(
        409,
        'This install has no value of its own to keep. Take the other one instead.',
        'project_state_conflict_no_local',
      );
    case 'invalid':
      return new HttpError(
        409,
        'That answer would leave settings the project cannot use, so nothing was changed.',
        'project_state_conflict_invalid',
      );
  }
}

projectStateConflictRoutes.post(
  '/:id/project-state/conflicts/:conflictId',
  requireAuth,
  async (c) => {
    const userId = c.get('userId');
    const repositoryId = c.req.param('id');
    const conflictId = c.req.param('conflictId');
    await requireOwnedRepository(userId, repositoryId);
    if (!UUID_RE.test(conflictId)) throw new HttpError(404, 'Question not found');
    const { answer } = answerSchema.parse(await c.req.json().catch(() => ({})));
    let result: ProjectStateResolveResult;
    try {
      result = await resolveProjectStateConflict({ repositoryId, userId, conflictId, answer });
    } catch (err) {
      logger.warn({ err, repositoryId, conflictId }, 'project state conflict answer failed');
      throw new HttpError(
        502,
        'Could not apply the answer. Nothing was changed; try again in a moment.',
        'project_state_conflict_failed',
      );
    }
    if (result.kind !== 'resolved') throw refusal(result);
    return c.json({ conflict: result.conflict, written: result.written });
  },
);
