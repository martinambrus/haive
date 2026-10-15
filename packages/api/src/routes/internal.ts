import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { decrypt, decryptDek, secretsService, verifyRepoGitCredToken, logger } from '@haive/shared';
import { getDb } from '../db.js';
import { HttpError, type AppEnv } from '../context.js';

const log = logger.child({ module: 'internal-git-credential' });

export const internalRoutes = new Hono<AppEnv>();

/** Token-authenticated callback for the interactive repo terminal's git
 *  credential helper. The container holds only a short-lived, repo-scoped
 *  signed token (no DB creds); it presents the token here and gets the repo's
 *  bound push credential for a single push, so the decrypted secret never lands
 *  in the container filesystem. Deliberately NOT behind requireAuth — the
 *  container has no user session, only the token (mirrors /rag/search). */
internalRoutes.post('/git-credential', async (c) => {
  const secret = process.env.CONFIG_ENCRYPTION_KEY;
  if (!secret) throw new HttpError(500, 'server misconfigured: CONFIG_ENCRYPTION_KEY unset');

  const authHeader = c.req.header('Authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const verified = token ? verifyRepoGitCredToken(token, secret) : null;
  if (!verified) throw new HttpError(401, 'invalid or missing git credential token');
  const { repositoryId, userId } = verified;

  const db = getDb();
  const repo = await db.query.repositories.findFirst({
    where: eq(schema.repositories.id, repositoryId),
    columns: { userId: true, credentialsSecretId: true },
  });
  if (!repo || repo.userId !== userId) throw new HttpError(404, 'repository not found');
  // No stored credential -> 204 so the helper emits nothing and git falls
  // through to its other helpers / manual auth.
  if (!repo.credentialsSecretId) return c.body(null, 204);

  const credRow = await db.query.repoCredentials.findFirst({
    where: eq(schema.repoCredentials.id, repo.credentialsSecretId),
    columns: { userId: true, usernameEncrypted: true, secretEncrypted: true, encryptedDek: true },
  });
  if (!credRow || credRow.userId !== userId) return c.body(null, 204);

  try {
    const masterKek = await secretsService.getMasterKek();
    const dekHex = decryptDek(credRow.encryptedDek, masterKek);
    const username = decrypt(credRow.usernameEncrypted, dekHex);
    const password = decrypt(credRow.secretEncrypted, dekHex);
    return c.json({ username, password });
  } catch (err) {
    log.error({ err, repositoryId }, 'failed to decrypt repo credential for git helper');
    throw new HttpError(500, 'failed to resolve credential');
  }
});
