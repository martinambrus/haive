import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLI_PROVIDER_LIST } from '@haive/shared';
import {
  InventoryAnchorError,
  inventoryDirsFromCatalog,
  scanInstalledTooling,
} from './tool-inventory.js';

// The scan reads NAMES off a tree sandboxed agents write, through the link-refusing readers.
// A temp tree stands in for a repository root: two CLIs' agent dirs, one skills dir, a link
// pointing outside, a skill dir with no SKILL.md, and no `.grok/` at all.
describe('scanInstalledTooling', () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'tooling-'));
    outside = await mkdtemp(path.join(tmpdir(), 'tooling-out-'));
    await mkdir(path.join(root, '.claude/agents'), { recursive: true });
    await mkdir(path.join(root, '.codex/agents'), { recursive: true });
    await mkdir(path.join(root, '.claude/skills/dataviz'), { recursive: true });
    await mkdir(path.join(root, '.claude/skills/broken'), { recursive: true });
    await mkdir(path.join(root, '.claude/skills/linked'), { recursive: true });
    await writeFile(path.join(root, '.claude/agents/code-reviewer.md'), '# reviewer', 'utf8');
    await writeFile(path.join(root, '.claude/agents/README.md'), '# index', 'utf8');
    await writeFile(path.join(root, '.claude/agents/notes.txt'), 'x', 'utf8');
    await writeFile(path.join(root, '.codex/agents/code-reviewer.toml'), 'name = "r"', 'utf8');
    await writeFile(path.join(root, '.codex/agents/stray.md'), '# wrong ext here', 'utf8');
    await writeFile(path.join(root, '.claude/skills/dataviz/SKILL.md'), '# dataviz', 'utf8');
    await writeFile(path.join(outside, 'secret.md'), 'secret', 'utf8');
    await writeFile(path.join(outside, 'SKILL.md'), '# outside skill', 'utf8');
    await symlink(path.join(outside, 'secret.md'), path.join(root, '.claude/agents/link.md'));
    await symlink(
      path.join(outside, 'SKILL.md'),
      path.join(root, '.claude/skills/linked/SKILL.md'),
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('lists personas and skills by file name, merging one id across CLI directories', async () => {
    const scan = await scanInstalledTooling(root);
    expect(scan.items).toEqual([
      {
        kind: 'agent',
        id: 'code-reviewer',
        paths: ['.claude/agents/code-reviewer.md', '.codex/agents/code-reviewer.toml'],
      },
      { kind: 'skill', id: 'dataviz', paths: ['.claude/skills/dataviz/SKILL.md'] },
    ]);
    expect(scan.dirsScanned).toEqual(['.claude/agents', '.codex/agents', '.claude/skills']);
    // The agent link and the skill link: counted, never followed, never listed.
    expect(scan.skippedLinks).toBe(2);
    expect(scan.truncated).toBe(false);
  });

  it('treats a linked directory as a link, not as an installed set', async () => {
    await mkdir(path.join(outside, 'agents'), { recursive: true });
    await writeFile(path.join(outside, 'agents/planted.md'), '# planted', 'utf8');
    // `.grok` itself is the link, so both `.grok/agents` and `.grok/skills` resolve through it.
    await symlink(path.join(outside, 'agents'), path.join(root, '.grok'));
    const scan = await scanInstalledTooling(root);
    expect(scan.items.some((i) => i.id === 'planted')).toBe(false);
    expect(scan.skippedLinks).toBeGreaterThanOrEqual(3);
  });

  it('refuses an anchor that is not a readable directory rather than reporting nothing installed', async () => {
    await expect(scanInstalledTooling(path.join(root, 'missing'))).rejects.toBeInstanceOf(
      InventoryAnchorError,
    );
    await expect(
      scanInstalledTooling(path.join(root, '.claude/agents/code-reviewer.md')),
    ).rejects.toBeInstanceOf(InventoryAnchorError);
  });

  it('reads an empty repository as nothing installed', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'tooling-empty-'));
    try {
      expect(await scanInstalledTooling(empty)).toEqual({
        items: [],
        dirsScanned: [],
        skippedLinks: 0,
        truncated: false,
      });
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});

describe('inventoryDirsFromCatalog', () => {
  it('covers every agent and skills directory the catalog names, agents first', () => {
    const dirs = inventoryDirsFromCatalog();
    const agentDirs = dirs.filter((d) => d.kind === 'agent').map((d) => d.dir);
    const skillDirs = dirs.filter((d) => d.kind === 'skill').map((d) => d.dir);
    for (const provider of CLI_PROVIDER_LIST) {
      if (provider.projectAgentsDir !== null)
        expect(agentDirs).toContain(provider.projectAgentsDir);
      expect(skillDirs).toContain(provider.projectSkillsDir);
    }
    expect(new Set(agentDirs).size).toBe(agentDirs.length);
    expect(new Set(skillDirs).size).toBe(skillDirs.length);
    expect(dirs.findIndex((d) => d.kind === 'skill')).toBe(agentDirs.length);
    const codex = dirs.find((d) => d.dir === '.codex/agents');
    expect(codex).toMatchObject({ kind: 'agent', ext: 'toml' });
  });
});
