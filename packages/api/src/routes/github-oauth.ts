import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { decrypt, decryptDek, secretsService } from '@haive/shared';
import { VENDOR_CALL_TIMEOUT_MS } from '@haive/shared/integrations';
import { getDb } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError, type AppEnv } from '../context.js';
import { pollDeviceSignIn, startDeviceSignIn } from '../lib/integration-device.js';
import { requireProvider } from '../lib/integration-provider.js';
import { isUuid } from '../lib/uuid.js';

const pollSchema = z.object({
  deviceCode: z.string().min(1).max(512),
});

export const githubOauthRoutes = new Hono<AppEnv>();
githubOauthRoutes.use('*', requireAuth);

const githubSignIn = (userId: string) => ({
  db: getDb(),
  userId,
  spec: requireProvider('github'),
  checkEnabled: false,
});

githubOauthRoutes.post('/device-code', async (c) => {
  const started = await startDeviceSignIn(githubSignIn(c.get('userId')));
  return c.json({
    deviceCode: started.handle,
    userCode: started.userCode,
    verificationUri: started.verificationUri,
    expiresIn: started.expiresIn,
    interval: started.interval,
  });
});

githubOauthRoutes.post('/poll', async (c) => {
  const body = pollSchema.parse(await c.req.json());
  const polled = await pollDeviceSignIn({
    ...githubSignIn(c.get('userId')),
    handle: body.deviceCode,
  });
  if (polled.status === 'pending') {
    return c.json({ status: 'pending', error: 'authorization_pending' });
  }
  return c.json({ status: 'ok', credential: polled.result.credential });
});

interface GithubRepoApi {
  full_name: string;
  clone_url: string;
  default_branch: string;
  private: boolean;
  pushed_at: string | null;
}

const REPOS_PAGE_CAP = 10;
const REPOS_PER_PAGE = 100;

githubOauthRoutes.get('/repos', async (c) => {
  const userId = c.get('userId');
  const credentialId = c.req.query('credentialId');
  if (!credentialId) throw new HttpError(400, 'credentialId is required');
  if (!isUuid(credentialId)) throw new HttpError(400, 'credentialId must be a UUID');

  const db = getDb();
  const cred = await db.query.repoCredentials.findFirst({
    where: and(
      eq(schema.repoCredentials.id, credentialId),
      eq(schema.repoCredentials.userId, userId),
    ),
  });
  if (!cred) throw new HttpError(404, 'Credential not found');
  if (cred.host !== 'github.com') {
    throw new HttpError(400, 'Credential is not a github.com credential');
  }

  const masterKek = await secretsService.getMasterKek();
  const dekHex = decryptDek(cred.encryptedDek, masterKek);
  const token = decrypt(cred.secretEncrypted, dekHex);

  const repos: GithubRepoApi[] = [];
  let truncated = false;
  for (let page = 1; page <= REPOS_PAGE_CAP; page += 1) {
    const url = new URL('https://api.github.com/user/repos');
    url.searchParams.set('per_page', String(REPOS_PER_PAGE));
    url.searchParams.set('page', String(page));
    url.searchParams.set('sort', 'pushed');
    url.searchParams.set('affiliation', 'owner,collaborator,organization_member');
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'haive',
        },
        signal: AbortSignal.timeout(VENDOR_CALL_TIMEOUT_MS),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : 'error';
      throw new HttpError(502, `GitHub /user/repos request failed (${name})`);
    }
    if (res.status === 401) {
      throw new HttpError(401, 'GitHub token rejected. Re-authenticate via "Sign in with GitHub".');
    }
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new HttpError(502, `GitHub /user/repos failed (HTTP ${res.status}): ${errBody}`);
    }
    const batch = (await res.json()) as GithubRepoApi[];
    repos.push(...batch);
    if (batch.length < REPOS_PER_PAGE) break;
    if (page === REPOS_PAGE_CAP) truncated = /rel="next"/.test(res.headers.get('link') ?? '');
  }

  return c.json({
    repos: repos.map((r) => ({
      fullName: r.full_name,
      cloneUrl: r.clone_url,
      defaultBranch: r.default_branch,
      private: r.private,
      pushedAt: r.pushed_at,
    })),
    truncated,
  });
});
