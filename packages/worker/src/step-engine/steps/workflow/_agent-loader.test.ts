import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readdirNoFollow, readRegularFileNoFollow } from '../onboarding/_helpers.js';
import { buildAgentFileMarkdown } from '../onboarding/_agent-templates.js';
import { loadAgentPersonas } from './_agent-loader.js';

function persona(name: string): string {
  return [
    '---',
    `name: ${name}`,
    'description: Reviews changes',
    '---',
    '# Title',
    '',
    'Body.',
    '',
  ].join('\n');
}

let base: string;
let repo: string;
let outside: string;

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'agent-loader-'));
  repo = path.join(base, 'repo');
  outside = path.join(base, 'outside');
  await mkdir(repo, { recursive: true });
  await mkdir(path.join(outside, 'agents'), { recursive: true });
  await writeFile(path.join(outside, 'leaked.md'), persona('leaked'));
  await writeFile(path.join(outside, 'agents', 'leaked.md'), persona('leaked'));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('loadAgentPersonas', () => {
  it('loads a persona from a real agent directory', async () => {
    await mkdir(path.join(repo, '.claude', 'agents'), { recursive: true });
    await writeFile(
      path.join(repo, '.claude', 'agents', 'peer-reviewer.md'),
      persona('peer-reviewer'),
    );

    const personas = await loadAgentPersonas(repo);

    expect(personas.map((p) => p.id)).toEqual(['peer-reviewer']);
    expect(personas[0]?.body).toContain('Body.');
  });

  it('reads back the description the agent renderer quoted', async () => {
    const description = 'Owns the "Excel export" button: grids, sorting and state.';
    await mkdir(path.join(repo, '.claude', 'agents'), { recursive: true });
    await writeFile(
      path.join(repo, '.claude', 'agents', 'grid-specialist.md'),
      buildAgentFileMarkdown({
        id: 'grid-specialist',
        title: 'Grid Specialist',
        description,
        color: 'orange',
        field: 'frontend',
        tools: ['Read'],
        coreMission: 'Own the grids.',
        responsibilities: [],
        whenInvoked: [],
        executionSteps: [],
        outputFormat: '',
        qualityCriteria: [],
        antiPatterns: [],
      }),
    );

    const personas = await loadAgentPersonas(repo);

    expect(personas.map((p) => p.description)).toEqual([description]);
  });

  it('reads a folded description, the shape the legacy agent files use', async () => {
    await mkdir(path.join(repo, '.claude', 'agents'), { recursive: true });
    await writeFile(
      path.join(repo, '.claude', 'agents', 'issue-advisor.md'),
      [
        '---',
        'name: issue-advisor',
        'description: >',
        '  Middle-loop recovery advisor for DAG execution. Diagnoses why an issue failed',
        '  the inner review loop.',
        'model: opus',
        'allowed-tools: [Read, Grep]',
        '---',
        '# Issue Advisor',
        '',
      ].join('\n'),
    );

    const [persona] = await loadAgentPersonas(repo);

    expect(persona?.description).toBe(
      'Middle-loop recovery advisor for DAG execution. Diagnoses why an issue failed the inner review loop.',
    );
    expect(persona?.allowedTools).toEqual(['Read', 'Grep']);
  });

  it('reads nothing through an agents directory that links out of the repository', async () => {
    await mkdir(path.join(repo, '.claude'), { recursive: true });
    await symlink(path.join(outside, 'agents'), path.join(repo, '.claude', 'agents'));

    expect(await loadAgentPersonas(repo)).toEqual([]);
  });

  it('reads nothing through a .claude directory that is a link', async () => {
    await symlink(outside, path.join(repo, '.claude'));

    expect(await loadAgentPersonas(repo)).toEqual([]);
  });

  it('skips persona files that are links, including a link to a file inside the repository', async () => {
    const agents = path.join(repo, '.claude', 'agents');
    await mkdir(agents, { recursive: true });
    await writeFile(path.join(repo, 'real.md'), persona('peer-reviewer'));
    await symlink(path.join(repo, 'real.md'), path.join(agents, 'peer-reviewer.md'));
    await symlink(path.join(outside, 'leaked.md'), path.join(agents, 'leaked.md'));

    expect(await loadAgentPersonas(repo)).toEqual([]);
  });

  it('still loads when the repository root itself is reached through a link', async () => {
    await mkdir(path.join(repo, '.claude', 'agents'), { recursive: true });
    await writeFile(
      path.join(repo, '.claude', 'agents', 'peer-reviewer.md'),
      persona('peer-reviewer'),
    );
    const linkedRoot = path.join(base, 'linked-root');
    await symlink(repo, linkedRoot);

    const personas = await loadAgentPersonas(linkedRoot);

    expect(personas.map((p) => p.id)).toEqual(['peer-reviewer']);
  });
});

describe('readdirNoFollow', () => {
  it('returns null for a missing directory', async () => {
    expect(await readdirNoFollow(repo, path.join('.claude', 'agents'))).toBeNull();
  });
});

describe('readRegularFileNoFollow', () => {
  it('refuses a file whose ancestor directory is a link, which O_NOFOLLOW alone does not catch', async () => {
    await symlink(outside, path.join(repo, 'sub'));

    expect(await readRegularFileNoFollow(repo, path.join('sub', 'leaked.md'))).toBeNull();
  });

  it('returns null for a FIFO without blocking', async () => {
    execFileSync('mkfifo', [path.join(repo, 'pipe.md')]);

    expect(await readRegularFileNoFollow(repo, 'pipe.md')).toBeNull();
  });

  it('reads a regular file inside the repository', async () => {
    await writeFile(path.join(repo, 'plain.md'), 'hello');

    expect(await readRegularFileNoFollow(repo, 'plain.md')).toBe('hello');
  });
});
