import { z } from 'zod';
import { Hono } from 'hono';
import { userSecretsService } from '@haive/shared';
import { requireAuth } from '../middleware/auth.js';
import type { AppEnv } from '../context.js';

const GITHUB_CLIENT_ID_KEY = 'github_client_id';

const putGithubSchema = z.object({
  clientId: z.string().max(256),
});

export const integrationsRoutes = new Hono<AppEnv>();

integrationsRoutes.use('*', requireAuth);

integrationsRoutes.get('/github', async (c) => {
  const userId = c.get('userId');
  const value = await userSecretsService.get(userId, GITHUB_CLIENT_ID_KEY);
  return c.json({ configured: value !== null && value.length > 0 });
});

integrationsRoutes.put('/github', async (c) => {
  const userId = c.get('userId');
  const body = putGithubSchema.parse(await c.req.json());
  if (body.clientId.trim().length === 0) {
    await userSecretsService.delete(userId, GITHUB_CLIENT_ID_KEY);
  } else {
    await userSecretsService.set(
      userId,
      GITHUB_CLIENT_ID_KEY,
      body.clientId.trim(),
      'GitHub OAuth Client ID',
    );
  }
  return c.json({ ok: true });
});
