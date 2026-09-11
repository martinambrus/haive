import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mcpSettingsDefaultFor } from '../src/step-engine/steps/onboarding/04-tooling-infrastructure.js';

// 04 writes `.claude/mcp_settings.json` from this field verbatim, and it runs BEFORE
// 07-generate-files' `writeIfAllowed` gate — so a field defaulted to a build-time
// constant dropped every server the user had added, at a gate that showed them a config
// that was not theirs.

const servers = async (dir: string): Promise<string[]> =>
  Object.keys(JSON.parse(await mcpSettingsDefaultFor(dir)).mcpServers).sort();

const writeSettings = async (dir: string, body: string): Promise<void> => {
  await mkdir(path.join(dir, '.claude'), { recursive: true });
  await writeFile(path.join(dir, '.claude/mcp_settings.json'), body);
};

describe('mcpSettingsDefaultFor', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'haive-mcpdef-'));
    for (const n of ['fresh', 'managed-only', 'custom', 'broken', 'stale', 'no-servers']) {
      await mkdir(path.join(dir, n), { recursive: true });
    }
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is the managed set when the repo has no file yet', async () => {
    expect(await servers(path.join(dir, 'fresh'))).toEqual(['chrome-devtools']);
  });

  // Every repo on this install has exactly the managed set, so this is the common path
  // and it must not render a single byte differently from before.
  it('returns the constant VERBATIM when the repo adds nothing', async () => {
    const fresh = await mcpSettingsDefaultFor(path.join(dir, 'fresh'));
    const repo = path.join(dir, 'managed-only');
    await writeSettings(repo, fresh);
    expect(await mcpSettingsDefaultFor(repo)).toBe(fresh);
  });

  it('keeps a server the user added', async () => {
    const repo = path.join(dir, 'custom');
    await writeSettings(
      repo,
      JSON.stringify({
        mcpServers: {
          'chrome-devtools': { command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'] },
          postgres: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres'] },
        },
      }),
    );
    expect(await servers(repo)).toEqual(['chrome-devtools', 'postgres']);
  });

  // The managed entry's args track the sandbox image, so a stale copy is BROKEN rather
  // than merely old — a committed `--channel=stable` asks for a Chrome the image does
  // not ship. It is refreshed while the user's own servers are preserved.
  it('refreshes the managed entry rather than preserving a stale one', async () => {
    const repo = path.join(dir, 'stale');
    await writeSettings(
      repo,
      JSON.stringify({
        mcpServers: {
          'chrome-devtools': {
            command: 'npx',
            args: ['-y', 'chrome-devtools-mcp@latest', '--channel=stable'],
          },
          filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] },
        },
      }),
    );
    const merged = JSON.parse(await mcpSettingsDefaultFor(repo));
    expect(merged.mcpServers['chrome-devtools'].args).toContain(
      '--executable-path=/usr/bin/chromium',
    );
    expect(merged.mcpServers['chrome-devtools'].args).not.toContain('--channel=stable');
    expect(merged.mcpServers.filesystem).toBeDefined();
  });

  it('falls back to the managed set when the file cannot be parsed', async () => {
    const repo = path.join(dir, 'broken');
    await writeSettings(repo, '{ this is not json');
    expect(await servers(repo)).toEqual(['chrome-devtools']);
  });

  it('falls back when the file parses but names no servers', async () => {
    const repo = path.join(dir, 'no-servers');
    await writeSettings(repo, '{"other":1}');
    expect(await servers(repo)).toEqual(['chrome-devtools']);
  });
});
