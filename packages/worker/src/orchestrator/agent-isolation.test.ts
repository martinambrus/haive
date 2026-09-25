import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MAX_PERSONA_BODY_BYTES,
  instructionsNameAgentPath,
  readPersonaBodies,
} from './agent-isolation.js';
import { secretMaskPolicy } from '../queues/cli-exec/secret-mask-policy.js';

async function tree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-isolation-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, content);
  }
  return root;
}

/** No masking: every persona file is readable, which is the default for a repository. */
const OPEN_POLICY = { globs: { deny: [], ignore: [] }, tracked: null };
const noTracked = async (): Promise<Set<string> | null> => null;

describe('instructionsNameAgentPath', () => {
  it('is false when the entry point does not exist', async () => {
    const root = await tree({ 'README.md': 'nothing here' });
    try {
      expect(
        await instructionsNameAgentPath({
          workerTree: root,
          rulesFile: 'CLAUDE.md',
          rulesFileMode: 'import',
        }),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('is true when the entry point names an agent path', async () => {
    // The real instruction MEASURED on the dev install.
    const root = await tree({
      'AGENTS.md': 'FIRST: Read your full agent definition from .claude/agents/{agent-name}.md',
    });
    try {
      expect(
        await instructionsNameAgentPath({
          workerTree: root,
          rulesFile: 'AGENTS.md',
          rulesFileMode: 'native',
        }),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('follows @ imports in import mode and NOT in native mode', async () => {
    const files = {
      'CLAUDE.md': '@AGENTS.md\n',
      'AGENTS.md': 'Read .claude/agents/peer-reviewer.md before starting.\n',
    };
    const importRoot = await tree(files);
    const nativeRoot = await tree(files);
    try {
      expect(
        await instructionsNameAgentPath({
          workerTree: importRoot,
          rulesFile: 'CLAUDE.md',
          rulesFileMode: 'import',
        }),
      ).toBe(true);
      // A native reader does not expand `@`, so its chain is not followed and nothing is claimed
      // about a file that reader never reads.
      expect(
        await instructionsNameAgentPath({
          workerTree: nativeRoot,
          rulesFile: 'CLAUDE.md',
          rulesFileMode: 'native',
        }),
      ).toBe(false);
    } finally {
      await rm(importRoot, { recursive: true, force: true });
      await rm(nativeRoot, { recursive: true, force: true });
    }
  });

  it('resolves an @ import relative to the file that makes it', async () => {
    const root = await tree({
      'CLAUDE.md': '@docs/rules.md\n',
      'docs/rules.md': '@nested/more.md\n',
      'docs/nested/more.md': 'see .grok/agents/x.md\n',
    });
    try {
      expect(
        await instructionsNameAgentPath({
          workerTree: root,
          rulesFile: 'CLAUDE.md',
          rulesFileMode: 'import',
        }),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('terminates on an import cycle and claims nothing', async () => {
    const root = await tree({ 'CLAUDE.md': '@AGENTS.md\n', 'AGENTS.md': '@CLAUDE.md\n' });
    try {
      expect(
        await instructionsNameAgentPath({
          workerTree: root,
          rulesFile: 'CLAUDE.md',
          rulesFileMode: 'import',
        }),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails OPEN past the import cap, so a truncated scan cannot hide a reference', async () => {
    // Seven links: longer than MAX_INSTRUCTION_IMPORTS, and the agent path sits at the end where a
    // capped scan would never reach it.
    const files: Record<string, string> = { 'CLAUDE.md': '@a1.md\n' };
    for (let i = 1; i < 7; i++) files[`a${i}.md`] = `@a${i + 1}.md\n`;
    files['a7.md'] = 'see .claude/agents/deep.md\n';
    const root = await tree(files);
    try {
      expect(
        await instructionsNameAgentPath({
          workerTree: root,
          rulesFile: 'CLAUDE.md',
          rulesFileMode: 'import',
        }),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails OPEN when the rules file is a SYMLINK rather than reading through it', async () => {
    // The read is lenient by default, which folded a containment refusal into `null` — and `null`
    // means "absent", i.e. "names nothing". So a symlinked instruction file left isolation ENABLED
    // while a CLI, which does follow the link, could be told to read an agent definition the mask
    // then hid. `strict: true` is what makes this refusal reach the catch.
    const root = await tree({ 'real.md': 'see .claude/agents/x.md\n' });
    try {
      await symlink('real.md', join(root, 'CLAUDE.md'));
      expect(
        await instructionsNameAgentPath({
          workerTree: root,
          rulesFile: 'CLAUDE.md',
          rulesFileMode: 'import',
        }),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails OPEN when the rules path is not a regular file', async () => {
    const root = await tree({ 'README.md': 'x' });
    try {
      // A directory where the instruction file should be: the reader refuses a non-regular target,
      // which is a refusal and not an absence.
      await mkdir(join(root, 'CLAUDE.md'));
      expect(
        await instructionsNameAgentPath({
          workerTree: root,
          rulesFile: 'CLAUDE.md',
          rulesFileMode: 'import',
        }),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('counts the budget in BYTES, so a multibyte file over the cap fails OPEN', async () => {
    // 400k euro signs: ~1.2 MB of UTF-8 against 400k UTF-16 code units. `text.length > budget`
    // measured the code units, so this file passed a 1 MiB byte cap as though it fit, and its
    // unscanned tail — where the agent path sits — was never examined.
    const root = await tree({ 'CLAUDE.md': `${'€'.repeat(400_000)}\n.claude/agents/deep.md\n` });
    try {
      expect(
        await instructionsNameAgentPath({
          workerTree: root,
          rulesFile: 'CLAUDE.md',
          rulesFileMode: 'import',
        }),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reads a worktree through the repository root and follows its imports there', async () => {
    const root = await tree({
      '.haive/worktrees/wt/CLAUDE.md': '@AGENTS.md\n',
      '.haive/worktrees/wt/AGENTS.md': 'Read .claude/agents/reviewer.md before you start.',
    });
    try {
      expect(
        await instructionsNameAgentPath({
          workerTree: join(root, '.haive/worktrees/wt'),
          rulesFile: 'CLAUDE.md',
          rulesFileMode: 'import',
        }),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails OPEN when the worktree directory is a link', async () => {
    const root = await tree({ 'elsewhere/CLAUDE.md': 'Nothing to see.\n' });
    await mkdir(join(root, '.haive/worktrees'), { recursive: true });
    await symlink(join(root, 'elsewhere'), join(root, '.haive/worktrees/wt'));
    try {
      expect(
        await instructionsNameAgentPath({
          workerTree: join(root, '.haive/worktrees/wt'),
          rulesFile: 'CLAUDE.md',
          rulesFileMode: 'import',
        }),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('follows an @ import the way the CLI resolves it, inside the mount', async () => {
    // Each reaches an agent definition in the sandbox, and none names one as written.
    const cases: Record<string, string>[] = [
      { 'CLAUDE.md': '@../workdir/.claude/agents/x.md\n' },
      {
        'CLAUDE.md': '@/haive/workdir/docs/guide.md\n',
        'docs/guide.md': 'See .claude/agents/x.md',
      },
      { 'CLAUDE.md': '@docs/../.claude/agents/x.md\n' },
    ];
    const answers: boolean[] = [];
    for (const files of cases) {
      const root = await tree({ ...files, '.claude/agents/x.md': 'You review code.' });
      try {
        answers.push(
          await instructionsNameAgentPath({
            workerTree: root,
            rulesFile: 'CLAUDE.md',
            rulesFileMode: 'import',
          }),
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
    expect(answers).toEqual([true, true, true]);
  });

  it('does not follow a worktree import up to the repository root, which is not mounted', async () => {
    const root = await tree({
      '.haive/worktrees/wt/CLAUDE.md': '@../../../AGENTS.md\n',
      'AGENTS.md': 'Read .claude/agents/reviewer.md before you start.',
    });
    try {
      expect(
        await instructionsNameAgentPath({
          workerTree: join(root, '.haive/worktrees/wt'),
          rulesFile: 'CLAUDE.md',
          rulesFileMode: 'import',
        }),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses an @ import that leaves the tree', async () => {
    const root = await tree({ 'CLAUDE.md': '@../outside.md\n@/etc/passwd\n' });
    try {
      expect(
        await instructionsNameAgentPath({
          workerTree: root,
          rulesFile: 'CLAUDE.md',
          rulesFileMode: 'import',
        }),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('readPersonaBodies', () => {
  it('reads a body by FILENAME and strips the frontmatter', async () => {
    const root = await tree({
      '.claude/agents/peer-reviewer.md':
        '---\nname: something-else\ndescription: d\n---\n\n# Peer reviewer\n\nDo the review.\n',
    });
    try {
      const { bodies, oversized } = await readPersonaBodies({
        workerTree: root,
        projectAgentsDir: '.claude/agents',
        ids: ['peer-reviewer'],
        policy: OPEN_POLICY,
        loadTracked: noTracked,
      });
      // Keyed on the FILENAME, never the frontmatter `name` — the two can differ, and a lookup by
      // name would silently drop the customisation that outranks the inline persona.
      expect(Object.keys(bodies)).toEqual(['peer-reviewer']);
      expect(bodies['peer-reviewer']).toContain('Do the review.');
      expect(bodies['peer-reviewer']).not.toContain('description: d');
      expect(oversized).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reads a worktree body through the repository root, and nothing through a linked one', async () => {
    const body = '---\nname: reviewer\ndescription: d\n---\n\nReview carefully.\n';
    const root = await tree({
      '.haive/worktrees/real/.claude/agents/reviewer.md': body,
      'elsewhere/.claude/agents/reviewer.md': body,
    });
    await symlink(join(root, 'elsewhere'), join(root, '.haive/worktrees/linked'));
    const read = (worktree: string) =>
      readPersonaBodies({
        workerTree: join(root, '.haive/worktrees', worktree),
        projectAgentsDir: '.claude/agents',
        ids: ['reviewer'],
        policy: OPEN_POLICY,
        loadTracked: noTracked,
      });
    try {
      expect((await read('real')).bodies).toEqual({ reviewer: 'Review carefully.' });
      expect((await read('linked')).bodies).toEqual({});
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('treats a missing, unparseable or empty-bodied file as missing', async () => {
    const root = await tree({
      '.claude/agents/unclosed.md': '---\nname: x\nstill open\n',
      '.claude/agents/empty.md': '---\nname: x\n---\n\n   \n',
    });
    try {
      const { bodies } = await readPersonaBodies({
        workerTree: root,
        projectAgentsDir: '.claude/agents',
        ids: ['absent', 'unclosed', 'empty'],
        policy: OPEN_POLICY,
        loadTracked: noTracked,
      });
      // Pasting an empty persona is the same silent failure as pasting none, so all three fall back.
      expect(bodies).toEqual({});
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses an oversized body rather than truncating it', async () => {
    const big = 'x'.repeat(MAX_PERSONA_BODY_BYTES + 10);
    const root = await tree({
      '.claude/agents/huge.md': `---\nname: huge\n---\n\n${big}\n`,
      '.claude/agents/small.md': '---\nname: small\n---\n\nshort body\n',
    });
    try {
      const { bodies, oversized } = await readPersonaBodies({
        workerTree: root,
        projectAgentsDir: '.claude/agents',
        ids: ['huge', 'small'],
        policy: OPEN_POLICY,
        loadTracked: noTracked,
      });
      // A cut persona reads as a complete one, so it is never pasted — and the one that fits is
      // still read, because the budget is spent in marker order rather than abandoned.
      expect(bodies['huge']).toBeUndefined();
      expect(bodies['small']).toContain('short body');
      expect(oversized).toHaveLength(1);
      expect(oversized[0]!.id).toBe('huge');
      expect(oversized[0]!.size).toBeGreaterThan(MAX_PERSONA_BODY_BYTES);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('treats a path the secret-mask policy denies as missing', async () => {
    const root = await tree({
      '.claude/agents/peer-reviewer.md': '---\nname: p\n---\n\nbody\n',
    });
    try {
      // A repository that added `**/*.md` to its deny globs. Untracked (no tracked set), so the
      // policy denies it — and pasting it would hand the provider exactly the bytes the sandbox
      // mask exists to withhold.
      const denied = secretMaskPolicy({ denyExtend: ['**/*.md'] });
      const { bodies } = await readPersonaBodies({
        workerTree: root,
        projectAgentsDir: '.claude/agents',
        ids: ['peer-reviewer'],
        policy: denied,
        loadTracked: noTracked,
      });
      expect(bodies).toEqual({});

      // The same file, TRACKED: masking is untracked-only, so a committed definition is readable.
      const { bodies: trackedBodies } = await readPersonaBodies({
        workerTree: root,
        projectAgentsDir: '.claude/agents',
        ids: ['peer-reviewer'],
        policy: denied,
        loadTracked: async () => new Set(['.claude/agents/peer-reviewer.md']),
      });
      expect(trackedBodies['peer-reviewer']).toContain('body');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reads from the provider own directory, not a hardcoded .claude', async () => {
    const root = await tree({ '.grok/agents/x.md': '---\nname: x\n---\n\ngrok body\n' });
    try {
      const { bodies } = await readPersonaBodies({
        workerTree: root,
        projectAgentsDir: '.grok/agents',
        ids: ['x'],
        policy: OPEN_POLICY,
        loadTracked: noTracked,
      });
      expect(bodies['x']).toContain('grok body');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
