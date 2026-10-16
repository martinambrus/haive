import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import {
  getIntegrationProvider,
  integrationTools,
  type IntegrationBinding,
} from '@haive/shared/integrations';
import type { CliProviderRecord } from '../src/cli-adapters/types.js';
import { MCP_SURFACE_MARKER } from '../src/sandbox/mcp-surface.js';
import {
  ACCOUNT_LABEL,
  SIGNING_KEY,
  deleteUsers,
  seedBareWorld,
  seedConnection,
  seedProvider,
  seedStepRow,
} from './support/step-integrations-db.js';
import {
  resolveTaskDispatch,
  type DispatchInput,
  type DispatchRequest,
} from '../src/orchestrator/dispatcher.js';

const url = process.env.STEP_INTEGRATIONS_PROMPT_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/step_integrations_prompt_test'))
  throw new Error('Use a dedicated step_integrations_prompt_test database for the prompt tests');

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'error';
});

vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: {
    get: async () => null,
    getFresh: async () => null,
    getNumber: async (_key: string, fallback = 0) => fallback,
    getBoolean: async (_key: string, fallback = false) => fallback,
  },
}));
vi.mock('../src/orchestrator/global-kb-context.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveGlobalKbContext: async () => ({
    digest: { entries: [], omitted: 0, scanSaturated: false },
    rules: [],
    refused: [],
    status: 'ok',
  }),
}));

const SERVER = 'haive-integrations';
const READ_TOOL = 'get_pull_request_state';
const WRITE_TOOL = 'open_pull_request';
const PROMPT: DispatchInput = { kind: 'prompt', prompt: 'Audit it.', capabilities: ['tool_use'] };

describe.skipIf(!url)('the integrations line of a dispatch prompt, on Postgres', () => {
  let db: Database;
  const users: string[] = [];
  let savedKey: string | undefined;

  beforeAll(() => {
    db = createDatabase(url as string);
  });

  afterAll(async () => {
    await deleteUsers(db, users);
    await db.$client.end({ timeout: 5 });
  });

  beforeEach(() => {
    savedKey = process.env.CONFIG_ENCRYPTION_KEY;
    process.env.CONFIG_ENCRYPTION_KEY = SIGNING_KEY;
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.CONFIG_ENCRYPTION_KEY;
    else process.env.CONFIG_ENCRYPTION_KEY = savedKey;
  });

  async function world() {
    const w = await seedBareWorld(db);
    users.push(w.userId);
    const connectionId = await seedConnection(db, w.userId);
    const claude = await seedProvider(db, w.userId, 'claude-code');
    return { ...w, connectionId, claude };
  }

  const switchWrite = (userId: string, providerId: string, writeEnabled: boolean) =>
    db.insert(schema.integrationUserSettings).values({ userId, providerId, writeEnabled });

  const binding = (
    connectionId: string,
    over: Partial<IntegrationBinding> = {},
  ): IntegrationBinding => ({
    requirementId: 'pull-requests',
    categoryId: 'forge',
    providerId: 'github',
    connectionId,
    access: 'read',
    ...over,
  });

  async function surfaceOf(
    w: { taskId: string; claude: CliProviderRecord },
    integrations: IntegrationBinding[] | undefined,
  ): Promise<string> {
    const request = {
      providers: [w.claude],
      ...(integrations === undefined ? {} : { integrations, requiresMcp: true }),
      input: PROMPT,
      invokeOpts: {},
    } as unknown as DispatchRequest;

    const plan = await resolveTaskDispatch(db, w.taskId, request);

    expect(plan.mode).toBe('cli');
    const text = plan.effectivePrompt ?? '';
    const open = text.indexOf(MCP_SURFACE_MARKER);
    const close = text.indexOf('</haive_mcp_surface>');
    expect(open, 'the prompt has no MCP surface block').toBeGreaterThanOrEqual(0);
    return text.slice(open, close);
  }

  async function withToolsOfRepo(taskId: string, mcpServers: Record<string, unknown>) {
    await seedStepRow(db, taskId, {
      stepId: '04-tooling-infrastructure',
      status: 'done',
      output: { tooling: { mcpSettingsJson: JSON.stringify({ mcpServers }) } },
    });
  }

  describe('[D11] what the agent is told it has', () => {
    it('[D11] adds no integrations line to a dispatch that carries no bindings (passes before and after)', async () => {
      const w = await world();

      const block = await surfaceOf(w, undefined);

      expect(block).not.toContain(SERVER);
    }, 60_000);

    it('[D11] names the provider and its read tools, never the account, while the write switch is off', async () => {
      const w = await world();

      const block = await surfaceOf(w, [binding(w.connectionId, { access: 'write' })]);

      expect(block).toContain(SERVER);
      expect(block).toContain('GitHub');
      expect(block).toContain(READ_TOOL);
      expect(block).not.toContain(WRITE_TOOL);
      expect(block).not.toContain(ACCOUNT_LABEL);
    }, 60_000);

    it('[D11] adds the write tools once the owner switches writes on for the provider', async () => {
      const w = await world();
      await switchWrite(w.userId, 'github', true);

      const block = await surfaceOf(w, [binding(w.connectionId, { access: 'write' })]);

      expect(block).toContain(READ_TOOL);
      expect(block).toContain(WRITE_TOOL);
      expect(block).not.toContain(ACCOUNT_LABEL);
    }, 60_000);

    it('[D11] keeps the write tools out of a read binding, whatever the switch says', async () => {
      const w = await world();
      await switchWrite(w.userId, 'github', true);

      const block = await surfaceOf(w, [binding(w.connectionId, { access: 'read' })]);

      expect(block).toContain(READ_TOOL);
      expect(block).not.toContain(WRITE_TOOL);
    }, 60_000);

    it('[D11] keeps the write tools out while only another provider has its switch on', async () => {
      const w = await world();
      await switchWrite(w.userId, 'gitlab', true);

      const block = await surfaceOf(w, [binding(w.connectionId, { access: 'write' })]);

      expect(block).toContain(READ_TOOL);
      expect(block).not.toContain(WRITE_TOOL);
    }, 60_000);

    it('[D11] names every provider, and each tool under the name the broker will list it by', async () => {
      const w = await world();
      const gitlab = await seedConnection(db, w.userId, {
        provider: 'gitlab',
        host: 'gitlab.com',
        label: 'second-account-5521',
      });
      const bindings = [
        binding(w.connectionId, { requirementId: 'host-a' }),
        binding(gitlab, { requirementId: 'host-b', providerId: 'gitlab' }),
      ];
      const listed = [
        ...integrationTools(bindings, getIntegrationProvider, { writeAllowed: () => false }).keys(),
      ];
      expect(listed.length, 'the fixture: two bindings of one operation are renamed').toBe(2);
      expect(listed.every((name) => name.includes('get_pull_request_state'))).toBe(true);

      const block = await surfaceOf(w, bindings);

      expect(block).toContain('GitHub');
      expect(block).toContain('GitLab');
      for (const name of listed) expect(block).toContain(name);
      expect(block).not.toContain('second-account-5521');
      expect(block).not.toContain(ACCOUNT_LABEL);
    }, 60_000);

    it.each([
      ['a line break', 'Git\nHub', ['Git\nHub']],
      ['a run of four equals signs', 'Git====Hub', ['Git====Hub', 'Git===Hub']],
    ])(
      '[D11] names a provider by its id when its display name holds %s',
      async (_label, displayName, absent) => {
        const w = await world();
        const spec = getIntegrationProvider('github')!;
        const real = spec.displayName;
        spec.displayName = displayName;

        try {
          const block = await surfaceOf(w, [binding(w.connectionId)]);

          expect(block).toContain(SERVER);
          expect(block).toContain('github');
          expect(block).toContain(READ_TOOL);
          for (const text of absent) expect(block).not.toContain(text);
        } finally {
          spec.displayName = real;
        }
      },
      60_000,
    );
  });

  describe('[D12] a user server named like the integrations server', () => {
    const SERVERS = {
      'company-docs': { command: 'npx', args: ['-y', 'company-docs-mcp'] },
      [SERVER]: { command: 'npx', args: ['-y', 'their-own-mcp'] },
    };
    const projectLine = (block: string) =>
      block.split('\n').find((line) => line.includes('Project-configured servers:')) ?? '';

    it('[D12] is not reachable once the integrations server is wired, and the others still are', async () => {
      const w = await world();
      await withToolsOfRepo(w.taskId, SERVERS);

      const block = await surfaceOf(w, [binding(w.connectionId)]);

      expect(projectLine(block)).toContain('`company-docs`');
      expect(projectLine(block)).not.toContain(SERVER);
    }, 60_000);

    it('[D12+] is reachable while nothing is wired under that name (passes before and after)', async () => {
      const w = await world();
      await withToolsOfRepo(w.taskId, SERVERS);

      const block = await surfaceOf(w, undefined);

      expect(projectLine(block)).toContain('`company-docs`');
      expect(projectLine(block)).toContain(`\`${SERVER}\``);
    }, 60_000);
  });
});
