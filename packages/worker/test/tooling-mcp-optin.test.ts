import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { DEFAULT_MCP_SETTINGS_JSON, mcpSettingsFileContent } from '../src/sandbox/mcp-config.js';
import type { StepContext } from '../src/step-engine/step-definition.js';
import {
  mcpServersFingerprint,
  repoOwnedMcpServers,
  toolingInfrastructureStep,
} from '../src/step-engine/steps/onboarding/04-tooling-infrastructure.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000b1';
const TASK = '00000000-0000-4000-8000-0000000000c1';

const managed = (JSON.parse(DEFAULT_MCP_SETTINGS_JSON) as { mcpServers: Record<string, unknown> })
  .mcpServers;
const postgres = { command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres'] };
const serverNames = (json: unknown): string[] =>
  Object.keys((JSON.parse(json as string) as { mcpServers: object }).mcpServers).sort();

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tooling-mcp-optin-'));
  dirs.push(root);
  await mkdir(join(root, '.claude'), { recursive: true });
  const settings = join(root, '.claude/mcp_settings.json');
  const writeServers = (servers: Record<string, unknown>) =>
    writeFile(settings, JSON.stringify({ mcpServers: { ...managed, ...servers } }));
  await writeServers({ postgres });
  const fake = createFakeDb({ tasks: schema.tasks, repositories: schema.repositories });
  fake.insert(schema.repositories, { id: REPO, userId: USER, name: 'r', onboardingTooling: null });
  fake.insert(schema.tasks, { id: TASK, userId: USER, repositoryId: REPO });
  const noop = () => undefined;
  const ctx = {
    db: fake.db,
    repoPath: root,
    taskId: TASK,
    userId: USER,
    cliProviderId: null,
    logger: { info: noop, warn: noop, error: noop, debug: noop },
  } as unknown as StepContext;
  // What 04's detect records beside the names it shows.
  const shown = mcpServersFingerprint(await repoOwnedMcpServers(root));
  const apply = async (
    keepRepoMcpServers: boolean,
    detected: Record<string, unknown> = { repoOwnedMcpServersFingerprint: shown },
  ) =>
    (await toolingInfrastructureStep.apply(ctx, {
      detected: { cliSupportsLsp: false, ...detected },
      formValues: {
        mcpSettingsJson: DEFAULT_MCP_SETTINGS_JSON,
        keepRepoMcpServers,
        rtkEnabled: true,
      },
    } as never)) as { tooling: Record<string, unknown> };
  const file = () => readFile(settings, 'utf8');
  const column = () => fake.rows(schema.repositories)[0]!.onboardingTooling;
  return { apply, writeServers, file, column };
}

// The runtime reads the servers from 04's output and then the repository column, never from the
// file, and 07 with overwrite on rewrites the file from 04's output. So the list the person opted
// into has to be the recorded one, or the file is the only place it ever reaches.
describe('04 records the MCP servers it writes', () => {
  it('records the repository servers the person opted to keep', async () => {
    const f = await fixture();
    const out = await f.apply(true);
    const file = await f.file();
    expect(serverNames(file)).toEqual(['chrome-devtools', 'postgres']);
    expect(serverNames(out.tooling.mcpSettingsJson)).toEqual(['chrome-devtools', 'postgres']);
    expect(mcpSettingsFileContent(out.tooling.mcpSettingsJson as string)).toBe(file);
    // The boot repair holds a column no local 04 output equals.
    expect((f.column() as { tooling: unknown }).tooling).toEqual(out.tooling);
  });

  it('records what was typed when the person did not opt in', async () => {
    const f = await fixture();
    const out = await f.apply(false);
    expect(serverNames(await f.file())).toEqual(['chrome-devtools']);
    expect(out.tooling.mcpSettingsJson).toBe(DEFAULT_MCP_SETTINGS_JSON);
  });
});

// Consent was given to the definitions the form named. What reaches the runtime must be exactly
// those, so a file that changed while the form was parked is refused before anything is written.
describe('04 records only the servers its form named', () => {
  it('refuses a server added after the form was shown', async () => {
    const f = await fixture();
    await f.writeServers({ postgres, added: { command: '/bin/sh', args: ['-c', 'echo reached'] } });
    const before = await f.file();
    await expect(f.apply(true)).rejects.toThrow(/changed after this form was shown/);
    expect(await f.file()).toBe(before);
    expect(f.column()).toBeNull();
  });

  it('refuses a command changed under a name the form showed', async () => {
    const f = await fixture();
    await f.writeServers({ postgres: { command: '/bin/sh', args: ['-c', 'echo reached'] } });
    await expect(f.apply(true)).rejects.toThrow(/changed after this form was shown/);
    expect(f.column()).toBeNull();
  });

  it('refuses a form detected before the fingerprint was recorded', async () => {
    const f = await fixture();
    await expect(f.apply(true, {})).rejects.toThrow(/changed after this form was shown/);
  });
});
