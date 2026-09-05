import { z } from 'zod';
import { Hono } from 'hono';
import { userSecretsService } from '@haive/shared';
import { requireAuth } from '../middleware/auth.js';
import { resolveGithubClientId } from './github-oauth.js';
import type { AppEnv } from '../context.js';

const GITHUB_CLIENT_ID_KEY = 'github_client_id';

const putGithubSchema = z.object({
  clientId: z.string().max(256),
});

export const integrationsRoutes = new Hono<AppEnv>();

integrationsRoutes.use('*', requireAuth);

integrationsRoutes.get('/github', async (c) => {
  const userId = c.get('userId');
  // Through the same resolver the device flow uses, env var included. Asking only
  // the user secret made this answer `false` on an install configured by
  // GITHUB_OAUTH_CLIENT_ID, so the UI hid a sign-in button that would have worked.
  const clientId = await resolveGithubClientId(userId);
  return c.json({ configured: clientId !== null });
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
