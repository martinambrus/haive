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
  collectWrittenCliContent,
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

/** What a run that wrote to every CLI directory recorded: the dirs are Haive's, and the one
 *  agent `installArtifacts` puts in each is the file it wrote there. */
function provenance(hashes: Array<[string, string]> = []): {
  writtenHashes: Map<string, string>;
  haiveDirs: Set<string>;
  haiveEntries: Set<string>;
} {
  const catalog = inventoryDirsFromCatalog();
  return {
    writtenHashes: new Map(hashes),
    haiveDirs: new Set(catalog.map((d) => d.dir)),
    haiveEntries: new Set([
      ...catalog.map((d) => `${d.dir}/code-reviewer.${d.ext ?? 'md'}`),
      // 07 writes this, and the `.claude` sweep now removes only what it can claim.
      '.claude/workflow-config.json',
    ]),
  };
}

describe('collectWrittenCliContent', () => {
  const wrote = (...files: string[]) => [
    { stepId: '07-generate-files', output: { wroteFiles: files } },
  ];

  it('claims the files 07 wrote, and nothing it skipped', async () => {
    // `overwrite` defaults to false, so `writeIfAllowed` SKIPS a pre-existing file — a user's own
    // `code-reviewer.toml` is one a successful apply deliberately left alone. Claiming it by id
    // would exempt it from the quarantine and delete it with the directory.
    const { dirs, entries } = collectWrittenCliContent(
      wrote('.codex/agents/test-writer.toml', '.codex/agents/README.md'),
      [],
    );

    expect(dirs.has('.codex/agents')).toBe(true);
    expect(entries.has('.codex/agents/test-writer.toml')).toBe(true);
    expect(entries.has('.codex/agents/README.md')).toBe(true);
    expect(entries.has('.codex/agents/code-reviewer.toml')).toBe(false);
  });

  it('claims the fallback write and an agent with no manifest id', async () => {
    // With only amp enabled, `agentTargets` is EMPTY and 07 writes to `.claude/agents` anyway;
    // an LLM-discovered custom agent has no manifest id at all. Both are in `wroteFiles`.
    const { dirs, entries } = collectWrittenCliContent(
      wrote('.claude/agents/discovered-persona.md', '.claude/workflow-config.json'),
      [],
    );

    expect(dirs.has('.claude/agents')).toBe(true);
    expect(entries.has('.claude/agents/discovered-persona.md')).toBe(true);
    // A path outside the catalog contributes nothing.
    expect(dirs.has('.claude')).toBe(false);
  });

  it('claims the skills 09_5 mirrored and the index beside them', async () => {
    const { dirs, entries } = collectWrittenCliContent(
      [
        {
          stepId: '09_5-skill-generation',
          output: { written: [{ id: 'repo-conventions', mirroredDirs: ['.agents/skills'] }] },
        },
      ],
      [],
    );

    expect(dirs.has('.agents/skills')).toBe(true);
    // A generated skill is a DIRECTORY, `<dir>/<id>/SKILL.md`, so the entry is the id.
    expect(entries.has('.agents/skills/repo-conventions')).toBe(true);
    // 09_5 rebuilds the index every pass; unclaimed it would be quarantined out of its own dir.
    expect(entries.has('.agents/skills/README.md')).toBe(true);
  });

  /** 09_5b's REAL shape: repaired skill ids in the apply output, target dirs in the detect
   *  payload. It records no sub-skill slugs. */
  const skillRepair = (repaired: string[]) => ({
    stepId: '09_5b-skill-repair',
    detectOutput: { skillTargetDirs: ['.claude/skills'] },
    output: { repaired, stillFailing: [], attempted: repaired.length },
  });

  it('never claims a workflow skill sync, which writes in a worktree', async () => {
    // 11d writes into the task's worktree, so its record does not describe the repository root
    // unless the work was merged — and nothing in the row proves that. Claiming from it could
    // delete an untouched root copy of a skill it only ever changed in a worktree.
    const { dirs, entries } = collectWrittenCliContent(
      [
        {
          stepId: '11d-skill-sync',
          detectOutput: { skillTargetDirs: ['.claude/skills'] },
          output: { generated: ['learned-thing'], removed: [], skipped: [] },
        },
      ],
      [],
    );

    expect([...dirs]).toEqual([]);
    expect([...entries]).toEqual([]);
  });

  it('retires the stale slug claims of a skill 09_5b rebuilt', async () => {
    // 09_5b clears the tree before rewriting, so 09_5's slugs for that skill may no longer be on
    // disk. It records none of its own, so `sub-skills` is left unclaimed and quarantined whole.
    const { entries } = collectWrittenCliContent(
      [
        {
          stepId: '09_5-skill-generation',
          output: {
            written: [
              { id: 'broken', mirroredDirs: ['.claude/skills'], subSkillSlugs: ['old-slug'] },
              { id: 'fine', mirroredDirs: ['.claude/skills'], subSkillSlugs: ['kept-slug'] },
            ],
          },
        },
        skillRepair(['broken']),
      ],
      [],
    );

    expect(entries.has('.claude/skills/broken/sub-skills/old-slug.md')).toBe(false);
    expect(entries.has('.claude/skills/broken/sub-skills')).toBe(false);
    expect(entries.has('.claude/skills/broken')).toBe(true);
    expect(entries.has('.claude/skills/broken/SKILL.md')).toBe(true);
    // The skill it did not repair keeps everything 09_5 recorded.
    expect(entries.has('.claude/skills/fine/sub-skills/kept-slug.md')).toBe(true);
  });

  it('does not claim sub-skills when no slug inside it was recorded', async () => {
    // A directory claimed with nothing named inside reads as wholly ours, so a file the user put
    // there would be deleted rather than moved aside.
    const { entries } = collectWrittenCliContent(
      [
        {
          stepId: '09_5-skill-generation',
          output: { written: [{ id: 'legacy', mirroredDirs: ['.claude/skills'] }] },
        },
      ],
      [],
    );

    expect(entries.has('.claude/skills/legacy')).toBe(true);
    expect(entries.has('.claude/skills/legacy/sub-skills')).toBe(false);
  });

  it('claims what 07 wrote under .claude, which is not a catalog dir', async () => {
    const { entries } = collectWrittenCliContent(
      wrote('.claude/workflow-config.json', '.claude/commands/review.md'),
      [],
    );

    expect(entries.has('.claude/workflow-config.json')).toBe(true);
    // The WHOLE path: claiming the head segment would claim `commands/` and `plugins/`
    // themselves, and the sweep would then remove what the user put in them.
    expect(entries.has('.claude/commands/review.md')).toBe(true);
    expect(entries.has('.claude/commands')).toBe(false);
  });

  it('lets an artifact row put a directory in scope without claiming its contents', async () => {
    // `recordOnboardingArtifacts` inserts a row per manifest RENDERING without consulting
    // `wroteFiles`, so a pre-existing user file that apply SKIPPED has a row too. The entry-level
    // claim for a row is the hash check in `resetOnboardingArtifacts`.
    const { dirs, entries } = collectWrittenCliContent(
      [],
      [{ diskPath: '.grok/skills/bundled-thing/SKILL.md' }],
    );

    expect(dirs.has('.grok/skills')).toBe(true);
    expect(entries.has('.grok/skills/bundled-thing')).toBe(false);
  });

  it('ignores a payload naming something outside the catalog', async () => {
    // These are stored JSON written by an older Haive, not a typed contract.
    const { dirs } = collectWrittenCliContent(
      [
        { stepId: '07-generate-files', output: { wroteFiles: ['../etc/passwd', 42, null] } },
        { stepId: '07-generate-files', output: null },
        { stepId: '09_5-skill-generation', output: { written: [{ mirroredDirs: 'nope' }] } },
      ],
      [],
    );

    expect([...dirs]).toEqual([]);
  });
});

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
      haiveEntries: new Set([
        '.claude/agents/code-reviewer.md',
        '.claude/skills/code-reviewer.md',
        '.claude/workflow-config.json',
      ]),
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
      haiveEntries: new Set(['.codex/agents/code-reviewer.toml']),
    });

    expect(removed).toContain('.codex/agents');
    expect(await exists(root, '.codex/agents')).toBe(false);
  });

  it('quarantines a definition Haive did not write instead of deleting it', async () => {
    // The quarantine checkbox at 07 defaults OFF, so an agent the user wrote by hand legitimately
    // sits in an agents dir beside ours — and there is no way to tell it from an old leftover.
    const root = await repo('reset-quarantine-');
    await installArtifacts(root);
    await writeFile(path.join(root, '.codex/agents/mine.toml'), 'mine\n', 'utf8');

    const { removed, quarantined } = await resetOnboardingArtifacts(root, provenance());

    expect(quarantined).toContainEqual({
      from: '.codex/agents/mine.toml',
      to: '.codex/agents-legacy/mine.toml',
    });
    expect(await readFile(path.join(root, '.codex/agents-legacy/mine.toml'), 'utf8')).toBe(
      'mine\n',
    );
    // Everything of ours still goes, and the emptied directory with it.
    expect(removed).toContain('.codex/agents');
    expect(await exists(root, '.codex/agents')).toBe(false);
  });

  it('removes a file an artifact row claims only while the bytes still match', async () => {
    // A row is not evidence on its own: one exists for a path apply SKIPPED, carrying the hash of
    // what Haive would have written. Same file name, two different histories.
    const root = await repo('reset-row-hash-');
    await installArtifacts(root);
    const ours = 'name: reviewer\n';
    await writeFile(path.join(root, '.codex/agents/from-upgrade.toml'), ours, 'utf8');
    await writeFile(path.join(root, '.codex/agents/skipped.toml'), 'mine, kept by 07\n', 'utf8');

    const { removed, quarantined } = await resetOnboardingArtifacts(root, {
      ...provenance(),
      writtenHashes: new Map([
        ['.codex/agents/from-upgrade.toml', sha256Hex(normalizeContent(ours))],
        // What 07 would have written, not what is on disk.
        ['.codex/agents/skipped.toml', sha256Hex(normalizeContent('name: haive\n'))],
      ]),
    });

    expect(quarantined).toContainEqual({
      from: '.codex/agents/skipped.toml',
      to: '.codex/agents-legacy/skipped.toml',
    });
    expect(await readFile(path.join(root, '.codex/agents-legacy/skipped.toml'), 'utf8')).toBe(
      'mine, kept by 07\n',
    );
    // The matching one was ours, so it goes with the directory.
    expect(removed).toContain('.codex/agents');
    expect(await exists(root, '.codex/agents')).toBe(false);
  });

  it('keeps the directory when something could not be moved out of it', async () => {
    // The name is already taken in the quarantine, and which of the two a person wants is not
    // ours to decide — so the file stays, and the removal around it must not take it.
    const root = await repo('reset-quarantine-taken-');
    await installArtifacts(root);
    await writeFile(path.join(root, '.codex/agents/mine.toml'), 'new\n', 'utf8');
    await mkdir(path.join(root, '.codex/agents-legacy'), { recursive: true });
    await writeFile(path.join(root, '.codex/agents-legacy/mine.toml'), 'older\n', 'utf8');

    const { removed, skipped } = await resetOnboardingArtifacts(root, provenance());

    expect(skipped).toContainEqual({
      path: '.codex/agents/mine.toml',
      reason: 'already quarantined under that name',
    });
    expect(await readFile(path.join(root, '.codex/agents/mine.toml'), 'utf8')).toBe('new\n');
    expect(await readFile(path.join(root, '.codex/agents-legacy/mine.toml'), 'utf8')).toBe(
      'older\n',
    );
    // Ours still goes; the directory stays because it is not empty of the user's.
    expect(removed).toContain('.codex/agents/code-reviewer.toml');
    expect(await exists(root, '.codex/agents')).toBe(true);
  });

  it('moves a file a person left inside a generated skill directory', async () => {
    // `haiveEntries` claims the skill DIRECTORY, so without walking it the recursive removal
    // takes the user's notes along with Haive's SKILL.md.
    const root = await repo('reset-skill-child-');
    await installArtifacts(root);
    await mkdir(path.join(root, '.agents/skills/repo-conventions/sub-skills'), { recursive: true });
    await writeFile(path.join(root, '.agents/skills/repo-conventions/SKILL.md'), 'ours\n', 'utf8');
    await writeFile(
      path.join(root, '.agents/skills/repo-conventions/sub-skills/naming.md'),
      'ours\n',
      'utf8',
    );
    await writeFile(path.join(root, '.agents/skills/repo-conventions/NOTES.md'), 'mine\n', 'utf8');

    const base = provenance();
    const { quarantined } = await resetOnboardingArtifacts(root, {
      ...base,
      haiveEntries: new Set([
        ...base.haiveEntries,
        '.agents/skills/repo-conventions',
        '.agents/skills/repo-conventions/SKILL.md',
        '.agents/skills/repo-conventions/sub-skills',
      ]),
    });

    expect(quarantined).toContainEqual({
      from: '.agents/skills/repo-conventions/NOTES.md',
      to: '.agents/skills-legacy/repo-conventions/NOTES.md',
    });
    expect(
      await readFile(path.join(root, '.agents/skills-legacy/repo-conventions/NOTES.md'), 'utf8'),
    ).toBe('mine\n');
    // A claimed directory with no deeper claims of its own is Haive's wholesale, so the rendered
    // sub-skills went with it rather than being moved one by one.
    expect(await exists(root, '.agents/skills')).toBe(false);
    expect(await exists(root, '.agents/skills-legacy/repo-conventions/sub-skills')).toBe(false);
  });

  it('walks a directory an artifact row alone claims', async () => {
    // On an upgraded or legacy repo the only record of a generated skill is its row. Asking just
    // the step-recorded entries answered "nothing below" for exactly those, so the walk was
    // skipped and the file beside the matched artifact was deleted rather than moved.
    const root = await repo('reset-row-descendant-');
    await installArtifacts(root);
    const ours = 'ours\n';
    await mkdir(path.join(root, '.agents/skills/foo'), { recursive: true });
    await writeFile(path.join(root, '.agents/skills/foo/SKILL.md'), ours, 'utf8');
    await writeFile(path.join(root, '.agents/skills/foo/NOTES.md'), 'mine\n', 'utf8');

    const { quarantined } = await resetOnboardingArtifacts(root, {
      ...provenance(),
      writtenHashes: new Map([['.agents/skills/foo/SKILL.md', sha256Hex(normalizeContent(ours))]]),
    });

    expect(quarantined).toContainEqual({
      from: '.agents/skills/foo/NOTES.md',
      to: '.agents/skills-legacy/foo/NOTES.md',
    });
    expect(await readFile(path.join(root, '.agents/skills-legacy/foo/NOTES.md'), 'utf8')).toBe(
      'mine\n',
    );
    expect(await exists(root, '.agents/skills')).toBe(false);
  });

  it('leaves a file in .claude that Haive has no record of writing', async () => {
    // `.claude` holds things Haive never wrote — a person's own commands, hooks, local settings.
    // The blanket removal this replaced took them. They are LEFT rather than moved: `.claude`
    // survives anyway, so there is nothing to move them out of the way of.
    const root = await repo('reset-claude-user-');
    await installArtifacts(root);
    await mkdir(path.join(root, '.claude/commands'), { recursive: true });
    await writeFile(path.join(root, '.claude/commands/mine.md'), 'mine\n', 'utf8');
    await writeFile(path.join(root, '.claude/settings.local.json'), '{"mine":1}', 'utf8');

    const { removed, skipped } = await resetOnboardingArtifacts(root, provenance());

    expect(await readFile(path.join(root, '.claude/commands/mine.md'), 'utf8')).toBe('mine\n');
    expect(await exists(root, '.claude/settings.local.json')).toBe(true);
    expect(skipped.map((s) => s.path)).toEqual(
      expect.arrayContaining(['.claude/commands', '.claude/settings.local.json']),
    );
    // What it IS known to have written still goes.
    expect(removed).toContain('.claude/workflow-config.json');
  });

  it('takes only its own plugin out of .claude/plugins', async () => {
    // 07 writes `.claude/plugins/drupal-php-lsp/<file>`. Claiming the head segment would claim
    // `plugins/` itself, and the sweep would then remove every plugin the user installed.
    const root = await repo('reset-claude-plugins-');
    await installArtifacts(root);
    const ours = '.claude/plugins/drupal-php-lsp/plugin.json';
    await mkdir(path.join(root, '.claude/plugins/drupal-php-lsp'), { recursive: true });
    await writeFile(path.join(root, ours), '{}', 'utf8');
    await mkdir(path.join(root, '.claude/plugins/theirs'), { recursive: true });
    await writeFile(path.join(root, '.claude/plugins/theirs/plugin.json'), 'mine\n', 'utf8');

    const base = provenance();
    const { removed, skipped } = await resetOnboardingArtifacts(root, {
      ...base,
      haiveEntries: new Set([...base.haiveEntries, ours]),
    });

    expect(await exists(root, '.claude/plugins/drupal-php-lsp')).toBe(false);
    expect(removed).toContain(ours);
    expect(await readFile(path.join(root, '.claude/plugins/theirs/plugin.json'), 'utf8')).toBe(
      'mine\n',
    );
    expect(skipped.map((s) => s.path)).toContain('.claude/plugins/theirs');
  });

  it('drops a .claude directory it wrote into once nothing of the user’s is left', async () => {
    const root = await repo('reset-claude-plugins-empty-');
    await installArtifacts(root);
    const ours = '.claude/plugins/drupal-php-lsp/plugin.json';
    await mkdir(path.join(root, '.claude/plugins/drupal-php-lsp'), { recursive: true });
    await writeFile(path.join(root, ours), '{}', 'utf8');

    const base = provenance();
    await resetOnboardingArtifacts(root, {
      ...base,
      haiveEntries: new Set([...base.haiveEntries, ours]),
    });

    expect(await exists(root, '.claude/plugins')).toBe(false);
  });

  it('drops a CLI dot-dir the reset emptied, and keeps one that still holds something', async () => {
    const root = await repo('reset-empty-parent-');
    await installArtifacts(root);
    await writeFile(path.join(root, '.codex/config.toml'), 'theirs\n', 'utf8');

    const { removed } = await resetOnboardingArtifacts(root, provenance());

    // `.grok` held only the dirs the reset removed.
    expect(await exists(root, '.grok')).toBe(false);
    expect(removed).toContain('.grok');
    // `.codex` still has the user's own config, so `rmdir` leaves it alone.
    expect(await readFile(path.join(root, '.codex/config.toml'), 'utf8')).toBe('theirs\n');
  });

  it('moves a file out of sub-skills while removing the rendered ones', async () => {
    const root = await repo('reset-sub-skills-');
    await installArtifacts(root);
    const skill = '.agents/skills/repo-conventions';
    await mkdir(path.join(root, `${skill}/sub-skills`), { recursive: true });
    await writeFile(path.join(root, `${skill}/SKILL.md`), 'ours\n', 'utf8');
    await writeFile(path.join(root, `${skill}/sub-skills/naming.md`), 'ours\n', 'utf8');
    await writeFile(path.join(root, `${skill}/sub-skills/MINE.md`), 'mine\n', 'utf8');

    const base = provenance();
    const { quarantined } = await resetOnboardingArtifacts(root, {
      ...base,
      haiveEntries: new Set([
        ...base.haiveEntries,
        skill,
        `${skill}/SKILL.md`,
        `${skill}/sub-skills`,
        `${skill}/sub-skills/naming.md`,
      ]),
    });

    expect(quarantined).toContainEqual({
      from: `${skill}/sub-skills/MINE.md`,
      to: '.agents/skills-legacy/repo-conventions/sub-skills/MINE.md',
    });
    expect(
      await readFile(
        path.join(root, '.agents/skills-legacy/repo-conventions/sub-skills/MINE.md'),
        'utf8',
      ),
    ).toBe('mine\n');
    // The slug 09_5 recorded was ours, so it went with the directory rather than to the legacy
    // tree beside the user's file.
    expect(await exists(root, '.agents/skills')).toBe(false);
    expect(await exists(root, '.agents/skills-legacy/repo-conventions/sub-skills/naming.md')).toBe(
      false,
    );
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
