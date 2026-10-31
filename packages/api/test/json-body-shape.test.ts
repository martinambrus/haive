import { describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/middleware/auth.js')>()),
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
}));
vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: { get: async () => null, getBoolean: async () => true },
  userSecretsService: { get: async () => null, listForUser: async () => [] },
}));

import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';

// The real app, so the body is read behind the same middleware a request meets in production.
const { createApiApp } = await import('../src/index.js');

const REPO = '00000000-0000-4000-8000-0000000000c1';
const BUNDLE = '00000000-0000-4000-8000-0000000000d1';
const TASK = '00000000-0000-4000-8000-0000000000e1';
const TABLES = {
  repositories: schema.repositories,
  projectStateOutbox: schema.projectStateOutbox,
  toolPackageVersions: schema.toolPackageVersions,
  customBundles: schema.customBundles,
  customBundleUploads: schema.customBundleUploads,
  tasks: schema.tasks,
};

const web = createApiApp('http://localhost:3000');

/** The rtk pin is behind the newest version, so an upgrade that runs is visible in the repository. */
function setup() {
  const fake = createFakeDb(TABLES);
  fake.insert(schema.repositories, {
    id: REPO,
    userId: USER,
    name: 'repo',
    source: 'local_path',
    rtkEnabled: true,
    rtkVersion: '0.1.0',
  });
  fake.insert(schema.toolPackageVersions, {
    name: 'rtk',
    versions: ['0.3.0', '0.1.0'],
    latestVersion: '0.3.0',
  });
  fake.insert(schema.customBundles, {
    id: BUNDLE,
    userId: USER,
    repositoryId: REPO,
    name: 'kit',
    sourceType: 'zip',
    enabledKinds: ['agent', 'skill'],
    storageRoot: '/bundles/kit',
  });
  h.db = fake.db;
  return fake;
}

/** Every table the fake holds, as it stands: what a refused request is compared to. */
const everything = (fake: ReturnType<typeof setup>) =>
  Object.values(TABLES).map((table) => fake.rows(table));

const rtkVersion = (fake: ReturnType<typeof setup>) =>
  fake.rows(schema.repositories).find((r) => r.id === REPO)?.rtkVersion;

interface Route {
  name: string;
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
}

const route = (method: Route['method'], path: string, label = path): Route => ({
  name: `${method} ${label}`,
  method,
  path,
});

const ROUTES = {
  testPostgres: route('POST', '/tooling/test-postgres'),
  testOllama: route('POST', '/tooling/test-ollama'),
  ollamaModelCapabilities: route('POST', '/tooling/ollama-model-capabilities'),
  cancelPull: route('POST', '/tooling/cancel-pull'),
  pullOllamaModel: route('POST', '/tooling/pull-ollama-model'),
  ideSettings: route('PUT', '/user-settings/ide'),
  uiPrefsPut: route('PUT', '/user-settings/ui-prefs'),
  uiPrefsPatch: route('PATCH', '/user-settings/ui-prefs'),
  bundleReplaceInit: route('POST', `/bundles/${BUNDLE}/replace/init`, '/bundles/:id/replace/init'),
  toolingUpgrade: route(
    'POST',
    `/repositories/${REPO}/tooling-upgrade`,
    '/repositories/:id/tooling-upgrade',
  ),
  planDelete: route('DELETE', `/repositories/${REPO}/plan`, '/repositories/:id/plan'),
  steer: route('POST', `/tasks/${TASK}/steer-active-cli`, '/tasks/:id/steer-active-cli'),
};

/** Every route that answers a refusal as a JSON response; the SSE route answers it as an event. */
const JSON_ROUTES = Object.values(ROUTES).filter((r) => r !== ROUTES.pullOllamaModel);

/** `raw` is the body exactly as it goes on the wire; '' sends an empty one. */
const send = (target: Route, raw: string) =>
  web.request(target.path, {
    method: target.method,
    headers: { host: 'localhost:3001', 'content-type': 'application/json' },
    body: raw,
  });

/** The status and the `code` of a JSON answer: all a refusal is asserted on, never its wording. */
async function answer(res: Response) {
  const body = (await res.json().catch(() => null)) as { code?: unknown } | null;
  return { status: res.status, code: body?.code };
}

const NON_OBJECT_BODIES: [string, string][] = [
  ['null', 'null'],
  ['a list', '[]'],
  ['a string', '"text"'],
  ['a number', '5'],
  ['a boolean', 'true'],
];

describe.each(JSON_ROUTES)('$name', (target) => {
  it.each(NON_OBJECT_BODIES)(
    'answers 400 invalid_body for a JSON body that is %s, and writes nothing',
    async (_what, raw) => {
      const fake = setup();
      const before = everything(fake);

      const res = await send(target, raw);

      // Soft, so a request that is refused wrongly AND wrote shows both.
      expect.soft(await answer(res)).toEqual({ status: 400, code: 'invalid_body' });
      expect.soft(everything(fake)).toEqual(before);
    },
  );
});

describe(ROUTES.pullOllamaModel.name, () => {
  it.each(NON_OBJECT_BODIES)(
    'answers an invalid_body error event for a JSON body that is %s',
    async (_what, raw) => {
      setup();

      const res = await send(ROUTES.pullOllamaModel, raw);
      const stream = await res.text();

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      expect(stream).toContain('event: error');
      expect(stream).toContain('invalid_body');
    },
  );
});

describe('a body that is a JSON object still reaches the handler', () => {
  const CASES: { target: Route; raw: string; status: number }[] = [
    { target: ROUTES.testPostgres, raw: '{}', status: 400 },
    { target: ROUTES.testOllama, raw: '{}', status: 400 },
    { target: ROUTES.ollamaModelCapabilities, raw: '{}', status: 400 },
    { target: ROUTES.cancelPull, raw: '{}', status: 400 },
    { target: ROUTES.cancelPull, raw: '{"pullId":"x"}', status: 200 },
    { target: ROUTES.ideSettings, raw: '{}', status: 400 },
    { target: ROUTES.uiPrefsPut, raw: '{}', status: 400 },
    { target: ROUTES.uiPrefsPatch, raw: '{}', status: 400 },
    { target: ROUTES.bundleReplaceInit, raw: '{}', status: 400 },
    { target: ROUTES.planDelete, raw: '{}', status: 400 },
    { target: ROUTES.steer, raw: '{}', status: 400 },
    { target: ROUTES.steer, raw: '{"text":"hi"}', status: 404 },
  ];

  it.each(CASES)(
    '$target.name with $raw answers $status of its own',
    async ({ target, raw, status }) => {
      setup();

      const res = await send(target, raw);

      const answered = await answer(res);
      expect(answered.status).toBe(status);
      expect(answered.code).not.toBe('invalid_body');
    },
  );

  it(`${ROUTES.planDelete.name} still asks for the repository name`, async () => {
    setup();

    const res = await send(ROUTES.planDelete, '{}');

    expect(await answer(res)).toEqual({ status: 400, code: 'plan_delete_confirm_mismatch' });
  });

  it(`${ROUTES.pullOllamaModel.name} with {} answers an error event of its own`, async () => {
    setup();

    const res = await send(ROUTES.pullOllamaModel, '{}');
    const stream = await res.text();

    expect(res.status).toBe(200);
    expect(stream).toContain('event: error');
    expect(stream).not.toContain('invalid_body');
  });

  describe(ROUTES.toolingUpgrade.name, () => {
    it('upgrades what is behind for {}', async () => {
      const fake = setup();

      const res = await send(ROUTES.toolingUpgrade, '{}');

      expect(res.status).toBe(200);
      expect(rtkVersion(fake)).toBe('0.3.0');
    });

    it('upgrades only the components it is told to', async () => {
      const fake = setup();

      const res = await send(ROUTES.toolingUpgrade, '{"components":["chrome-devtools-mcp"]}');

      expect(res.status).toBe(200);
      expect(rtkVersion(fake)).toBe('0.1.0');
    });
  });
});

describe('an empty or malformed body is answered as it was', () => {
  const UNREADABLE_BODIES: [string, string][] = [
    ['an empty body', ''],
    ['text that is not JSON', '{bad'],
  ];

  describe.each([
    ROUTES.testPostgres,
    ROUTES.testOllama,
    ROUTES.ollamaModelCapabilities,
    ROUTES.cancelPull,
    ROUTES.ideSettings,
    ROUTES.uiPrefsPut,
    ROUTES.uiPrefsPatch,
    ROUTES.bundleReplaceInit,
  ])('$name', (target) => {
    it.each(UNREADABLE_BODIES)('answers 400 invalid_json for %s', async (_what, raw) => {
      setup();

      const res = await send(target, raw);

      expect(await answer(res)).toEqual({ status: 400, code: 'invalid_json' });
    });
  });

  describe(ROUTES.pullOllamaModel.name, () => {
    it.each(UNREADABLE_BODIES)(
      'answers an error event, not invalid_body, for %s',
      async (_what, raw) => {
        setup();

        const res = await send(ROUTES.pullOllamaModel, raw);
        const stream = await res.text();

        expect(res.status).toBe(200);
        expect(stream).toContain('event: error');
        expect(stream).not.toContain('invalid_body');
      },
    );
  });

  describe(ROUTES.toolingUpgrade.name, () => {
    it.each(UNREADABLE_BODIES)(
      'still upgrades everything that is behind for %s',
      async (_what, raw) => {
        const fake = setup();

        const res = await send(ROUTES.toolingUpgrade, raw);

        expect(res.status).toBe(200);
        expect(rtkVersion(fake)).toBe('0.3.0');
      },
    );
  });

  describe(ROUTES.planDelete.name, () => {
    it.each(UNREADABLE_BODIES)('still asks for the repository name for %s', async (_what, raw) => {
      setup();

      const res = await send(ROUTES.planDelete, raw);

      expect(await answer(res)).toEqual({ status: 400, code: 'plan_delete_confirm_mismatch' });
    });
  });

  describe(ROUTES.steer.name, () => {
    it.each(UNREADABLE_BODIES)(
      'still answers 400 for the missing text for %s',
      async (_what, raw) => {
        setup();

        const res = await send(ROUTES.steer, raw);

        const { status, code } = await answer(res);
        expect(status).toBe(400);
        expect(['invalid_body', 'invalid_json']).not.toContain(code);
      },
    );
  });
});
