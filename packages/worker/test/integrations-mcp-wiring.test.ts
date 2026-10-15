import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { configService } from '@haive/shared';
import { verifyTaskToken } from '@haive/shared/task-token';
import { resolveMcpExtraFiles } from '../src/queues/cli-exec/resolvers.js';
import { isTransientCliFailure } from '../src/queues/cli-exec/failure-class.js';
import { SANDBOX_USER_HOME } from '../src/sandbox/sandbox-identity.js';
import {
  CUSTOM_MCP_SERVER_PATH,
  CUSTOM_MCP_TOKEN_PATH,
  CUSTOM_MCP_TOOLS_PATH,
} from '../src/sandbox/custom-mcp-server.js';
import {
  API_URL_ENV,
  SERVER_NAME,
  SERVER_PATH,
  TOKEN_PATH,
  UNWIRED_REASON,
  integrationsServerModule,
} from './support/integrations-contract.js';
import {
  INV_1,
  INV_2,
  STAMP,
  STEP_ROW_ID,
  TASK_ID,
  fakeDatabase,
  stampedDatabase,
} from './support/integrations-fixtures.js';
import { broker, content, listed, runCleanups, start } from './support/integrations-mcp-process.js';

vi.mock('../src/lsp/configured-lsp.js', () => ({ hasReadyLspBridge: async () => false }));

const merged = vi.hoisted(() => ({
  cli: [] as unknown[][],
  gemini: [] as unknown[][],
}));
const writers = vi.hoisted(() => ({ landed: true, file: [] as unknown[][] }));
vi.mock('../src/sandbox/task-auth-volume.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  mergeCliMcpIntoTaskVolume: async (...args: unknown[]) => {
    merged.cli.push(args);
    return writers.landed;
  },
  mergeGeminiMcpIntoSettings: async (...args: unknown[]) => {
    merged.gemini.push(args);
    return writers.landed;
  },
  writeMcpFileIntoTaskVolume: async (...args: unknown[]) => {
    writers.file.push(args);
    return writers.landed;
  },
}));

const forced = vi.hoisted(() => ({ delivery: undefined as 'volume-write' | undefined }));
vi.mock('../src/sandbox/mcp-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sandbox/mcp-config.js')>();
  return {
    ...actual,
    buildMcpConfigForCli: (...args: Parameters<typeof actual.buildMcpConfigForCli>) => {
      const config = actual.buildMcpConfigForCli(...args);
      return config && forced.delivery ? { ...config, delivery: forced.delivery } : config;
    },
  };
});

const SECRET = 'integrations-mcp-wiring-test-secret';
const NOW_MS = 1_800_000_000_000;
const CUSTOM_STEP_ID = 'custom.demo.audit';

type Provider = 'claude-code' | 'codex' | 'gemini' | 'antigravity';
type Files = Array<{ containerPath: string; content: string }>;
type Entry = { command: string; args: string[]; env?: Record<string, string> };
type Run = NonNullable<Parameters<typeof resolveMcpExtraFiles>[9]>;

const PROVIDERS: Provider[] = ['claude-code', 'codex', 'gemini', 'antigravity'];

const ENTRY: Entry = {
  command: 'node',
  args: [SERVER_PATH],
  env: { [API_URL_ENV]: 'http://api:3001' },
};
const CUSTOM_ENTRY: Entry = {
  command: 'node',
  args: ['/haive/haive-custom-mcp.mjs'],
  env: { CUSTOM_MCP_API_URL: 'http://api:3001' },
};

const houseRules = {
  name: 'house_rules',
  description: 'Searches the house rules.',
  action: 'rag-query',
  scope: 'global',
};
const pinnedHouseRules = {
  [CUSTOM_STEP_ID]: {
    slug: 'audit',
    title: 'Audit',
    template: 'Audit {{task.title}}',
    capabilities: [],
    timeoutMs: 300_000,
    tools: [houseRules],
  },
};

const run = (over: Partial<Run> = {}): Run => ({
  invocationId: INV_1,
  taskStepId: STEP_ROW_ID,
  timeoutMs: 600_000,
  ...over,
});

const extra = (
  provider: Provider,
  db: Database,
  forRun?: Run,
  profile: 'full' | 'rag_only' | 'none' = 'full',
) =>
  resolveMcpExtraFiles(
    db,
    TASK_ID,
    provider,
    '/haive/workdir',
    'img:tag',
    profile,
    false,
    true,
    null,
    forRun,
  );

const fileAt = (files: Files, path: string) => files.find((f) => f.containerPath === path)?.content;

const CONFIG_PATH: Record<'claude-code' | 'antigravity', string> = {
  'claude-code': '/haive/mcp.json',
  antigravity: `${SANDBOX_USER_HOME}/.gemini/config/mcp_config.json`,
};

/** Every server the provider's own delivery carries, by name. */
async function resolve(
  provider: Provider,
  db: Database,
  forRun?: Run,
  profile: 'full' | 'rag_only' | 'none' = 'full',
): Promise<{ servers: Record<string, Entry>; files: Files }> {
  merged.cli.length = 0;
  merged.gemini.length = 0;
  writers.file.length = 0;
  const { files } = await extra(provider, db, forRun, profile);
  if (provider === 'claude-code' || provider === 'antigravity') {
    const config = fileAt(files, CONFIG_PATH[provider]);
    const servers = config
      ? (JSON.parse(config) as { mcpServers: Record<string, Entry> }).mcpServers
      : {};
    return { servers, files };
  }
  if (provider === 'gemini') {
    return { servers: (merged.gemini[0]?.[1] ?? {}) as Record<string, Entry>, files };
  }
  const specs = (merged.cli[0]?.[3] ?? []) as Array<{ name: string } & Entry>;
  return {
    servers: Object.fromEntries(
      specs.map(({ name, command, args, env }) => [
        name,
        { command, args, ...(env ? { env } : {}) },
      ]),
    ),
    files,
  };
}

/** The message a stamped run fails with when it cannot be wired; the CLI is not started and the run is not retried. */
async function unwired(provider: Provider, db: Database, forRun: Run): Promise<string> {
  merged.cli.length = 0;
  merged.gemini.length = 0;
  writers.file.length = 0;
  const failure = await extra(provider, db, forRun).catch((err: unknown) => err);
  expect(failure).toBeInstanceOf(Error);
  const message = (failure as Error).message;
  expect(message.startsWith(`${UNWIRED_REASON}: `)).toBe(true);
  expect(isTransientCliFailure({ exitCode: -1, errorMessage: message })).toBe(false);
  return message;
}

const nothingWritten = () => {
  expect(merged).toEqual({ cli: [], gemini: [] });
  expect(writers.file).toEqual([]);
};

const tokenOf = (files: Files): string => {
  const token = fileAt(files, TOKEN_PATH);
  expect(typeof token, `the file ${TOKEN_PATH}`).toBe('string');
  return token as string;
};
const claimsIn = (files: Files) => verifyTaskToken(tokenOf(files), 'integrations', SECRET);

function expectNoTokenNorRunValue(entry: Entry | undefined, token: string): void {
  const written = JSON.stringify(entry);
  expect(written).not.toContain(token);
  expect(written).not.toContain(INV_1);
  expect(written).not.toContain(STEP_ROW_ID);
}

function expectNothingWired(servers: Record<string, Entry>, files: Files): void {
  expect(servers[SERVER_NAME]).toBeUndefined();
  for (const path of [SERVER_PATH, TOKEN_PATH]) expect(fileAt(files, path), path).toBeUndefined();
  expect(files.map((f) => f.content).join('\n')).not.toContain(SERVER_NAME);
}

beforeEach(() => {
  process.env.CONFIG_ENCRYPTION_KEY = SECRET;
  delete process.env.RAG_API_INTERNAL_URL;
  writers.landed = true;
  writers.file.length = 0;
  merged.cli.length = 0;
  merged.gemini.length = 0;
  vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
  vi.spyOn(configService, 'getNumber').mockImplementation(async (_key, fallback = 0) => fallback);
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
});

afterEach(async () => {
  await runCleanups();
  forced.delivery = undefined;
  vi.restoreAllMocks();
  delete process.env.CONFIG_ENCRYPTION_KEY;
  delete process.env.RAG_API_INTERNAL_URL;
});

describe.each(PROVIDERS)('the haive-integrations server of a stamped run, for %s', (provider) => {
  it('[W1] gets the entry, with the address of the API and no token or per-invocation value', async () => {
    const { servers, files } = await resolve(provider, stampedDatabase(), run());
    const entry = servers[SERVER_NAME];
    expect(entry).toEqual(ENTRY);
    expect(servers['haive-custom']).toBeUndefined();
    const token = tokenOf(files);
    expectNoTokenNorRunValue(entry, token);

    // The assertion above has teeth: an entry that carries the token, the invocation or the step fails it.
    const leaking = (name: string, value: string) => ({
      ...ENTRY,
      env: { ...ENTRY.env, [name]: value },
    });
    expect(() =>
      expectNoTokenNorRunValue(leaking('INTEGRATIONS_MCP_TOKEN', token), token),
    ).toThrow();
    expect(() =>
      expectNoTokenNorRunValue(leaking('INTEGRATIONS_MCP_INVOCATION', INV_1), token),
    ).toThrow();
    expect(() =>
      expectNoTokenNorRunValue(leaking('INTEGRATIONS_MCP_STEP', STEP_ROW_ID), token),
    ).toThrow();
  });

  it('[W1] gets the script and the token file, once each, and no other file', async () => {
    const stamped = await resolve(provider, stampedDatabase(), run());
    for (const path of [SERVER_PATH, TOKEN_PATH]) {
      expect(
        stamped.files.filter((f) => f.containerPath === path),
        path,
      ).toHaveLength(1);
    }
    expect(fileAt(stamped.files, SERVER_PATH)).toBe(
      (await integrationsServerModule()).INTEGRATIONS_MCP_SERVER_JS,
    );
    const bare = await resolve(provider, stampedDatabase(null), run());
    const added = stamped.files
      .map((f) => f.containerPath)
      .filter((path) => !bare.files.some((f) => f.containerPath === path));
    expect(added.sort()).toEqual([SERVER_PATH, TOKEN_PATH].sort());
  });

  it('[W1] gets a token whose verified claims carry that task, step and invocation, and the audience', async () => {
    const { files } = await resolve(provider, stampedDatabase(), run());
    const token = tokenOf(files);
    expect(verifyTaskToken(token, 'integrations', SECRET)).toEqual({
      aud: 'integrations',
      taskId: TASK_ID,
      taskStepId: STEP_ROW_ID,
      cliInvocationId: INV_1,
      exp: NOW_MS / 1000 + 600 + 15 * 60,
    });
    for (const other of ['rag', 'ddev', 'custom-mcp'] as const) {
      expect(verifyTaskToken(token, other, SECRET)).toBeNull();
    }
    expect(verifyTaskToken(token, 'integrations', 'another-secret')).toBeNull();
  });

  it('[W2] gives two invocations of one task a byte-identical entry and each its own token', async () => {
    const first = await resolve(provider, stampedDatabase(), run({ invocationId: INV_1 }));
    const second = await resolve(provider, stampedDatabase(), run({ invocationId: INV_2 }));
    expect(first.servers[SERVER_NAME]).toEqual(ENTRY);
    expect(JSON.stringify(second.servers[SERVER_NAME])).toBe(
      JSON.stringify(first.servers[SERVER_NAME]),
    );
    expect(claimsIn(first.files)?.cliInvocationId).toBe(INV_1);
    expect(claimsIn(second.files)?.cliInvocationId).toBe(INV_2);
    expect(fileAt(second.files, TOKEN_PATH)).not.toBe(fileAt(first.files, TOKEN_PATH));
    expect(fileAt(second.files, SERVER_PATH)).toBe(fileAt(first.files, SERVER_PATH));

    // The comparison has teeth: an entry that carries the invocation id differs between the two.
    const carrying = (id: string) =>
      JSON.stringify({ ...ENTRY, env: { ...ENTRY.env, INTEGRATIONS_MCP_INVOCATION: id } });
    expect(carrying(INV_2)).not.toBe(carrying(INV_1));
  });

  it('[W1+] is still wired when the stamp holds an entry that does not parse beside one that does', async () => {
    const stamp = [{ requirementId: 'broken' }, STAMP[0], 'junk', null];
    const { servers, files } = await resolve(provider, stampedDatabase(stamp), run());
    expect(servers[SERVER_NAME]).toEqual(ENTRY);
    expect(fileAt(files, SERVER_PATH)).toBeDefined();
  });

  it('[W1] reads the stamp of the invocation it runs for, not another invocation of the task', async () => {
    const db = () =>
      fakeDatabase({
        invocations: [
          { id: INV_1, integrations: null },
          { id: INV_2, integrations: STAMP },
        ],
      });
    expect(
      (await resolve(provider, db(), run({ invocationId: INV_2 }))).servers[SERVER_NAME],
    ).toEqual(ENTRY);
    const other = await resolve(provider, db(), run({ invocationId: INV_1 }));
    expectNothingWired(other.servers, other.files);
  });
});

describe('the lifetime of the token', () => {
  const lifetime = async (forRun: Run) => {
    const { files } = await resolve('claude-code', stampedDatabase(), forRun);
    return claimsIn(files)!.exp - NOW_MS / 1000;
  };

  it("[W1] is the invocation's timeout, rounded up to the second, plus 15 minutes", async () => {
    expect(await lifetime(run({ timeoutMs: 1_800_500 }))).toBe(1801 + 900);
  });

  it('[W1] is the default lifetime of a task token when the invocation carries no timeout', async () => {
    expect(await lifetime(run({ timeoutMs: undefined }))).toBe(24 * 60 * 60);
  });
});

describe('the API address', () => {
  it('[W1+] follows RAG_API_INTERNAL_URL, as the other servers do', async () => {
    process.env.RAG_API_INTERNAL_URL = 'http://host.docker.internal:3001';
    const { servers } = await resolve('claude-code', stampedDatabase(), run());
    expect(servers[SERVER_NAME]?.env).toEqual({
      [API_URL_ENV]: 'http://host.docker.internal:3001',
    });
  });
});

describe.each(PROVIDERS)('a run that has custom tools and a stamp, for %s', (provider) => {
  const db = () =>
    fakeDatabase({
      customSteps: pinnedHouseRules,
      stepId: CUSTOM_STEP_ID,
      invocations: [{ id: INV_1, integrations: STAMP }],
    });

  it('[W1+] gets both servers, haive-custom first, and both token files, each good for its own audience only', async () => {
    const { servers, files } = await resolve(provider, db(), run({ customTools: ['house_rules'] }));
    expect(servers['haive-custom']).toEqual(CUSTOM_ENTRY);
    expect(servers[SERVER_NAME]).toEqual(ENTRY);
    expect(Object.keys(servers).filter((name) => name.startsWith('haive-'))).toEqual([
      'haive-custom',
      SERVER_NAME,
    ]);
    for (const path of [
      CUSTOM_MCP_SERVER_PATH,
      CUSTOM_MCP_TOOLS_PATH,
      CUSTOM_MCP_TOKEN_PATH,
      SERVER_PATH,
      TOKEN_PATH,
    ]) {
      expect(
        files.filter((f) => f.containerPath === path),
        path,
      ).toHaveLength(1);
    }
    const custom = fileAt(files, CUSTOM_MCP_TOKEN_PATH)!;
    const integrations = tokenOf(files);
    expect(integrations).not.toBe(custom);
    expect(verifyTaskToken(custom, 'custom-mcp', SECRET)?.cliInvocationId).toBe(INV_1);
    expect(verifyTaskToken(integrations, 'integrations', SECRET)?.cliInvocationId).toBe(INV_1);
    expect(verifyTaskToken(custom, 'integrations', SECRET)).toBeNull();
    expect(verifyTaskToken(integrations, 'custom-mcp', SECRET)).toBeNull();
  });
});

describe.each(PROVIDERS)(
  'a run that is not given the haive-integrations server, for %s',
  (provider) => {
    const wired = async () => {
      const { servers } = await resolve(provider, stampedDatabase(), run());
      expect(servers[SERVER_NAME], 'the same call, with a stamp, is wired').toEqual(ENTRY);
    };

    it.each([
      ['no stamp', null],
      ['an empty stamp', []],
      ['a stamp none of whose entries parse', [{ requirementId: 'broken' }, 'junk', null]],
      ['a stamp that is not a list', { requirementId: 'pull-requests' }],
    ])('[W4] has %s', async (_label, stamp) => {
      await wired();
      const { servers, files } = await resolve(provider, stampedDatabase(stamp), run());
      expectNothingWired(servers, files);
    });

    it('[W4] is a rag_only run, though its invocation is stamped', async () => {
      await wired();
      const { servers, files } = await resolve(provider, stampedDatabase(), run(), 'rag_only');
      expectNothingWired(servers, files);
    });

    it('[W4] is a none run, which reads nothing from the database', async () => {
      await wired();
      merged.cli.length = 0;
      merged.gemini.length = 0;
      const { files, extraArgs } = await resolveMcpExtraFiles(
        null as never,
        TASK_ID,
        provider,
        '/haive/workdir',
        'img:tag',
        'none',
        false,
        true,
        null,
        run(),
      );
      expect(files).toEqual([]);
      expect(extraArgs).toEqual([]);
    });

    it('[W4+] is a call that carries no run, which reads no stamp', async () => {
      await wired();
      const { servers, files } = await resolve(
        provider,
        fakeDatabase({ withoutInvocations: true }),
      );
      expectNothingWired(servers, files);
    });

    it('[W4+] is a run without a stamp, which is not failed for want of a step or of the secret', async () => {
      await wired();
      delete process.env.CONFIG_ENCRYPTION_KEY;
      const unstamped = stampedDatabase(null);
      for (const forRun of [run({ taskStepId: null }), run()]) {
        const { servers, files } = await resolve(provider, unstamped, forRun);
        expectNothingWired(servers, files);
      }
    });
  },
);

describe.each<Provider>(['codex', 'gemini'])(
  'a stamped run whose CLI configuration does not land in its task volume, for %s',
  (provider) => {
    it('[W3] fails with the unwired reason, and the same call is wired while the write lands', async () => {
      const { servers } = await resolve(provider, stampedDatabase(), run());
      expect(servers[SERVER_NAME], 'the write lands').toEqual(ENTRY);

      writers.landed = false;
      await unwired(provider, stampedDatabase(), run());
      expect(merged.cli.length + merged.gemini.length).toBe(1);
    });

    it('[W3] lets a run with no stamp go on, with the same writer result', async () => {
      writers.landed = false;
      const { files } = await extra(provider, stampedDatabase(null), run());
      expect(merged.cli.length + merged.gemini.length).toBe(1);
      for (const path of [SERVER_PATH, TOKEN_PATH])
        expect(fileAt(files, path), path).toBeUndefined();
    });
  },
);

describe('a CLI whose configuration is bound into each invocation', () => {
  it('[W3] wires a stamped run whatever the volume writers report', async () => {
    writers.landed = false;
    for (const provider of ['claude-code', 'antigravity'] as const) {
      const { servers } = await resolve(provider, stampedDatabase(), run());
      expect(servers[SERVER_NAME], provider).toEqual(ENTRY);
    }
  });
});

describe('a CLI whose configuration file is written whole into its task volume', () => {
  it('[W3] fails a stamped run whose file did not land, wires one whose file landed, and lets an unstamped one go on', async () => {
    forced.delivery = 'volume-write';
    const landed = await extra('antigravity', stampedDatabase(), run());
    expect(writers.file).toHaveLength(1);
    expect(fileAt(landed.files, SERVER_PATH)).toBeDefined();
    expect(JSON.stringify(writers.file[0])).toContain(SERVER_NAME);

    writers.file.length = 0;
    writers.landed = false;
    await unwired('antigravity', stampedDatabase(), run());
    expect(writers.file).toHaveLength(1);

    writers.file.length = 0;
    const { files } = await extra('antigravity', stampedDatabase(null), run());
    expect(writers.file).toHaveLength(1);
    expect(fileAt(files, SERVER_PATH)).toBeUndefined();
  });
});

describe.each(PROVIDERS)('a stamped run that cannot be given its token, for %s', (provider) => {
  it('[W3] fails with the unwired reason, before anything is written, when it is not tied to a step', async () => {
    const { servers } = await resolve(provider, stampedDatabase(), run());
    expect(servers[SERVER_NAME], 'the same call, tied to a step, is wired').toEqual(ENTRY);

    await unwired(provider, stampedDatabase(), run({ taskStepId: null }));
    nothingWritten();
  });

  it('[W3+] fails with the unwired reason, before anything is written, when nothing can sign the token', async () => {
    const { servers } = await resolve(provider, stampedDatabase(), run());
    expect(servers[SERVER_NAME], 'the same call, with the secret, is wired').toEqual(ENTRY);

    delete process.env.CONFIG_ENCRYPTION_KEY;
    await unwired(provider, stampedDatabase(), run());
    nothingWritten();
  });
});

describe('the files of a stamped run, served as the sandbox serves them', () => {
  it('[W1] lists what the broker lists with the token it was given, and calls with it', async () => {
    const { files } = await resolve('claude-code', stampedDatabase(), run());
    const script = fileAt(files, SERVER_PATH);
    const token = fileAt(files, TOKEN_PATH);
    expect(script, `the file ${SERVER_PATH}`).toBeDefined();
    expect(token, `the file ${TOKEN_PATH}`).toBeDefined();
    const stub = await broker((seen) =>
      seen.url === '/integration-mcp/tools/list'
        ? {
            status: 200,
            body: JSON.stringify({
              tools: [
                {
                  name: 'get_pull_request_state',
                  description: 'Reads the state of one pull request.',
                  inputSchema: { type: 'object' },
                },
              ],
            }),
          }
        : { status: 200, body: '{"ok":true,"text":"{\\"state\\":\\"open\\"}"}' },
    );
    const { ask } = await start({
      script,
      token,
      apiUrl: stub.url,
    });
    await ask('initialize');
    const tools = listed(await ask('tools/list')) as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name)).toEqual(['get_pull_request_state']);
    const reply = await ask('tools/call', {
      name: 'get_pull_request_state',
      arguments: { prNumber: 7 },
    });
    expect(reply.result?.isError ?? false).toBe(false);
    expect(content(reply)).toBe('{"state":"open"}');

    expect(stub.seen.map((seen) => seen.url)).toEqual([
      '/integration-mcp/tools/list',
      '/integration-mcp/call',
    ]);
    for (const seen of stub.seen) {
      const bearer = seen.authorization!.replace(/^Bearer /, '');
      expect(verifyTaskToken(bearer, 'integrations', SECRET)).toMatchObject({
        taskId: TASK_ID,
        taskStepId: STEP_ROW_ID,
        cliInvocationId: INV_1,
      });
    }
  });
});
