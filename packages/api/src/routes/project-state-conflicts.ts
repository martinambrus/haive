import { Hono } from 'hono';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@haive/database';
import { logger } from '@haive/shared';
import {
  PROJECT_STATE_ANSWERS,
  conflictBody,
  isConflictUnit,
  parsePlanConflictUnit,
  type ProjectStateConflictBody,
  type ProjectStateResolveResult,
} from '@haive/shared/project-state';
import { getDb } from '../db.js';
import { HttpError, type AppEnv } from '../context.js';
import { requireAuth } from '../middleware/auth.js';
import { resolveProjectStateConflict } from '../lib/project-state-resolve.js';
import { isUuid } from '../lib/uuid.js';

const answerSchema = z.strictObject({ answer: z.enum(PROJECT_STATE_ANSWERS) });

export const projectStateConflictRoutes = new Hono<AppEnv>();

async function requireOwnedRepository(userId: string, repositoryId: string): Promise<void> {
  if (!isUuid(repositoryId)) throw new HttpError(404, 'Repository not found');
  const repo = await getDb().query.repositories.findFirst({
    where: and(eq(schema.repositories.id, repositoryId), eq(schema.repositories.userId, userId)),
    columns: { id: true },
  });
  if (!repo) throw new HttpError(404, 'Repository not found');
}

/** A plan question carries its node's current title, null once the node is gone. */
async function withNodeTitles(
  repositoryId: string,
  rows: (typeof schema.projectStateConflicts.$inferSelect)[],
): Promise<ProjectStateConflictBody[]> {
  const nodeIds = [
    ...new Set(rows.flatMap((row) => parsePlanConflictUnit(row.unit)?.nodeId ?? [])),
  ];
  const titles = new Map<string, string>();
  if (nodeIds.length > 0) {
    const nodes = await getDb()
      .select({ id: schema.planNodes.id, title: schema.planNodes.title })
      .from(schema.planNodes)
      .where(
        and(eq(schema.planNodes.repositoryId, repositoryId), inArray(schema.planNodes.id, nodeIds)),
      );
    for (const node of nodes) titles.set(node.id, node.title);
  }
  return rows.map((row) => {
    const plan = parsePlanConflictUnit(row.unit);
    return plan
      ? { ...conflictBody(row), nodeTitle: titles.get(plan.nodeId) ?? null }
      : conflictBody(row);
  });
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
    conflicts: await withNodeTitles(
      repositoryId,
      rows.filter((row) => isConflictUnit(row.unit)),
    ),
  });
});

projectStateConflictRoutes.get(
  '/:id/project-state/conflicts/:conflictId',
  requireAuth,
  async (c) => {
    const repositoryId = c.req.param('id');
    const conflictId = c.req.param('conflictId');
    await requireOwnedRepository(c.get('userId'), repositoryId);
    if (!isUuid(conflictId)) throw new HttpError(404, 'Question not found');
    const row = await getDb().query.projectStateConflicts.findFirst({
      where: and(
        eq(schema.projectStateConflicts.id, conflictId),
        eq(schema.projectStateConflicts.repositoryId, repositoryId),
      ),
    });
    if (!row || !isConflictUnit(row.unit)) throw new HttpError(404, 'Question not found');
    const [conflict] = await withNodeTitles(repositoryId, [row]);
    return c.json({ conflict });
  },
);

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
        'This repository is busy with onboarding, an upgrade, or project settings recovery. Try again once it is ready.',
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
    if (!isUuid(conflictId)) throw new HttpError(404, 'Question not found');
    const { answer } = answerSchema.parse(await c.req.json().catch(() => ({})));
    let result: ProjectStateResolveResult | { kind: 'pending' };
    try {
      result = await resolveProjectStateConflict({ repositoryId, userId, conflictId, answer });
    } catch (err) {
      logger.warn({ err, repositoryId, conflictId }, 'project state conflict answer failed');
      throw new HttpError(
        502,
        'Could not confirm the answer was applied. Reload to see where it stands, then answer again if it is still asked.',
        'project_state_conflict_failed',
      );
    }
    if (result.kind === 'pending') {
      return c.json(
        {
          pending: true,
          message: 'The answer is still being applied. Reload in a moment to see it.',
        },
        202,
      );
    }
    if (result.kind !== 'resolved') throw refusal(result);
    return c.json({ conflict: result.conflict, written: result.written });
  },
);
