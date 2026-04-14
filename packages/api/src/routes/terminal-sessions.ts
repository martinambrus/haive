import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { getDb } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError, type AppEnv } from '../context.js';

export const terminalSessionRoutes = new Hono<AppEnv>();

terminalSessionRoutes.use('*', requireAuth);

terminalSessionRoutes.get('/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const db = getDb();

  const session = await db.query.terminalSessions.findFirst({
    where: and(eq(schema.terminalSessions.id, id), eq(schema.terminalSessions.userId, userId)),
  });
  if (!session) throw new HttpError(404, 'Terminal session not found');

  return c.json({
    session: {
      id: session.id,
      containerId: session.containerId,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      fullLog: session.fullLog,
      byteCount: session.byteCount,
      truncated: session.truncated,
    },
  });
});

terminalSessionRoutes.get('/by-container/:containerId', async (c) => {
  const userId = c.get('userId');
  const containerId = c.req.param('containerId');
  const db = getDb();

  const rows = await db
    .select({
      id: schema.terminalSessions.id,
      containerId: schema.terminalSessions.containerId,
      startedAt: schema.terminalSessions.startedAt,
      endedAt: schema.terminalSessions.endedAt,
      byteCount: schema.terminalSessions.byteCount,
      truncated: schema.terminalSessions.truncated,
    })
    .from(schema.terminalSessions)
    .where(
      and(
        eq(schema.terminalSessions.userId, userId),
        eq(schema.terminalSessions.containerId, containerId),
      ),
    )
    .orderBy(schema.terminalSessions.startedAt);

  return c.json({ sessions: rows });
});
