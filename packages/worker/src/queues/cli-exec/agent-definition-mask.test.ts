import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  computeAgentDefinitionMasks,
  dropMasksUnderAgentDirs,
  removeAgentMaskStubs,
  type AgentMaskRecord,
} from './agent-definition-mask.js';

const WORKDIR = '/haive/workdir';

async function tree(dirs: string[], files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-mask-'));
  for (const dir of dirs) await mkdir(join(root, dir), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, content);
  }
  return root;
}

describe('computeAgentDefinitionMasks', () => {
  it('masks only the agent directories that EXIST', async () => {
    // A mount over a missing path makes Docker create the mountpoint inside the repo volume,
    // root-owned, and that stub outlives the container. On a read-only local-path mount it cannot be
    // created at all, so masking absent candidates would fail the invocation outright.
    const root = await tree(['.claude/agents', '.claude/skills', 'src']);
    try {
      const { mounts, records } = await computeAgentDefinitionMasks(root, WORKDIR);
      expect(mounts).toHaveLength(1);
      expect(mounts[0]!.target).toBe('/haive/workdir/.claude/agents');
      expect(records.map((r) => r.rel)).toEqual(['.claude/agents']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('renders each mask as a read-only tmpfs with no source', async () => {
    const root = await tree(['.claude/agents']);
    try {
      const { mounts } = await computeAgentDefinitionMasks(root, WORKDIR);
      expect(mounts[0]).toEqual({
        source: '',
        target: '/haive/workdir/.claude/agents',
        tmpfs: true,
        readOnly: true,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('masks every catalog directory present, not just claude', async () => {
    const root = await tree(['.claude/agents', '.codex/agents', '.grok/agents']);
    try {
      const { mounts } = await computeAgentDefinitionMasks(root, WORKDIR);
      // The union is required: grok reads .claude/agents and .agents/agents besides its own.
      expect(mounts.map((m) => m.target).sort()).toEqual([
        '/haive/workdir/.claude/agents',
        '/haive/workdir/.codex/agents',
        '/haive/workdir/.grok/agents',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('skips a SYMLINKED agents directory rather than following it', async () => {
    const root = await tree(['elsewhere', '.claude']);
    await symlink(join(root, 'elsewhere'), join(root, '.claude', 'agents'), 'dir');
    try {
      const { mounts, records } = await computeAgentDefinitionMasks(root, WORKDIR);
      // A mount destination that traverses a repository-controlled link is not a path to hand
      // Docker, and lstat answers for the ENTRY, so the link reports `symlink` and is skipped.
      expect(mounts).toEqual([]);
      expect(records).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('answers nothing for a tree with no agent directory at all', async () => {
    const root = await tree(['src', 'docs']);
    try {
      expect(await computeAgentDefinitionMasks(root, WORKDIR)).toEqual({ mounts: [], records: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not mask the -legacy quarantine sibling', async () => {
    const root = await tree(['.claude/agents-legacy']);
    try {
      // It holds the user's own definitions and stays visible.
      expect((await computeAgentDefinitionMasks(root, WORKDIR)).mounts).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('dropMasksUnderAgentDirs', () => {
  const mounts = [
    { source: '', target: '/haive/workdir/.claude/agents', tmpfs: true as const, readOnly: true },
  ];

  it('drops a file mask under a masked directory and keeps the rest', () => {
    const kept = dropMasksUnderAgentDirs(
      [
        { containerPath: '/haive/workdir/.env', content: '' },
        { containerPath: '/haive/workdir/.claude/agents/secret.md', content: '' },
        { containerPath: '/haive/workdir/.claude/mcp_settings.json', content: '' },
      ],
      mounts,
    );
    // Docker cannot create a mountpoint inside a read-only tmpfs, so keeping that one would fail
    // the whole invocation — and the tmpfs already hides the subtree.
    expect(kept.map((f) => f.containerPath)).toEqual([
      '/haive/workdir/.env',
      '/haive/workdir/.claude/mcp_settings.json',
    ]);
  });

  it('is a no-op when nothing is masked', () => {
    const files = [{ containerPath: '/haive/workdir/.env', content: '' }];
    expect(dropMasksUnderAgentDirs(files, [])).toBe(files);
  });

  it('does not drop a path that merely shares a prefix', () => {
    const kept = dropMasksUnderAgentDirs(
      [{ containerPath: '/haive/workdir/.claude/agents-legacy/mine.md', content: '' }],
      mounts,
    );
    expect(kept).toHaveLength(1);
  });
});

describe('removeAgentMaskStubs', () => {
  function record(root: string, rel: string, inode: number | null): AgentMaskRecord {
    return { rel, workerPath: join(root, rel), anchor: root, anchorRel: rel, inode };
  }

  it('removes an EMPTY stub Docker left behind', async () => {
    const root = await tree(['.claude/agents']);
    try {
      // inode null = it did not exist before the run, so this directory is Docker's stub.
      await removeAgentMaskStubs([record(root, '.claude/agents', null)], process.getuid!());
      const { mounts } = await computeAgentDefinitionMasks(root, WORKDIR);
      expect(mounts).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('REFUSES to remove a stub that now holds something', async () => {
    const root = await tree(['.claude/agents'], { '.claude/agents/written.md': 'by the agent' });
    try {
      await removeAgentMaskStubs([record(root, '.claude/agents', null)], process.getuid!());
      // ENOTEMPTY is the check rather than one this module writes: a directory with contents is no
      // longer a stub, and the failure is swallowed and logged.
      const { mounts } = await computeAgentDefinitionMasks(root, WORKDIR);
      expect(mounts).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('leaves a directory that existed BEFORE the run alone', async () => {
    const root = await tree(['.claude/agents']);
    try {
      // The SAME inode means the repository owns it; it is not ours to delete however empty it is.
      // Taken from the scan rather than fabricated: cleanup compares the recorded inode with the one
      // on disk, so a sentinel value reads as "this directory was replaced" and would be removed.
      // This case used to pass a literal 12345, which satisfied the old `inode !== null` guard —
      // i.e. it passed without ever exercising the comparison it exists to describe.
      const { records } = await computeAgentDefinitionMasks(root, WORKDIR);
      await removeAgentMaskStubs(records, process.getuid!());
      expect((await computeAgentDefinitionMasks(root, WORKDIR)).mounts).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('removes a stub that REPLACED the recorded directory between scan and container create', async () => {
    const root = await tree(['.claude/agents']);
    try {
      // Every production record carries a real inode — computeAgentDefinitionMasks emits one only
      // for a directory that exists — which is why the old `record.inode !== null` guard skipped
      // cleanup in every case, including this one: the directory went away after the scan and
      // Docker recreated the mount target as an empty root-owned stub uid 1000 could not write.
      const { records } = await computeAgentDefinitionMasks(root, WORKDIR);
      expect(records[0]!.inode).not.toBeNull();

      // The differing inode is set rather than produced by rm + mkdir, because that does NOT
      // reliably produce one: MEASURED on this host's /tmp (ext2/ext3), a directory removed and
      // immediately recreated in the same parent came back with the IDENTICAL inode (1003682 both
      // times). So the recreate-it-for-real version of this test failed while the code was correct.
      // The same reuse bounds what the comparison can do in production, which is why ownership and
      // emptiness are the discriminators that carry it — see removeAgentMaskStubs.
      const replaced = [record(root, '.claude/agents', records[0]!.inode! + 1)];
      await removeAgentMaskStubs(replaced, process.getuid!());
      expect((await computeAgentDefinitionMasks(root, WORKDIR)).mounts).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('leaves a directory owned by another uid alone, and never throws', async () => {
    const root = await tree(['.claude/agents']);
    try {
      // uid 0 against a test-owned directory: the guard declines, and an absent path or a refusal
      // must not throw either — this is a fail-open context control.
      await expect(
        removeAgentMaskStubs([
          record(root, '.claude/agents', null),
          record(root, '.codex/agents', null),
        ]),
      ).resolves.toBeUndefined();
      expect((await computeAgentDefinitionMasks(root, WORKDIR)).mounts).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
