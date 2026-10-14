import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Database } from '@haive/database';
import { CONFIG_KEYS, configService, type CliProviderName } from '@haive/shared';
import type { PromptStepEntry } from '@haive/shared/modularity';
import { MAX_PERSONA_BODY_BYTES } from '../src/orchestrator/agent-isolation.js';
import {
  checkPinnedStepPersonas,
  type UnresolvedPersona,
} from '../src/orchestrator/persona-start-check.js';

const persona = (body: string) => `---\nname: x\ndescription: d\n---\n\n${body}\n`;
const toml = (instructions: string) =>
  `name = "reviewer"\ndescription = "d"\ndeveloper_instructions = """\n${instructions}\n"""\n`;

function entry(slug: string, template: string): PromptStepEntry {
  return { slug, title: slug, template, capabilities: [], tools: [], timeoutMs: 60_000 };
}
const stepId = (slug: string) => `custom.t.${slug}`;

interface FakeOpts {
  repositoryId?: string | null;
  providerName?: CliProviderName | null;
  providerNames?: Record<string, CliProviderName>;
  repoThrows?: boolean;
}

function fakeDb(opts: FakeOpts = {}) {
  const calls = { tasks: 0, repositories: 0, providers: 0 };
  const db = {
    query: {
      tasks: {
        findFirst: async () => {
          calls.tasks += 1;
          return { repositoryId: opts.repositoryId === undefined ? 'r1' : opts.repositoryId };
        },
      },
      repositories: {
        findFirst: async () => {
          calls.repositories += 1;
          if (opts.repoThrows) throw new Error('db gone');
          return { secretMaskEnabled: true, secretMaskAllow: null, secretMaskDenyExtend: null };
        },
      },
    },
  } as unknown as Database;
  return { db, calls };
}

let repo: string;
let events: UnresolvedPersona[];

async function put(rel: string, content: string): Promise<void> {
  const abs = join(repo, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

async function run(
  steps: Record<string, PromptStepEntry>,
  opts: FakeOpts & { record?: (p: UnresolvedPersona) => Promise<void> } = {},
) {
  const { db, calls } = fakeDb(opts);
  await checkPinnedStepPersonas({
    db,
    taskId: 'task-1',
    repoPath: repo,
    customSteps: steps,
    providerNameFor: async (id) => {
      calls.providers += 1;
      return opts.providerNames?.[id] ?? opts.providerName ?? null;
    },
    record: opts.record ?? (async (p) => void events.push(p)),
  });
  return calls;
}

const one = (template = 'Act as {{agent:reviewer}}.') => ({
  [stepId('s1')]: entry('s1', template),
});

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'persona-start-check-'));
  events = [];
  vi.spyOn(configService, 'getBoolean').mockImplementation(async (key, def = false) =>
    key === CONFIG_KEYS.SECRET_MASK_ENABLED ? true : def,
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(repo, { recursive: true, force: true });
});

describe('start-time check of prompt-step personas', () => {
  it('records one event for an id no agent directory holds', async () => {
    await put('.claude/agents/other.md', persona('x'));
    await run(one());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ personaId: 'reviewer', stepIds: [stepId('s1')] });
    expect(events[0]!.reason).toContain('Prompt step persona "reviewer" cannot be used');
    expect(events[0]!.reason).toMatch(/no reviewer\.md found/);
  });

  it('records one event for a persona file that is a link', async () => {
    await put('elsewhere/reviewer.md', persona('Outside.'));
    await mkdir(join(repo, '.claude/agents'), { recursive: true });
    await symlink(join(repo, 'elsewhere/reviewer.md'), join(repo, '.claude/agents/reviewer.md'));
    await run(one());
    expect(events).toHaveLength(1);
    expect(events[0]!.reason).toMatch(/link|outside|regular/i);
  });

  it('records one event for an empty persona', async () => {
    await put('.claude/agents/reviewer.md', persona('   '));
    await run(one());
    expect(events).toHaveLength(1);
    expect(events[0]!.reason).toMatch(/empty/i);
  });

  it('records one event for a persona over the budget', async () => {
    await put('.claude/agents/reviewer.md', persona('x'.repeat(MAX_PERSONA_BODY_BYTES + 10)));
    await run(one());
    expect(events).toHaveLength(1);
    expect(events[0]!.reason).toMatch(/budget|does not fit/i);
  });

  it('records nothing for a readable .claude/agents/<id>.md', async () => {
    await put('.claude/agents/reviewer.md', persona('Review.'));
    await run(one());
    expect(events).toEqual([]);
  });

  it('records nothing for a persona held only in .gemini/agents', async () => {
    await put('.gemini/agents/reviewer.md', persona('Review.'));
    await run(one());
    expect(events).toEqual([]);
  });

  it('records nothing for a persona held only as .codex/agents/<id>.toml with developer_instructions', async () => {
    await put('.codex/agents/reviewer.toml', toml('Be terse.'));
    await run(one());
    expect(events).toEqual([]);
  });

  it('records the toml that has no developer_instructions', async () => {
    await put('.codex/agents/reviewer.toml', 'name = "reviewer"\n');
    await run(one());
    expect(events).toHaveLength(1);
    expect(events[0]!.reason).toContain('developer_instructions');
  });

  it('does no lookup at all for a task whose steps name no persona', async () => {
    const calls = await run({ [stepId('s1')]: entry('s1', 'Plain {{task.title}} prompt.') });
    expect(events).toEqual([]);
    expect(calls).toEqual({ tasks: 0, repositories: 0, providers: 0 });
    expect(configService.getBoolean).not.toHaveBeenCalled();
  });

  it('does no lookup for a task with no pinned steps', async () => {
    const { db, calls } = fakeDb();
    await checkPinnedStepPersonas({
      db,
      taskId: 'task-1',
      repoPath: repo,
      customSteps: undefined,
      providerNameFor: async () => {
        calls.providers += 1;
        return null;
      },
      record: async (p) => void events.push(p),
    });
    expect(events).toEqual([]);
    expect(calls.tasks).toBe(0);
  });

  it('does nothing for a task with no repository', async () => {
    const calls = await run(one(), { repositoryId: null });
    expect(events).toEqual([]);
    expect(calls.repositories).toBe(0);
  });

  it('skips a template that does not parse', async () => {
    await run(one('Act as {{agent:reviewer}} and {{bogus}}.'));
    expect(events).toEqual([]);
  });

  it('records no event, and does not throw, when the lookup itself errors', async () => {
    await expect(run(one(), { repoThrows: true })).resolves.toBeDefined();
    expect(events).toEqual([]);
  });

  it('does not throw when the sink throws', async () => {
    await expect(
      run(one(), {
        record: async () => {
          throw new Error('sink down');
        },
      }),
    ).resolves.toBeDefined();
  });

  it('records one event per id, naming every step that uses it', async () => {
    await put('.claude/agents/ok.md', persona('Fine.'));
    await run({
      [stepId('a')]: entry('a', '{{agent:reviewer}} {{agent:ok}} {{agent:reviewer}}'),
      [stepId('b')]: entry('b', '{{agent:reviewer}} {{agent:other}}'),
    });
    expect(events.map((e) => e.personaId).sort()).toEqual(['other', 'reviewer']);
    const reviewer = events.find((e) => e.personaId === 'reviewer')!;
    expect(reviewer.stepIds).toEqual([stepId('a'), stepId('b')]);
    expect(events.find((e) => e.personaId === 'other')!.stepIds).toEqual([stepId('b')]);
  });

  it('shares one persona budget inside a step, not across steps', async () => {
    const half = 'x'.repeat(Math.floor(MAX_PERSONA_BODY_BYTES / 2) + 100);
    await put('.claude/agents/a.md', persona(half));
    await put('.claude/agents/b.md', persona(half));
    await run({
      [stepId('one')]: entry('one', '{{agent:a}}'),
      [stepId('two')]: entry('two', '{{agent:b}}'),
    });
    expect(events).toEqual([]);
    await run({ [stepId('both')]: entry('both', '{{agent:a}} {{agent:b}}') });
    expect(events.map((e) => e.personaId)).toEqual(['b']);
  });

  it("looks in the task's own provider directory first, as dispatch does", async () => {
    await put('.claude/agents/reviewer.md', persona('Claude-held.'));
    await put('.gemini/agents/reviewer.md', persona('   '));
    await run(one(), { providerName: 'gemini' });
    expect(events).toHaveLength(1);
    expect(events[0]!.reason).toContain('.gemini/agents/reviewer.md');
    events = [];
    await run(one());
    expect(events).toEqual([]);
  });

  it("looks in each step's own provider directory, not one for the whole task", async () => {
    await put('.claude/agents/reviewer.md', persona('Claude-held.'));
    await put('.gemini/agents/reviewer.md', persona('   '));
    const calls = await run(
      {
        [stepId('on-gemini')]: entry('on-gemini', '{{agent:reviewer}}'),
        [stepId('on-claude')]: entry('on-claude', '{{agent:reviewer}}'),
      },
      { providerNames: { [stepId('on-gemini')]: 'gemini', [stepId('on-claude')]: 'claude-code' } },
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.stepIds).toEqual([stepId('on-gemini')]);
    expect(calls.providers).toBe(2);
  });

  it('records again when the start runs again (a retry or restart)', async () => {
    await run(one());
    await run(one());
    expect(events).toHaveLength(2);
  });
});
