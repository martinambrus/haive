import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { CONFIG_KEYS, configService, type CliExecJobPayload } from '@haive/shared';
import { customToolSchema, validateCustomTools } from '@haive/shared/modularity';
import { verifyTaskToken } from '@haive/shared/task-token';
import {
  CUSTOM_TOOLS_UNWIRED_REASON,
  resolveMcpExtraFiles,
} from '../src/queues/cli-exec/resolvers.js';
import { isTransientCliFailure } from '../src/queues/cli-exec/failure-class.js';
import { CUSTOM_TOOL_INVALID_REASON } from '../src/step-engine/step-runner.js';
import {
  CUSTOM_MCP_SERVER_JS,
  CUSTOM_MCP_SERVER_PATH,
  CUSTOM_MCP_TOKEN_PATH,
  CUSTOM_MCP_TOOLS_PATH,
} from '../src/sandbox/custom-mcp-server.js';
import { api, content, runCleanups, start } from './support/custom-mcp-process.js';

vi.mock('../src/lsp/configured-lsp.js', () => ({ hasReadyLspBridge: async () => false }));

const afterSurface = vi.hoisted(() => ({ run: undefined as (() => void) | undefined }));
vi.mock('../src/sandbox/mcp-surface.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sandbox/mcp-surface.js')>();
  return {
    ...actual,
    resolveMcpSurface: async (...args: Parameters<typeof actual.resolveMcpSurface>) => {
      const surface = await actual.resolveMcpSurface(...args);
      afterSurface.run?.();
      return surface;
    },
  };
});

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

const SECRET = 'custom-mcp-wiring-test-secret';
const NOW_MS = 1_800_000_000_000;
const STEP_ID = 'custom.demo.audit';

const repoStatus = {
  name: 'repo_status',
  description: 'Fetches the status of one repository.',
  action: 'http-get',
  url: 'https://api.example.com/v1/repos/{repo}/status',
  params: [{ name: 'repo', type: 'string', description: 'Repository slug.', required: true }],
};
const houseRules = {
  name: 'house_rules',
  description: 'Searches the house rules.',
  action: 'rag-query',
  scope: 'global',
};
const pinned = (tools: unknown[]) => ({
  [STEP_ID]: {
    slug: 'audit',
    title: 'Audit',
    template: 'Audit {{task.title}}',
    capabilities: [],
    timeoutMs: 300_000,
    tools,
  },
});

function dbFor(customSteps: unknown, stepId = STEP_ID, stepRow = true): Database {
  return {
    query: {
      tasks: {
        findFirst: async () => ({ envTemplateId: null, repositoryId: null, customSteps }),
      },
      envTemplates: { findFirst: async () => undefined },
      taskSteps: { findFirst: async () => (stepRow ? { output: null, stepId } : undefined) },
      repositories: { findFirst: async () => undefined },
    },
  } as unknown as Database;
}

type Run = NonNullable<Parameters<typeof resolveMcpExtraFiles>[9]>;
const run = (over: Partial<CliExecJobPayload> = {}): Run => ({
  customTools: ['repo_status', 'house_rules'],
  invocationId: 'inv-1',
  taskStepId: 'ts-1',
  timeoutMs: 600_000,
  ...over,
});

type Provider = 'claude-code' | 'codex' | 'gemini' | 'antigravity';
type Files = Array<{ containerPath: string; content: string }>;
type Entry = { command: string; args: string[]; env?: Record<string, string> };

const extra = (
  provider: Provider,
  db: Database,
  forRun?: Run,
  profile: 'full' | 'rag_only' | 'none' = 'full',
) =>
  resolveMcpExtraFiles(
    db,
    'task-1',
    provider,
    '/haive/workdir',
    'img:tag',
    profile,
    false,
    true,
    null,
    forRun,
  );

const ENTRY: Entry = {
  command: 'node',
  args: ['/haive/haive-custom-mcp.mjs'],
  env: { CUSTOM_MCP_API_URL: 'http://api:3001' },
};

/** The haive-custom entry as the provider's own delivery carries it. */
async function entryOf(
  provider: Provider,
  db: Database,
  forRun?: Run,
): Promise<{ entry: Entry | undefined; files: Files }> {
  merged.cli.length = 0;
  merged.gemini.length = 0;
  const { files } = await extra(provider, db, forRun);
  if (provider === 'claude-code') {
    const config = files.find((f) => f.containerPath === '/haive/mcp.json');
    const servers = (JSON.parse(config!.content) as { mcpServers: Record<string, Entry> })
      .mcpServers;
    return { entry: servers['haive-custom'], files };
  }
  if (provider === 'gemini') {
    const servers = merged.gemini[0]![1] as Record<string, Entry>;
    return { entry: servers['haive-custom'], files };
  }
  const servers = merged.cli[0]![3] as Array<{ name: string } & Entry>;
  const spec = servers.find((s) => s.name === 'haive-custom');
  return { entry: spec && { command: spec.command, args: spec.args, env: spec.env }, files };
}

/** The message a run fails with when it names tools it cannot wire; nothing of it reaches the task volume. */
async function unwired(provider: Provider, db: Database, forRun: Run): Promise<string> {
  merged.cli.length = 0;
  merged.gemini.length = 0;
  const failure = await extra(provider, db, forRun).catch((err: unknown) => err);
  expect(failure).toBeInstanceOf(Error);
  expect(merged).toEqual({ cli: [], gemini: [] });
  const message = (failure as Error).message;
  expect(message.startsWith(`${CUSTOM_TOOLS_UNWIRED_REASON}: `)).toBe(true);
  expect(isTransientCliFailure({ exitCode: -1, errorMessage: message })).toBe(false);
  return message;
}

/** The message a run fails with when a pinned tool no longer passes its checks; nothing of it reaches the task volume. */
async function invalid(provider: Provider, db: Database, forRun: Run): Promise<string> {
  merged.cli.length = 0;
  merged.gemini.length = 0;
  const failure = await extra(provider, db, forRun).catch((err: unknown) => err);
  expect(failure).toBeInstanceOf(Error);
  expect(merged).toEqual({ cli: [], gemini: [] });
  expect(writers.file).toEqual([]);
  const message = (failure as Error).message;
  expect(message.startsWith(`${CUSTOM_TOOL_INVALID_REASON}: `)).toBe(true);
  expect(isTransientCliFailure({ exitCode: -1, errorMessage: message })).toBe(false);
  return message;
}

/** The message a run fails with when its CLI's configuration did not land in the task volume. */
async function notWritten(provider: Provider, db: Database, forRun: Run): Promise<string> {
  merged.cli.length = 0;
  merged.gemini.length = 0;
  const failure = await extra(provider, db, forRun).catch((err: unknown) => err);
  expect(failure).toBeInstanceOf(Error);
  const message = (failure as Error).message;
  expect(message.startsWith(`${CUSTOM_TOOLS_UNWIRED_REASON}: `)).toBe(true);
  expect(isTransientCliFailure({ exitCode: -1, errorMessage: message })).toBe(false);
  return message;
}

const switchOff = () =>
  vi
    .mocked(configService.getBoolean)
    .mockImplementation(async (key) => key !== CONFIG_KEYS.CUSTOM_MCP_TOOLS_ENABLED);

const fileAt = (files: Files, path: string) => files.find((f) => f.containerPath === path)?.content;
const toolsIn = (files: Files) =>
  JSON.parse(fileAt(files, CUSTOM_MCP_TOOLS_PATH)!) as Array<{ name: string }>;
const claimsIn = (files: Files) =>
  verifyTaskToken(fileAt(files, CUSTOM_MCP_TOKEN_PATH)!, 'custom-mcp', SECRET);

const CUSTOM_PATHS = [CUSTOM_MCP_SERVER_PATH, CUSTOM_MCP_TOOLS_PATH, CUSTOM_MCP_TOKEN_PATH];

beforeEach(() => {
  process.env.CONFIG_ENCRYPTION_KEY = SECRET;
  delete process.env.RAG_API_INTERNAL_URL;
  writers.landed = true;
  writers.file.length = 0;
  vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
  vi.spyOn(configService, 'getNumber').mockImplementation(async (_key, fallback = 0) => fallback);
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
});

afterEach(async () => {
  await runCleanups();
  afterSurface.run = undefined;
  forced.delivery = undefined;
  vi.restoreAllMocks();
  delete process.env.CONFIG_ENCRYPTION_KEY;
  delete process.env.RAG_API_INTERNAL_URL;
});

describe.each<Provider>(['claude-code', 'codex', 'gemini'])(
  'the haive-custom server of a step with tools, for %s',
  (provider) => {
    const db = () => dbFor(pinned([repoStatus, houseRules]));

    it('gets the entry, with the address of the API and no token or per-invocation value', async () => {
      const { entry, files } = await entryOf(provider, db(), run());
      expect(entry).toEqual(ENTRY);
      const written = JSON.stringify(entry);
      expect(written).not.toContain(fileAt(files, CUSTOM_MCP_TOKEN_PATH));
      expect(written).not.toContain('inv-1');
      expect(written).not.toContain('ts-1');
    });

    it('gets the script, the tool list and the token as three files', async () => {
      const { files } = await entryOf(provider, db(), run());
      for (const path of CUSTOM_PATHS) {
        expect(
          files.filter((f) => f.containerPath === path),
          path,
        ).toHaveLength(1);
      }
      expect(fileAt(files, CUSTOM_MCP_SERVER_PATH)).toBe(CUSTOM_MCP_SERVER_JS);
      expect(JSON.parse(fileAt(files, CUSTOM_MCP_TOOLS_PATH)!)).toEqual([
        {
          name: 'repo_status',
          description: repoStatus.description,
          inputSchema: {
            type: 'object',
            properties: {
              repo: { type: 'string', description: 'Repository slug.', maxLength: 128 },
            },
            required: ['repo'],
          },
        },
        {
          name: 'house_rules',
          description: houseRules.description,
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'What to search for.', maxLength: 500 },
            },
            required: ['query'],
          },
        },
      ]);
    });

    it('gets a token whose verified claims carry that invocation, that step and the audience', async () => {
      const { files } = await entryOf(provider, db(), run());
      const token = fileAt(files, CUSTOM_MCP_TOKEN_PATH)!;
      expect(verifyTaskToken(token, 'custom-mcp', SECRET)).toEqual({
        aud: 'custom-mcp',
        taskId: 'task-1',
        taskStepId: 'ts-1',
        cliInvocationId: 'inv-1',
        exp: NOW_MS / 1000 + 600 + 15 * 60,
      });
      expect(verifyTaskToken(token, 'rag', SECRET)).toBeNull();
      expect(verifyTaskToken(token, 'ddev', SECRET)).toBeNull();
      expect(verifyTaskToken(token, 'custom-mcp', 'another-secret')).toBeNull();
    });

    it('gives two invocations of one task a byte-identical entry and each its own token', async () => {
      const first = await entryOf(provider, db(), run({ invocationId: 'inv-1' }));
      const second = await entryOf(provider, db(), run({ invocationId: 'inv-2' }));
      expect(first.entry).toEqual(ENTRY);
      expect(JSON.stringify(second.entry)).toBe(JSON.stringify(first.entry));
      expect(claimsIn(first.files)?.cliInvocationId).toBe('inv-1');
      expect(claimsIn(second.files)?.cliInvocationId).toBe('inv-2');
      expect(fileAt(second.files, CUSTOM_MCP_TOKEN_PATH)).not.toBe(
        fileAt(first.files, CUSTOM_MCP_TOKEN_PATH),
      );
      expect(fileAt(second.files, CUSTOM_MCP_TOOLS_PATH)).toBe(
        fileAt(first.files, CUSTOM_MCP_TOOLS_PATH),
      );
    });

    it('gives no server, file or token to a run that names no tools', async () => {
      for (const forRun of [undefined, run({ customTools: undefined }), run({ customTools: [] })]) {
        const { entry, files } = await entryOf(provider, db(), forRun);
        expect(entry).toBeUndefined();
        for (const path of CUSTOM_PATHS) expect(fileAt(files, path), path).toBeUndefined();
        expect(files.map((f) => f.content).join('\n')).not.toContain('haive-custom');
      }
      expect(vi.mocked(configService.getBoolean).mock.calls.map(([key]) => key)).not.toContain(
        CONFIG_KEYS.CUSTOM_MCP_TOOLS_ENABLED,
      );
    });

    it('wires only the tools the run names', async () => {
      const { files } = await entryOf(provider, db(), run({ customTools: ['house_rules'] }));
      expect(toolsIn(files).map((t) => t.name)).toEqual(['house_rules']);
    });

    it('fails a run whose tools the pinned step does not define, naming them', async () => {
      const message = await unwired(provider, db(), run({ customTools: ['gone', 'lost'] }));
      expect(message).toContain('none of them pinned');
      expect(message).toContain('gone, lost');
    });

    it('fails a run that names a tool the pinned step does not define beside one it does', async () => {
      const message = await unwired(provider, db(), run({ customTools: ['house_rules', 'gone'] }));
      expect(message).toContain('the step does not pin gone');
      expect(message).toContain('house_rules, gone');
    });

    it('fails a run that is not tied to a step, naming the tools', async () => {
      const message = await unwired(provider, db(), run({ taskStepId: null }));
      expect(message).toContain('not tied to a step');
      expect(message).toContain('repo_status, house_rules');
    });

    it('fails a run whose step row is gone, naming the tools', async () => {
      const gone = dbFor(pinned([repoStatus, houseRules]), STEP_ID, false);
      const message = await unwired(provider, gone, run());
      expect(message).toContain('no longer exists');
      expect(message).toContain('repo_status, house_rules');
    });

    it('fails a run, naming the secret and the tools, when nothing can sign the token', async () => {
      delete process.env.CONFIG_ENCRYPTION_KEY;
      const message = await unwired(provider, db(), run());
      expect(message).toContain('CONFIG_ENCRYPTION_KEY');
      expect(message).toContain('repo_status, house_rules');
    });

    it('fails a run, naming the switch and the tools, when custom tools are switched off', async () => {
      switchOff();
      const message = await unwired(provider, db(), run());
      expect(message).toContain('custom tools are switched off on this install');
      expect(message).toContain('repo_status, house_rules');
    });

    it('names the switch, not the secret, when both are gone', async () => {
      switchOff();
      delete process.env.CONFIG_ENCRYPTION_KEY;
      const message = await unwired(provider, db(), run());
      expect(message).toContain('switched off');
      expect(message).not.toContain('CONFIG_ENCRYPTION_KEY');
    });

    // These parse; they fail the checks a save runs today.
    it.each([
      [
        'a name kept for Haive',
        [repoStatus, { ...houseRules, name: 'rag_search' }],
        '`rag_search`',
        'kept for Haive',
      ],
      [
        'a URL the guard refuses',
        [repoStatus, { ...repoStatus, name: 'local_status', url: 'https://127.0.0.1/v1/status' }],
        '`local_status`',
        'is an IP address',
      ],
      [
        'one name twice',
        [repoStatus, { ...houseRules, name: 'repo_status' }],
        '`repo_status`',
        'Two tools in this step are named repo_status',
      ],
    ])(
      'fails a run whose pinned tools hold %s, naming the tool and the issue, before anything is written',
      async (_label, tools, named, issue) => {
        const customTools = [...new Set(tools.map((tool) => tool.name))];
        const message = await invalid(provider, dbFor(pinned(tools)), run({ customTools }));
        expect(message).toContain(named);
        expect(message).toContain(issue);
      },
    );

    it('judges every tool the step pinned, as the dispatch check does, not only the ones the run names', async () => {
      const tools = [repoStatus, { ...houseRules, name: 'rag_search' }];
      const message = await invalid(
        provider,
        dbFor(pinned(tools)),
        run({ customTools: ['repo_status'] }),
      );
      expect(message).toContain('`rag_search`');
    });

    it('words the failure as the dispatch check does', async () => {
      const reserved = { ...houseRules, name: 'rag_search' };
      const message = await invalid(
        provider,
        dbFor(pinned([reserved])),
        run({ customTools: ['rag_search'] }),
      );
      const [problem] = validateCustomTools([customToolSchema.parse(reserved)], {
        requiresRepository: true,
      });
      expect(message).toBe(
        `${CUSTOM_TOOL_INVALID_REASON}: this step's tools no longer pass their checks: \`rag_search\`: ${problem!.message} The task pinned them when it was created; fix them in the task type and start a new task.`,
      );
    });

    it('names at most 8 of the problems of the pinned tools, then how many more', async () => {
      const insecure = Array.from({ length: 8 }, (_, i) => ({
        ...repoStatus,
        name: `tool_${i}`,
        url: 'http://127.0.0.1/v1/status',
        params: [],
      }));
      const customTools = insecure.map((tool) => tool.name);
      const message = await invalid(provider, dbFor(pinned(insecure)), run({ customTools }));
      expect(message).toContain('`tool_3`');
      expect(message).not.toContain('`tool_4`');
      expect(message).toContain('And 8 more.');
    });

    it('wires a pinned project-scope search, since the type that allowed it is not known here', async () => {
      const tool = { ...houseRules, name: 'project_rules', scope: 'project' };
      const { files } = await extra(
        provider,
        dbFor(pinned([tool])),
        run({ customTools: ['project_rules'] }),
      );
      expect(toolsIn(files).map((t) => t.name)).toEqual(['project_rules']);
    });

    it('wires a run while the switch is on, reading it as the step runner does', async () => {
      const { entry } = await entryOf(provider, db(), run());
      expect(entry).toEqual(ENTRY);
      expect(configService.getBoolean).toHaveBeenCalledWith(
        CONFIG_KEYS.CUSTOM_MCP_TOOLS_ENABLED,
        true,
      );
    });
  },
);

describe.each<Provider>(['codex', 'gemini'])(
  'the CLI configuration of a step with tools, for %s, in a task volume that does not take it',
  (provider) => {
    const db = () => dbFor(pinned([repoStatus, houseRules]));

    it('fails a run that names tools, naming the cause and the tools', async () => {
      writers.landed = false;
      const message = await notWritten(provider, db(), run());
      expect(message).toContain(
        "the CLI's MCP configuration could not be written to its task volume",
      );
      expect(message).toContain('repo_status, house_rules');
    });

    it('lets a run that names no tools go on, as the other servers always could', async () => {
      writers.landed = false;
      for (const forRun of [undefined, run({ customTools: undefined }), run({ customTools: [] })]) {
        merged.cli.length = 0;
        merged.gemini.length = 0;
        const { files } = await extra(provider, db(), forRun);
        expect(merged.cli.length + merged.gemini.length).toBe(1);
        for (const path of CUSTOM_PATHS) expect(fileAt(files, path), path).toBeUndefined();
      }
    });
  },
);

describe('a CLI whose configuration is bound into each invocation', () => {
  it('wires a run whatever the volume writers report', async () => {
    writers.landed = false;
    const { entry } = await entryOf('claude-code', dbFor(pinned([repoStatus, houseRules])), run());
    expect(entry).toEqual(ENTRY);
  });
});

describe('a CLI whose configuration file is written whole into its task volume', () => {
  const db = () => dbFor(pinned([repoStatus, houseRules]));

  it('fails a run whose file did not land, naming the cause and the tools', async () => {
    forced.delivery = 'volume-write';
    writers.landed = false;
    const message = await notWritten('antigravity', db(), run());
    expect(writers.file).toHaveLength(1);
    expect(message).toContain(
      "the CLI's MCP configuration could not be written to its task volume",
    );
    expect(message).toContain('repo_status, house_rules');
  });

  it('fails a run whose pinned tool no longer passes its checks before it writes the file', async () => {
    forced.delivery = 'volume-write';
    const tools = [repoStatus, { ...houseRules, name: 'rag_search' }];
    const customTools = ['repo_status', 'rag_search'];
    await invalid('antigravity', dbFor(pinned(tools)), run({ customTools }));
    expect(writers.file).toEqual([]);
  });

  it('wires a run whose file landed', async () => {
    forced.delivery = 'volume-write';
    const { files } = await extra('antigravity', db(), run());
    expect(writers.file).toHaveLength(1);
    expect(toolsIn(files).map((t) => t.name)).toEqual(['repo_status', 'house_rules']);
  });

  it('lets a run that names no tools go on when its file did not land', async () => {
    forced.delivery = 'volume-write';
    writers.landed = false;
    const { files } = await extra('antigravity', db(), run({ customTools: undefined }));
    expect(writers.file).toHaveLength(1);
    for (const path of CUSTOM_PATHS) expect(fileAt(files, path), path).toBeUndefined();
  });
});

describe('the files of a step with tools, served as the sandbox serves them', () => {
  it('lists the tools it was given and calls the API with the token it was given', async () => {
    const { files } = await entryOf('claude-code', dbFor(pinned([repoStatus, houseRules])), run());
    const stub = await api(() => ({
      status: 200,
      body: '{"ok":true,"text":"HTTP 200 text/plain"}',
    }));
    const { ask } = await start({
      script: fileAt(files, CUSTOM_MCP_SERVER_PATH),
      tools: fileAt(files, CUSTOM_MCP_TOOLS_PATH),
      token: fileAt(files, CUSTOM_MCP_TOKEN_PATH),
      apiUrl: stub.url,
    });
    await ask('initialize');
    const listed = (await ask('tools/list')).result as { tools: Array<{ name: string }> };
    expect(listed.tools.map((t) => t.name)).toEqual(['repo_status', 'house_rules']);
    const reply = await ask('tools/call', { name: 'repo_status', arguments: { repo: 'haive' } });
    expect(reply.result?.isError).toBe(false);
    expect(content(reply)).toBe('HTTP 200 text/plain');
    expect(stub.seen).toHaveLength(1);
    expect(stub.seen[0]!.url).toBe('/custom-mcp/call');
    expect(stub.seen[0]!.body).toEqual({ tool: 'repo_status', arguments: { repo: 'haive' } });
    const bearer = stub.seen[0]!.authorization!.replace(/^Bearer /, '');
    expect(verifyTaskToken(bearer, 'custom-mcp', SECRET)).toMatchObject({
      taskId: 'task-1',
      taskStepId: 'ts-1',
      cliInvocationId: 'inv-1',
    });
  });
});

describe('the token lifetime', () => {
  const lifetime = async (forRun: Run) => {
    const { files } = await extra('claude-code', dbFor(pinned([repoStatus, houseRules])), forRun);
    return claimsIn(files)!.exp - NOW_MS / 1000;
  };

  it("is the invocation's timeout plus 15 minutes when the timeout is at hand", async () => {
    expect(await lifetime(run({ timeoutMs: 1_800_500 }))).toBe(1801 + 900);
  });

  it('is the default lifetime of a task token when the invocation carries no timeout', async () => {
    expect(await lifetime(run({ timeoutMs: undefined }))).toBe(24 * 60 * 60);
  });
});

describe('the pinned step', () => {
  it('is read for the step of the invocation, not for any other', async () => {
    const other = dbFor(pinned([repoStatus]), 'custom.demo.other');
    expect(await unwired('claude-code', other, run())).toContain('none of them pinned');
  });

  it('keeps the tools that parse when another no longer does', async () => {
    const broken = { ...repoStatus, name: 'stale', description: 'd'.repeat(1025) };
    const db = dbFor(pinned([repoStatus, broken]));
    const { files } = await extra('claude-code', db, run({ customTools: ['repo_status'] }));
    expect(toolsIn(files).map((t) => t.name)).toEqual(['repo_status']);
  });

  it('is not read at all for a run that names no tools', async () => {
    const asked: Array<Record<string, boolean> | undefined> = [];
    const db = {
      query: {
        tasks: {
          findFirst: async () => ({
            envTemplateId: null,
            customSteps: pinned([repoStatus, houseRules]),
          }),
        },
        envTemplates: { findFirst: async () => undefined },
        taskSteps: {
          findFirst: async (arg?: { columns?: Record<string, boolean> }) => {
            asked.push(arg?.columns);
            return { output: null, stepId: STEP_ID };
          },
        },
        repositories: { findFirst: async () => undefined },
      },
    } as unknown as Database;
    await extra('claude-code', db, run({ customTools: undefined }));
    expect(asked.filter((columns) => columns?.stepId === true)).toEqual([]);
    await extra('claude-code', db, run());
    expect(asked.filter((columns) => columns?.stepId === true)).toHaveLength(1);
  });
});

describe('the API address', () => {
  it('follows RAG_API_INTERNAL_URL, as the haive-rag server does', async () => {
    process.env.RAG_API_INTERNAL_URL = 'http://host.docker.internal:3001';
    const { entry } = await entryOf('claude-code', dbFor(pinned([repoStatus, houseRules])), run());
    expect(entry?.env).toEqual({ CUSTOM_MCP_API_URL: 'http://host.docker.internal:3001' });
  });

  it('is the one the shared surface carries, whatever the environment says afterwards', async () => {
    process.env.RAG_API_INTERNAL_URL = 'http://surface-a.invalid:3001';
    afterSurface.run = () => {
      process.env.RAG_API_INTERNAL_URL = 'http://env-b.invalid:3001';
    };
    const { entry } = await entryOf('claude-code', dbFor(pinned([repoStatus, houseRules])), run());
    expect(entry?.env).toEqual({ CUSTOM_MCP_API_URL: 'http://surface-a.invalid:3001' });
  });
});

describe('a profile that wires nothing', () => {
  it("returns no custom file for profile 'none'", async () => {
    const { files, extraArgs } = await extra(
      'claude-code',
      dbFor(pinned([repoStatus])),
      run(),
      'none',
    );
    expect(files).toEqual([]);
    expect(extraArgs).toEqual([]);
  });
});
