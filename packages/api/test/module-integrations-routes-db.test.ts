import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';

const url = process.env.MODULE_INTEGRATIONS_ROUTES_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/module_integrations_routes_test'))
  throw new Error(
    'Use a dedicated module_integrations_routes_test database for the module integration route tests',
  );

const h = vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'error';
  return { db: undefined as unknown };
});

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: {
    get: async () => null,
    getBoolean: async (_key: string, fallback: boolean) => fallback,
  },
}));

import { secretsService } from '@haive/shared';
import { getIntegrationProvider, listIntegrationCategories } from '@haive/shared/integrations';
import { CORE_INTEGRATION_CATEGORY_SPECS } from '@haive/shared/modularity';
import { ACCESS_COOKIE } from '../src/auth/cookies.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { createApiApp } from '../src/index.js';
import { mountModules } from '../src/modules/loader.js';

const registry = (await import('@haive/shared/integrations')) as {
  registerModuleIntegrations?: (modules: readonly unknown[]) => void;
};

const WEB_ORIGIN = 'http://localhost:3000';
const KEK = randomBytes(32).toString('hex');
const PROVIDERS_BASELINE =
  process.env.PROVIDERS_BASELINE_FILE ??
  fileURLToPath(
    new URL('./fixtures/module-integrations/get-integrations-providers.json', import.meta.url),
  );
const CORE_PROVIDER_IDS = ['github', 'gitea', 'gitlab', 'bitbucket_cloud', 'bitbucket_server'];
const CORE_CATEGORY_IDS = CORE_INTEGRATION_CATEGORY_SPECS.map((spec) => spec.id) as string[];

type Raw = Record<string, any>;
interface Reply {
  method: string;
  path: string;
  status: number;
  json: any;
  text: string;
}
interface Actor {
  id: string;
  cookie: string;
}

const OAUTH = {
  kind: 'oauth2',
  authorizeUrl: 'https://login.fx.example/oauth/authorize',
  tokenUrl: 'https://login.fx.example/oauth/token',
  scopes: { read: ['docs.read'], write: ['docs.write'] },
  pkce: true,
  clientRegistration: ['preregistered'],
  userInfo: { url: 'https://api.fx.example/userinfo', idPointer: '/sub', labelPointer: '/email' },
};

const providerOf = (moduleId: string, over: Raw = {}): Raw => ({
  id: `module.${moduleId}.crm`,
  displayName: `Provider of ${moduleId}`,
  categories: [`module.${moduleId}.docs`, 'rich-documents'],
  selfHosted: false,
  auth: [OAUTH],
  operations: [
    {
      opId: 'docs_list',
      description: 'List documents',
      inputSchema: { type: 'object', properties: {} },
      access: 'read',
    },
  ],
  apiHosts: [`api.${moduleId}.example`],
  ...over,
});

const manifestOf = (moduleId: string, over: Raw = {}): Raw => ({
  id: moduleId,
  name: `Module ${moduleId}`,
  version: '1.0.0',
  schemaVersion: 1,
  categories: [
    {
      id: `module.${moduleId}.docs`,
      label: `Documents of ${moduleId}`,
      description: `What ${moduleId} files`,
    },
  ],
  integrations: [providerOf(moduleId)],
  ...over,
});

const entryOf = (moduleId: string, over: Raw = {}) => ({
  packageName: `@haive/module-${moduleId}`,
  manifest: manifestOf(moduleId, over),
});

const note = (reply: Reply) =>
  `${reply.method} ${reply.path} -> ${reply.status} ${reply.text.slice(0, 240)}`;
const expectOk = (reply: Reply) =>
  expect(reply.status >= 200 && reply.status < 300, note(reply)).toBe(true);
const expectStatus = (reply: Reply, status: number) =>
  expect(reply.status, note(reply)).toBe(status);

// A list route may answer a bare array or one array under a single key; the entries are what is pinned.
function entriesOf(reply: Reply): Raw[] {
  const body = reply.json;
  if (Array.isArray(body)) return body;
  const lists =
    body !== null && typeof body === 'object' ? Object.values(body).filter(Array.isArray) : [];
  if (lists.length === 1) return lists[0] as Raw[];
  throw new Error(`not a list: ${note(reply)}`);
}

describe.skipIf(!url)(
  'module integration providers and categories over the api, on Postgres',
  () => {
    const app = createApiApp(WEB_ORIGIN);
    let db: Database;
    let admin: Actor;
    let user: Actor;
    const userIds: string[] = [];

    async function send(actor: Actor | null, method: string, path: string, body?: unknown) {
      const res = await app.request(path, {
        method,
        headers: {
          host: 'localhost:3001',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(actor === null ? {} : { cookie: actor.cookie }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { method, path, status: res.status, json, text } satisfies Reply;
    }

    const as = (actor: Actor | null) => ({
      get: (path: string) => send(actor, 'GET', path),
      put: (path: string, body?: unknown) => send(actor, 'PUT', path, body),
      post: (path: string, body?: unknown) => send(actor, 'POST', path, body),
    });

    const mount = (...moduleIds: string[]) =>
      mountModules(
        app,
        moduleIds.map((id) => entryOf(id)),
        { db },
      );
    const setConfig = (providerId: string, enabled: boolean) =>
      db
        .insert(schema.integrationProviderConfigs)
        .values({ providerId, enabled })
        .onConflictDoUpdate({
          target: schema.integrationProviderConfigs.providerId,
          set: { enabled },
        });
    const setModule = (moduleId: string, deactivated: boolean) =>
      db
        .insert(schema.modules)
        .values({
          moduleId,
          packageName: `@haive/module-${moduleId}`,
          name: `Module ${moduleId}`,
          installedVersion: '1.0.0',
          deactivatedAt: deactivated ? new Date() : null,
        })
        .onConflictDoUpdate({
          target: schema.modules.moduleId,
          set: { deactivatedAt: deactivated ? new Date() : null },
        });

    async function createUser(role: 'admin' | 'user'): Promise<Actor> {
      const [row] = await db
        .insert(schema.users)
        .values({
          emailEncrypted: 'module-integrations-routes-test@test.local',
          emailBlindIndex: randomBytes(16).toString('hex'),
          passwordHash: 'not-a-real-hash',
          role,
        })
        .returning({ id: schema.users.id });
      userIds.push(row!.id);
      const token = await signAccessToken({ sub: row!.id, role, tv: 0 });
      return { id: row!.id, cookie: `${ACCESS_COOKIE}=${token}` };
    }

    async function createTask(userId: string): Promise<string> {
      const [task] = await db
        .insert(schema.tasks)
        .values({
          userId,
          repositoryId: null,
          type: 'workflow',
          title: 'module integrations routes test',
          status: 'running',
        })
        .returning({ id: schema.tasks.id });
      return task!.id;
    }

    async function clean() {
      if (userIds.length > 0)
        await db.delete(schema.users).where(inArray(schema.users.id, userIds));
      userIds.length = 0;
      await db.delete(schema.integrationCategoryPreferences);
      await db.delete(schema.integrationProviderConfigs);
      await db.delete(schema.modules).where(inArray(schema.modules.moduleId, ['fx', 'gx']));
      await db.delete(schema.auditEvents);
    }

    const categoryIds = async (actor: Actor) => {
      const reply = await as(actor).get('/integrations/categories');
      expectOk(reply);
      return entriesOf(reply).map((entry) => entry.id as string);
    };

    beforeAll(async () => {
      db = createDatabase(url as string);
      h.db = db;
      await clean();
    });

    beforeEach(async () => {
      vi.spyOn(secretsService, 'getJwtSecret').mockResolvedValue('cd'.repeat(32));
      vi.spyOn(secretsService, 'getMasterKek').mockResolvedValue(KEK);
      vi.stubEnv('GITHUB_OAUTH_CLIENT_ID', '');
      vi.stubEnv('GITHUB_OAUTH_CLIENT_SECRET', '');
      await clean();
      admin = await createUser('admin');
      user = await createUser('user');
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      registry.registerModuleIntegrations?.([]);
      await clean();
    });

    afterAll(async () => {
      await clean();
      await db.$client.end({ timeout: 5 });
    });

    describe('loading modules', () => {
      it('[K4] registers the integrations of the modules it loads before it returns', async () => {
        expect(getIntegrationProvider('module.fx.crm'), 'registered before any module loaded').toBe(
          undefined,
        );

        await mount('fx');

        expect(getIntegrationProvider('module.fx.crm')).toMatchObject({
          id: 'module.fx.crm',
          categories: ['module.fx.docs', 'rich-documents'],
        });
        expect(listIntegrationCategories().map((category) => category.id)).toContain(
          'module.fx.docs',
        );
      });

      it('[K4+] registers what it is given and nothing of an earlier call', async () => {
        await mount('fx');
        await mount('gx');

        expect(getIntegrationProvider('module.gx.crm')).toBeDefined();
        expect(getIntegrationProvider('module.fx.crm')).toBeUndefined();

        await mount();

        expect(getIntegrationProvider('module.gx.crm')).toBeUndefined();
      });

      it('[K4+] refuses a module whose manifest breaks an integrations rule, naming the module', async () => {
        const forged = entryOf('fx', {
          integrations: [providerOf('fx', { categories: ['forge'] })],
        });

        const loading = mountModules(app, [forged], { db });

        await expect(loading).rejects.toThrow(/fx/);
      });
    });

    describe('GET /integrations/categories', () => {
      it('[K4] lists the core categories with no owner and those of the loaded modules with theirs', async () => {
        await mount('fx', 'gx');
        await setModule('fx', false);
        await setModule('gx', false);

        const reply = await as(user).get('/integrations/categories');

        expectOk(reply);
        const byId = new Map(entriesOf(reply).map((entry) => [entry.id, entry]));
        expect([...byId.keys()].sort()).toEqual(
          [...CORE_CATEGORY_IDS, 'module.fx.docs', 'module.gx.docs'].sort(),
        );
        for (const spec of CORE_INTEGRATION_CATEGORY_SPECS) {
          expect(byId.get(spec.id)).toMatchObject({
            id: spec.id,
            label: spec.label,
            moduleId: null,
            moduleName: null,
          });
        }
        expect(byId.get('module.fx.docs')).toMatchObject({
          label: 'Documents of fx',
          description: 'What fx files',
          moduleId: 'fx',
          moduleName: 'Module fx',
        });
        expect(byId.get('module.gx.docs')).toMatchObject({
          moduleId: 'gx',
          moduleName: 'Module gx',
        });
      });

      it('[K4+] lists the categories of a loaded module the modules table does not know yet, as active', async () => {
        await mount('fx');

        const reply = await as(user).get('/integrations/categories');

        expectOk(reply);
        expect(entriesOf(reply).find((entry) => entry.id === 'module.fx.docs')).toMatchObject({
          moduleId: 'fx',
          moduleName: 'Module fx',
        });
      });

      it('[K4+] lists the core categories first, then those of the modules in the order they loaded', async () => {
        await mount('gx', 'fx');

        expect(await categoryIds(user)).toEqual([
          ...CORE_CATEGORY_IDS,
          'module.gx.docs',
          'module.fx.docs',
        ]);
      });

      it('[K4] lists the core categories alone while no module is loaded', async () => {
        await mount();

        const reply = await as(user).get('/integrations/categories');

        expectOk(reply);
        expect(entriesOf(reply)).toMatchObject(
          CORE_INTEGRATION_CATEGORY_SPECS.map((spec) => ({
            id: spec.id,
            label: spec.label,
            moduleId: null,
            moduleName: null,
          })),
        );
      });

      it('[K4] leaves out the categories of a deactivated module and lists them again once it is active', async () => {
        await mount('fx', 'gx');
        await setModule('fx', true);
        await setModule('gx', false);

        const off = await categoryIds(user);
        expect(off).not.toContain('module.fx.docs');
        expect(off).toContain('module.gx.docs');
        expect(CORE_CATEGORY_IDS.filter((id) => !off.includes(id))).toEqual([]);

        await setModule('fx', false);

        expect(await categoryIds(user)).toContain('module.fx.docs');
      });
    });

    describe('GET /integrations/providers', () => {
      it('[K4+] lists a provider of a loaded module after the core ones, off until an admin switches it on', async () => {
        await mount('fx');
        await setModule('fx', false);
        const listed = async () => {
          const reply = await as(user).get('/integrations/providers');
          expectOk(reply);
          return entriesOf(reply);
        };

        const before = await listed();
        expect(before.map((provider) => provider.id)).toEqual([
          ...CORE_PROVIDER_IDS,
          'module.fx.crm',
        ]);
        expect(before[CORE_PROVIDER_IDS.length]).toMatchObject({
          displayName: 'Provider of fx',
          categories: ['module.fx.docs', 'rich-documents'],
          selfHosted: false,
          enabled: false,
          writeEnabled: false,
        });

        expectOk(
          await as(admin).put('/admin/integrations/providers/module.fx.crm', { enabled: true }),
        );
        expect((await listed())[CORE_PROVIDER_IDS.length]).toMatchObject({ enabled: true });

        await setModule('fx', true);
        expect((await listed())[CORE_PROVIDER_IDS.length]).toMatchObject({ enabled: false });
      });

      it('[K0] with no module loaded answers byte for byte what the unchanged tree answered', async () => {
        await mount();

        const reply = await as(user).get('/integrations/providers');

        expectOk(reply);
        if (process.env.PROVIDERS_BASELINE_CAPTURE === '1')
          writeFileSync(PROVIDERS_BASELINE, reply.text);
        expect(reply.text).toBe(readFileSync(PROVIDERS_BASELINE, 'utf8'));
        expect(entriesOf(reply).map((provider) => provider.id)).toEqual(CORE_PROVIDER_IDS);
      });
    });

    describe('the other routes of a provider', () => {
      it('[K4+] lists a provider of a loaded module to an admin, off, with no config row yet', async () => {
        await mount('fx');

        const reply = await as(admin).get('/admin/integrations/providers');

        expectOk(reply);
        const listed = entriesOf(reply);
        expect(listed.map((provider) => provider.id)).toEqual([
          ...CORE_PROVIDER_IDS,
          'module.fx.crm',
        ]);
        expect(listed[CORE_PROVIDER_IDS.length]).toMatchObject({
          name: 'Provider of fx',
          categories: ['module.fx.docs', 'rich-documents'],
          authKinds: ['oauth2'],
          enabled: false,
          rowExists: false,
        });
        expect(listed[CORE_PROVIDER_IDS.length]!.redirectUri).toContain('module.fx.crm');
      });

      it('[K4+] answers a sign-in start for a module provider like any other: 403 while it is off or its module is deactivated, 503 once on with no OAuth client', async () => {
        await mount('fx');
        const connect = () => as(user).post('/integrations/providers/module.fx.crm/connect');

        expectStatus(await connect(), 403);

        await setConfig('module.fx.crm', true);
        expectStatus(await connect(), 503);

        await setModule('fx', true);
        expectStatus(await connect(), 403);
      });
    });

    describe('choosing a provider of a module category', () => {
      const MODULE_CATEGORY = 'module.fx.docs';

      it('[K5] stores a preference naming a module category and a provider an admin switched on', async () => {
        await mount('fx');
        await setConfig('module.fx.crm', true);

        const reply = await as(user).put(`/integrations/preferences/${MODULE_CATEGORY}`, {
          providerId: 'module.fx.crm',
        });

        expectStatus(reply, 200);
        expect(reply.json).toMatchObject({
          categoryId: MODULE_CATEGORY,
          providerId: 'module.fx.crm',
        });
        const listed = await as(user).get('/integrations/preferences');
        expect(entriesOf(listed)).toEqual([
          { categoryId: MODULE_CATEGORY, providerId: 'module.fx.crm', connectionId: null },
        ]);
      });

      it('[K5] stores an admin default naming a module category', async () => {
        await mount('fx');
        await setConfig('module.fx.crm', true);

        const reply = await as(admin).put(`/admin/integrations/defaults/${MODULE_CATEGORY}`, {
          providerId: 'module.fx.crm',
        });

        expectStatus(reply, 200);
        const rows = await db
          .select()
          .from(schema.integrationCategoryPreferences)
          .where(eq(schema.integrationCategoryPreferences.categoryId, MODULE_CATEGORY));
        expect(rows.map((row) => [row.userId, row.providerId])).toEqual([[null, 'module.fx.crm']]);
      });

      it('[K5] stores a task choice naming a module category', async () => {
        await mount('fx');
        await setConfig('module.fx.crm', true);
        const taskId = await createTask(user.id);

        const reply = await as(user).put(`/tasks/${taskId}/integrations/${MODULE_CATEGORY}`, {
          providerId: 'module.fx.crm',
        });

        expectStatus(reply, 200);
        const rows = await db
          .select()
          .from(schema.taskIntegrationChoices)
          .where(eq(schema.taskIntegrationChoices.taskId, taskId));
        expect(rows.map((row) => [row.categoryId, row.providerId])).toEqual([
          [MODULE_CATEGORY, 'module.fx.crm'],
        ]);
      });

      it('[K5+] takes a provider of a module for a core category it serves', async () => {
        await mount('fx');
        await setConfig('module.fx.crm', true);

        const reply = await as(user).put('/integrations/preferences/rich-documents', {
          providerId: 'module.fx.crm',
        });

        expectStatus(reply, 200);
      });

      it('[K5+] refuses a provider no admin switched on with the existing 409', async () => {
        await mount('fx');

        const reply = await as(user).put(`/integrations/preferences/${MODULE_CATEGORY}`, {
          providerId: 'module.fx.crm',
        });

        expectStatus(reply, 409);
        expect(reply.json.error).toMatch(/not enabled/);
      });

      it('[K5+] refuses the provider of a deactivated module with the existing 409', async () => {
        await mount('fx');
        await setConfig('module.fx.crm', true);
        await setModule('fx', true);

        const reply = await as(user).put(`/integrations/preferences/${MODULE_CATEGORY}`, {
          providerId: 'module.fx.crm',
        });

        expectStatus(reply, 409);
      });

      it('[K5+] refuses a provider that does not serve the module category', async () => {
        await mount('fx');

        const reply = await as(user).put(`/integrations/preferences/${MODULE_CATEGORY}`, {
          providerId: 'github',
        });

        expectStatus(reply, 400);
        expect(reply.json.error).toMatch(/does not serve this category/);
      });

      it('[K0] still refuses a category no loaded module declares', async () => {
        await mount('fx');
        await setConfig('module.fx.crm', true);

        for (const categoryId of ['module.gx.docs', 'module.fx.nothing', 'nosuchcategory']) {
          const reply = await as(user).put(`/integrations/preferences/${categoryId}`, {
            providerId: 'module.fx.crm',
          });

          expectStatus(reply, 400);
          expect(reply.json.error).toBe('Unknown integration category');
        }
      });
    });
  },
);
