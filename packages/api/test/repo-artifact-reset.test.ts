import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeContent, sha256Hex } from '@haive/shared';
import { lstatNoFollow } from '@haive/shared/fs-safe';
import { KB_DIR, LEARNINGS_DIR } from '@haive/shared/knowledge-paths';
import { inventoryDirsFromCatalog } from '../src/lib/tool-inventory.js';
import {
  checkOnboardingMarkers,
  resetOnboardingArtifacts,
  stripHaiveContent,
} from '../src/routes/repos.js';

const dirs: string[] = [];

/** A fresh tree per case. `mkdtemp` rather than a fixed name because the walk opens the ANCHOR
 *  itself and will not create it, so a leftover directory from an earlier run is the difference
 *  between a suite that passes here and one that fails on a clean runner. */
async function repo(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function installMarkers(root: string): Promise<void> {
  await mkdir(path.join(root, KB_DIR), { recursive: true });
  await mkdir(path.join(root, '.claude/agents'), { recursive: true });
  await mkdir(path.join(root, '.claude/skills'), { recursive: true });
  await writeFile(path.join(root, '.claude/workflow-config.json'), '{}', 'utf8');
}

describe('stripHaiveContent', () => {
  it('removes the marker regions and keeps the author text', async () => {
    const root = await repo('reset-strip-');
    await writeFile(
      path.join(root, 'AGENTS.md'),
      '# Mine\n\n<!-- haive:project-info -->\ngenerated\n<!-- /haive:project-info -->\n\nkeep me\n',
      'utf8',
    );

    expect(await stripHaiveContent(root, 'AGENTS.md')).toEqual({ changed: true, deleted: false });
    const left = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
    expect(left).toContain('# Mine');
    expect(left).toContain('keep me');
    expect(left).not.toContain('haive:project-info');
  });

  it('deletes a file that was nothing but Haive content', async () => {
    const root = await repo('reset-empty-');
    await writeFile(
      path.join(root, 'CLAUDE.md'),
      '<!-- haive:cli-rules -->\nrules\n<!-- /haive:cli-rules -->\n',
      'utf8',
    );

    expect(await stripHaiveContent(root, 'CLAUDE.md')).toEqual({ changed: true, deleted: true });
    await expect(readFile(path.join(root, 'CLAUDE.md'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('answers null for a file that is not there', async () => {
    // This is what replaced the caller's `pathExists` probe, which followed a link and read a
    // dangling one as absent.
    expect(await stripHaiveContent(await repo('reset-absent-'), 'GEMINI.md')).toBeNull();
  });

  it('refuses a rules file that is a link and leaves its target alone', async () => {
    // The write it replaced followed the link: a repo whose AGENTS.md pointed out of the tree had
    // the FILE ON THE OTHER END rewritten — and emptied out, deleted — by the artifact reset.
    const root = await repo('reset-link-');
    const outside = await repo('reset-link-out-');
    const target = path.join(outside, 'their-agents.md');
    await writeFile(
      target,
      '<!-- haive:cli-rules -->\ntheirs\n<!-- /haive:cli-rules -->\n',
      'utf8',
    );
    await symlink(target, path.join(root, 'AGENTS.md'));

    await expect(stripHaiveContent(root, 'AGENTS.md')).rejects.toMatchObject({ reason: 'link' });
    expect(await readFile(target, 'utf8')).toContain('haive:cli-rules');
  });
});

describe('checkOnboardingMarkers', () => {
  it('finds every marker an onboarding run installs', async () => {
    const root = await repo('markers-');
    await installMarkers(root);

    const { present, missing } = await checkOnboardingMarkers(root);
    expect(missing).toEqual([]);
    expect(present).toHaveLength(4);
  });

  it('does not count an agents directory that is a link', async () => {
    // The onboarded verdict and `mark-onboarded` both rest on these counts, and the `stat`-based
    // probe this replaced followed the link — so definitions living outside the tree counted as
    // installed, and the repo read as onboarded on the strength of them.
    const root = await repo('markers-link-');
    const outside = await repo('markers-link-out-');
    await installMarkers(root);
    await rm(path.join(root, '.claude/agents'), { recursive: true, force: true });
    await mkdir(path.join(outside, 'agents'), { recursive: true });
    await symlink(path.join(outside, 'agents'), path.join(root, '.claude/agents'));

    const { present, missing } = await checkOnboardingMarkers(root);
    expect(missing).toEqual(['.claude/agents']);
    expect(present).not.toContain('.claude/agents');
  });

  it('counts nothing for a repository root that is not there', async () => {
    const { present, missing } = await checkOnboardingMarkers('/definitely/not/a/path');
    expect(present).toEqual([]);
    expect(missing).toHaveLength(4);
  });
});

/** Everything an onboarding run leaves in a repository root, including one artifact per CLI the
 *  user never enabled: 07 writes to every catalog directory, and the reset that missed them is
 *  what these cases cover. */
async function installArtifacts(root: string): Promise<void> {
  for (const spec of inventoryDirsFromCatalog()) {
    await mkdir(path.join(root, spec.dir), { recursive: true });
    await writeFile(path.join(root, spec.dir, `code-reviewer.${spec.ext ?? 'md'}`), 'x\n', 'utf8');
  }
  await mkdir(path.join(root, KB_DIR), { recursive: true });
  await writeFile(path.join(root, KB_DIR, 'ARCHITECTURE.md'), 'kb\n', 'utf8');
  await mkdir(path.join(root, LEARNINGS_DIR), { recursive: true });
  await writeFile(path.join(root, '.claude/workflow-config.json'), '{}', 'utf8');
  await mkdir(path.join(root, '.haive'), { recursive: true });
  await writeFile(path.join(root, '.haive/install.json'), '{}', 'utf8');
  await writeFile(path.join(root, '.ripgreprc'), '--smart-case\n', 'utf8');
}

/** The two things a sweep of `.claude` must leave behind. */
async function installUserOwned(root: string): Promise<void> {
  await mkdir(path.join(root, '.claude/agents-legacy'), { recursive: true });
  await writeFile(path.join(root, '.claude/agents-legacy/mine.md'), 'mine\n', 'utf8');
  await writeFile(path.join(root, '.claude/mcp_settings.json'), '{"servers":{}}', 'utf8');
}

const exists = async (root: string, rel: string): Promise<boolean> =>
  (await lstatNoFollow(root, rel)) !== null;

/** What a repository with every CLI enabled and no per-file record looks like: the catalog dirs
 *  are all Haive's, and only the settings files carry a hash. */
function provenance(hashes: Array<[string, string]> = []): {
  writtenHashes: Map<string, string>;
  haiveDirs: Set<string>;
} {
  return {
    writtenHashes: new Map(hashes),
    haiveDirs: new Set(inventoryDirsFromCatalog().map((d) => d.dir)),
  };
}

describe('resetOnboardingArtifacts', () => {
  it('removes every CLI agents and skills directory, not just claude’s', async () => {
    // The list was `['.claude', KB_DIR, LEARNINGS_DIR]`, so the previous run's agents and skills
    // stayed on disk for every other CLI and the next run wrote on top of them.
    const root = await repo('reset-dirs-');
    await installArtifacts(root);

    const { removed } = await resetOnboardingArtifacts(root, provenance());

    for (const spec of inventoryDirsFromCatalog()) {
      expect(await exists(root, spec.dir), spec.dir).toBe(false);
      expect(removed).toContain(spec.dir);
    }
    expect(await exists(root, KB_DIR)).toBe(false);
    expect(await exists(root, LEARNINGS_DIR)).toBe(false);
    expect(await exists(root, '.ripgreprc')).toBe(false);
    expect(await exists(root, '.haive/install.json')).toBe(false);
    // Nothing of the user's was in it, so it goes whole, as it always did.
    expect(await exists(root, '.claude')).toBe(false);
  });

  it('keeps a CLI directory Haive never wrote to, and says so', async () => {
    // 07 writes agents to the ENABLED providers' dirs only, and `resolveSkillTargetDirs` does the
    // same for skills, so on a repo where codex was never enabled `.codex/agents` holds the
    // user's own definitions and nothing of ours. This action is irreversible.
    const root = await repo('reset-unproven-');
    await installArtifacts(root);
    const claudeOnly = {
      writtenHashes: new Map<string, string>(),
      haiveDirs: new Set(['.claude/agents', '.claude/skills']),
    };

    const { removed, skipped } = await resetOnboardingArtifacts(root, claudeOnly);

    expect(await exists(root, '.codex/agents/code-reviewer.toml')).toBe(true);
    expect(skipped).toContainEqual({
      path: '.codex/agents',
      reason: 'no record that Haive wrote here',
    });
    // Haive's own dirs still go, and so does everything outside the catalog.
    expect(await exists(root, '.claude')).toBe(false);
    expect(removed).toContain(KB_DIR);
  });

  it('removes a disabled provider’s directory when a live artifact row names it', async () => {
    // The enabled set is the CURRENT one; a provider enabled at onboarding and disabled since
    // still has rows naming its files, and those files are ours.
    const root = await repo('reset-proven-row-');
    await installArtifacts(root);

    const { removed } = await resetOnboardingArtifacts(root, {
      writtenHashes: new Map(),
      haiveDirs: new Set(['.codex/agents']),
    });

    expect(removed).toContain('.codex/agents');
    expect(await exists(root, '.codex/agents')).toBe(false);
  });

  it('keeps the quarantine and mcp_settings.json, and says so', async () => {
    const root = await repo('reset-keep-');
    await installArtifacts(root);
    await installUserOwned(root);

    const { skipped } = await resetOnboardingArtifacts(root, provenance());

    expect(await exists(root, '.claude/agents-legacy/mine.md')).toBe(true);
    expect(await exists(root, '.claude/mcp_settings.json')).toBe(true);
    expect(await exists(root, '.claude/workflow-config.json')).toBe(false);
    expect(skipped.map((s) => s.path)).toEqual(
      expect.arrayContaining(['.claude/agents-legacy', '.claude/mcp_settings.json']),
    );
    for (const entry of skipped) expect(entry.reason).not.toHaveLength(0);
  });

  it('takes a settings.json it wrote and leaves one it did not', async () => {
    // `writeIfAllowed` SKIPS an existing file, so the one on disk may never have been Haive's.
    // A live artifact row's written_hash is the only evidence either way.
    const root = await repo('reset-settings-');
    await installArtifacts(root);
    const ours = '{"hooks":{"rtk":true}}\n';
    await writeFile(path.join(root, '.claude/settings.json'), ours, 'utf8');
    await mkdir(path.join(root, '.gemini'), { recursive: true });
    await writeFile(path.join(root, '.gemini/settings.json'), '{"mine":true}\n', 'utf8');

    const { removed, skipped } = await resetOnboardingArtifacts(
      root,
      provenance([['.claude/settings.json', sha256Hex(normalizeContent(ours))]]),
    );

    expect(removed).toContain('.claude/settings.json');
    expect(await exists(root, '.gemini/settings.json')).toBe(true);
    expect(skipped).toContainEqual({
      path: '.gemini/settings.json',
      reason: 'not recorded as written by Haive',
    });
  });

  it('keeps a settings.json that was edited after Haive wrote it', async () => {
    const root = await repo('reset-settings-edited-');
    await installArtifacts(root);
    await writeFile(path.join(root, '.claude/settings.json'), '{"theirs":1}\n', 'utf8');

    const { skipped } = await resetOnboardingArtifacts(
      root,
      provenance([['.claude/settings.json', sha256Hex(normalizeContent('{"ours":1}\n'))]]),
    );

    expect(await exists(root, '.claude/settings.json')).toBe(true);
    expect(skipped).toContainEqual({
      path: '.claude/settings.json',
      reason: 'edited since Haive wrote it',
    });
    // A kept file keeps the directory around it.
    expect(await exists(root, '.claude')).toBe(true);
  });

  it('touches only the repository root, never a package’s own .claude', async () => {
    const root = await repo('reset-nested-');
    await installArtifacts(root);
    await mkdir(path.join(root, 'packages/x/.claude/agents'), { recursive: true });
    await writeFile(path.join(root, 'packages/x/.claude/agents/theirs.md'), 'theirs\n', 'utf8');

    await resetOnboardingArtifacts(root, provenance());

    expect(await exists(root, 'packages/x/.claude/agents/theirs.md')).toBe(true);
  });

  it('deletes a linked agents directory as a link, never through it', async () => {
    // The definitions on the other end belong to whoever put them there; the pointer is ours to
    // remove. `fs.rm({ recursive: true })` resolves by name and would have emptied the target.
    const root = await repo('reset-link-dir-');
    const outside = await repo('reset-link-dir-out-');
    await installArtifacts(root);
    await rm(path.join(root, '.codex/agents'), { recursive: true, force: true });
    await mkdir(path.join(outside, 'agents'), { recursive: true });
    await writeFile(path.join(outside, 'agents/theirs.md'), 'theirs\n', 'utf8');
    await symlink(path.join(outside, 'agents'), path.join(root, '.codex/agents'));

    const { removed } = await resetOnboardingArtifacts(root, provenance());

    expect(removed).toContain('.codex/agents');
    expect(await exists(root, '.codex/agents')).toBe(false);
    expect(await readFile(path.join(outside, 'agents/theirs.md'), 'utf8')).toBe('theirs\n');
  });

  it('reports a linked CLI directory per item and resets the rest', async () => {
    // A refusal is a per-item outcome, not a floor: one link must not discard the removal of the
    // twenty beside it, and what it left alone is reported rather than passed off as reset.
    const root = await repo('reset-link-parent-');
    const outside = await repo('reset-link-parent-out-');
    await installArtifacts(root);
    await rm(path.join(root, '.grok'), { recursive: true, force: true });
    await mkdir(path.join(outside, 'grok/agents'), { recursive: true });
    await writeFile(path.join(outside, 'grok/agents/theirs.md'), 'theirs\n', 'utf8');
    await symlink(path.join(outside, 'grok'), path.join(root, '.grok'));

    const { removed, skipped } = await resetOnboardingArtifacts(root, provenance());

    expect(skipped).toContainEqual({ path: '.grok/agents', reason: 'link' });
    expect(await readFile(path.join(outside, 'grok/agents/theirs.md'), 'utf8')).toBe('theirs\n');
    expect(removed).toContain(KB_DIR);
  });

  it('reports a linked .claude instead of reading it as empty', async () => {
    // The sweep reads strictly for this: a lenient `readdir` answers null for a linked directory,
    // which is byte-identical to "nothing installed" and would report a clean reset.
    const root = await repo('reset-link-claude-');
    const outside = await repo('reset-link-claude-out-');
    await mkdir(path.join(outside, 'claude'), { recursive: true });
    await writeFile(path.join(outside, 'claude/workflow-config.json'), '{"theirs":1}', 'utf8');
    await symlink(path.join(outside, 'claude'), path.join(root, '.claude'));

    const { skipped } = await resetOnboardingArtifacts(root, provenance());

    expect(skipped).toContainEqual({ path: '.claude', reason: 'link' });
    expect(await readFile(path.join(outside, 'claude/workflow-config.json'), 'utf8')).toBe(
      '{"theirs":1}',
    );
  });

  it('is a no-op the second time', async () => {
    const root = await repo('reset-twice-');
    await installArtifacts(root);
    await installUserOwned(root);
    await writeFile(path.join(root, 'AGENTS.md'), '# Mine\n\nkeep me\n', 'utf8');

    await resetOnboardingArtifacts(root, provenance());
    const second = await resetOnboardingArtifacts(root, provenance());

    expect(second.removed).toEqual([]);
    expect(second.cleaned).toEqual([]);
    // The two kept entries are still reported: a reset that left something alone says so every
    // time it runs, not only the first.
    expect(second.skipped.map((s) => s.path).sort()).toEqual([
      '.claude/agents-legacy',
      '.claude/mcp_settings.json',
    ]);
  });
});
