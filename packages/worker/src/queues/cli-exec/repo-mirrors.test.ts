import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import type { DockerVolumeMount } from '../../sandbox/docker-runner.js';
import { agentMdForAgy, resolveRepoMirrors } from './repo-mirrors.js';

const SKILLS = { repoDir: '.agents/skills', containerDir: '/home/node/.gemini/config/skills' };
const AGENTS = {
  repoDir: '.agents/agents',
  containerDir: '/home/node/.gemini/config/agents',
  layout: 'agentMdDirs' as const,
};

function volumeMount(subpath: string): DockerVolumeMount {
  return { source: 'haive_repos', target: '/haive/workdir', subpath };
}

const HAIVE_AGENT = [
  '---',
  'name: code-reviewer',
  'description: "Reviews diffs: logic, style and tests."',
  'model: opus',
  'color: red',
  'allowed-tools: [Read, Grep]',
  'auto-invoke: false',
  '---',
  '# Code Reviewer',
  '',
  'You review code.',
  '',
].join('\n');

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'haive-mirrors-'));
  // Repo root: skills and agents, plus what must be left out of the agent mapping.
  await mkdir(path.join(root, 'u/r/.agents/skills/grids'), { recursive: true });
  await writeFile(path.join(root, 'u/r/.agents/skills/grids/SKILL.md'), '---\nname: grids\n---\n');
  await mkdir(path.join(root, 'u/r/.agents/agents/nested'), { recursive: true });
  await writeFile(path.join(root, 'u/r/.agents/agents/code-reviewer.md'), HAIVE_AGENT);
  await writeFile(path.join(root, 'u/r/.agents/agents/README.md'), '# Agents Index\n');
  await writeFile(path.join(root, 'u/r/.agents/agents/no-frontmatter.md'), '# Just a doc\n');
  await writeFile(path.join(root, 'u/r/.agents/agents/notes.txt'), 'not an agent\n');
  // A worktree with its own copy, and a repo whose customizations are reached through a link.
  await mkdir(path.join(root, 'u/r/.haive/worktrees/feat/.agents/skills/wt-only'), {
    recursive: true,
  });
  await mkdir(path.join(root, 'u/linked/real/skills'), { recursive: true });
  await symlink(path.join(root, 'u/linked/real'), path.join(root, 'u/linked/.agents'));
  await mkdir(path.join(root, 'u/empty'), { recursive: true });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('resolveRepoMirrors under agent isolation', () => {
  it('drops the AGENT mirror and keeps the skills mirror', async () => {
    // agy ignores the workspace `.agents/` in a headless run and loads definitions from
    // `~/.gemini/config`, so mirroring them there hands it every persona the workspace mask hides —
    // isolation was inert for this provider. Skills are not what isolation withholds, so that
    // mirror is unchanged.
    const isolated = await resolveRepoMirrors([SKILLS, AGENTS], volumeMount('u/r'), root, {
      maskAgentDefinitions: true,
    });
    expect(isolated.files).toEqual([]);
    expect(isolated.mounts.map((m) => m.target)).toEqual(['/home/node/.gemini/config/skills']);

    // The same call without the flag still carries both, so a non-isolated dispatch is untouched.
    const open = await resolveRepoMirrors([SKILLS, AGENTS], volumeMount('u/r'), root);
    expect(open.mounts.map((m) => m.target)).toEqual(['/home/node/.gemini/config/skills']);
    expect(open.files.map((f) => f.containerPath)).toEqual([
      '/home/node/.gemini/config/agents/code-reviewer/agent.md',
    ]);
  });

  it('is passed the spec flag by the exec-core spawner', async () => {
    // A proxy for driving createSandboxSpawner, which needs an image, credentials and a runner.
    // Without it the argument could be deleted and every unit test above would still pass — the
    // shape that let piece 4 ship a spec field with one writer and no readers.
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('./exec-core.ts', import.meta.url), 'utf8');
    const call = source.indexOf('await resolveRepoMirrors(');
    expect(call).toBeGreaterThan(-1);
    expect(source.slice(call, call + 220)).toContain(
      'maskAgentDefinitions: spec.maskAgentDefinitions',
    );
  });
});

describe('resolveRepoMirrors', () => {
  it('mounts a directory read-only from the repository tree', async () => {
    const out = await resolveRepoMirrors([SKILLS], volumeMount('u/r'), root);
    expect(out).toEqual({
      mounts: [
        {
          source: 'haive_repos',
          target: '/home/node/.gemini/config/skills',
          subpath: 'u/r/.agents/skills',
          readOnly: true,
        },
      ],
      files: [],
    });
  });

  it("takes a worktree run's own copy, not the repository root's", async () => {
    const out = await resolveRepoMirrors([SKILLS], volumeMount('u/r/.haive/worktrees/feat'), root);
    expect(out.mounts.map((m) => m.subpath)).toEqual(['u/r/.haive/worktrees/feat/.agents/skills']);
  });

  it('skips a directory that is missing, since docker refuses a missing subpath', async () => {
    expect(await resolveRepoMirrors([SKILLS, AGENTS], volumeMount('u/empty'), root)).toEqual({
      mounts: [],
      files: [],
    });
  });

  it('skips a directory reached through a link', async () => {
    expect((await resolveRepoMirrors([SKILLS], volumeMount('u/linked'), root)).mounts).toEqual([]);
  });

  it('gives nothing to a bind-mounted local repository or a run without a repository', async () => {
    const bind: DockerVolumeMount = { source: '/host-fs/proj', target: '/haive/workdir' };
    expect(await resolveRepoMirrors([SKILLS], bind, root)).toEqual({ mounts: [], files: [] });
    expect(await resolveRepoMirrors([SKILLS], null, root)).toEqual({ mounts: [], files: [] });
  });

  it('re-lays flat agents as <id>/agent.md, leaving out the index and non-agents', async () => {
    const out = await resolveRepoMirrors([AGENTS], volumeMount('u/r'), root);
    expect(out.mounts).toEqual([]);
    expect(out.files.map((f) => f.containerPath)).toEqual([
      '/home/node/.gemini/config/agents/code-reviewer/agent.md',
    ]);
  });
});

describe('agentMdForAgy', () => {
  it('keeps only name and description in the frontmatter, and the body unchanged', () => {
    const md = agentMdForAgy('code-reviewer', HAIVE_AGENT)!;
    const [, frontmatter, body] = md.split(/^---\n([\s\S]*?)\n---\n/);
    expect(parse(frontmatter!)).toEqual({
      name: 'code-reviewer',
      description: 'Reviews diffs: logic, style and tests.',
    });
    expect(body).toBe('# Code Reviewer\n\nYou review code.\n');
  });

  it('reads a folded description, the shape legacy agent files use', () => {
    const md = agentMdForAgy(
      'issue-advisor',
      '---\nname: issue-advisor\ndescription: >\n  Diagnoses a failed issue\n  and picks a recovery.\n---\n# Issue Advisor\n',
    )!;
    expect(md).toContain('description: Diagnoses a failed issue and picks a recovery.\n');
  });

  it('skips a file with no frontmatter or no description', () => {
    expect(agentMdForAgy('x', '# Just a doc\n')).toBeNull();
    expect(agentMdForAgy('x', '---\nname: x\n---\n# X\n')).toBeNull();
  });
});
