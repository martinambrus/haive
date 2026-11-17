import { expect, it, vi } from 'vitest';
import {
  prepareSandboxToolchainPrompts,
  recheckSandboxToolchain,
  sandboxToolchainOffset,
  stripSandboxToolchain,
  withSandboxToolchain,
} from '../src/sandbox/toolchain-prompt.js';
import type { CliCommandSpec } from '../src/cli-adapters/types.js';
import { fakeDockerRunner } from './fake-docker-runner.js';
import { steeringUserMessageLine } from '../src/cli-adapters/steering.js';
import { antigravityStdinPrompt } from '../src/cli-adapters/antigravity.js';
const OLD = `sha256:${'a'.repeat(64)}`;
const NEW = `sha256:${'b'.repeat(64)}`;
const fact = { imageId: OLD, php: 'absent' as const };
const prompt = withSandboxToolchain('Check code', fact);
const block = prompt.slice(0, prompt.indexOf('\n\n'));
const inspect = vi.fn(async () => ({ exists: true, imageId: NEW }));
const runner = fakeDockerRunner({ inspect });
function spec(): CliCommandSpec {
  return {
    command: 'cli',
    args: ['-p', prompt],
    env: {},
    sandboxToolchain: { imageId: OLD, block },
  };
}
it('pins exec to the newly inspected immutable ID and strips the old dispatch fact', async () => {
  const checked = await recheckSandboxToolchain(spec(), 'image:tag', runner);
  expect(checked.image).toBe(NEW);
  expect(checked.spec.args).toEqual(['-p', 'Check code']);
  expect(checked.spec.sandboxToolchain).toBeUndefined();
});
it('pins even a matching tag so a rebuild after inspect cannot change the launched image', async () => {
  const r = fakeDockerRunner({ inspect: async () => ({ exists: true, imageId: OLD }) });
  const checked = await recheckSandboxToolchain(spec(), 'image:tag', r);
  expect(checked.image).toBe(OLD);
  expect(checked.spec.args[1]).toBe(prompt);
});
it.each(['stdin', 'steering', 'antigravity', 'file', 'app-server'] as const)(
  'strips stale facts in %s delivery without changing flags or env',
  async (mode) => {
    const s = spec();
    s.args = ['--model', 'chosen'];
    if (mode === 'stdin') s.stdinPrompt = prompt;
    if (mode === 'steering') s.stdinInitial = steeringUserMessageLine(prompt);
    if (mode === 'antigravity') s.stdinPrompt = antigravityStdinPrompt(prompt);
    if (mode === 'file') s.promptFile = { containerPath: '/prompt', content: prompt };
    if (mode === 'app-server')
      s.codexAppServer = { prompt, model: 'chosen', effort: 'high', execArgs: ['exec'] };
    const checked = await recheckSandboxToolchain(s, 'image:tag', runner);
    expect(JSON.stringify(checked.spec)).not.toContain('haive_sandbox_toolchain');
    expect(checked.spec.args).toEqual(['--model', 'chosen']);
    if (mode === 'steering')
      expect(checked.spec.stdinInitial).toBe(steeringUserMessageLine('Check code'));
    if (mode === 'antigravity')
      expect(checked.spec.stdinPrompt).toBe(antigravityStdinPrompt('Check code'));
  },
);
it('also strips each nested native prompt and synthesis fact', async () => {
  const assembled = `Agent:\n${prompt}\nSynthesize:\n${prompt}`;
  const s = {
    ...spec(),
    args: [assembled],
    sandboxToolchain: { imageId: OLD, block, copies: 2 },
  };
  expect((await recheckSandboxToolchain(s, 'image:tag', runner)).spec.args).toEqual([
    'Agent:\nCheck code\nSynthesize:\nCheck code',
  ]);
});
it('omits the fact on inspect failure or a PATH override introduced by secrets', async () => {
  const broken = fakeDockerRunner({
    inspect: async () => {
      throw new Error('daemon');
    },
  });
  expect((await recheckSandboxToolchain(spec(), 'image:tag', broken)).spec.args[1]).toBe(
    'Check code',
  );
  expect(
    (await recheckSandboxToolchain(spec(), 'image:tag', runner, null, { PATH: '/custom' })).spec
      .args[1],
  ).toBe('Check code');
});
it('leaves unknown prompts byte-identical and does no Docker work', async () => {
  inspect.mockClear();
  const s = { command: 'cli', args: ['raw'], env: {} };
  expect(await recheckSandboxToolchain(s, null, runner)).toEqual({ spec: s, image: null });
  expect(inspect).not.toHaveBeenCalled();
});

it('preserves quoted markers in outer rules and literal replacement syntax in task text', async () => {
  const source = "Check $& $$ $` $' code";
  const inner = withSandboxToolchain(source, fact);
  const outer = `<haive_agent_rules>\nQuote <haive_sandbox_toolchain> literally.\n</haive_agent_rules>\n\n${inner}`;
  const expected = `<haive_agent_rules>\nQuote <haive_sandbox_toolchain> literally.\n</haive_agent_rules>\n\n${source}`;
  expect(stripSandboxToolchain(outer)).toBe(expected);
  const s = { ...spec(), args: [outer], sandboxToolchain: { imageId: OLD, block } };
  expect((await recheckSandboxToolchain(s, 'image:tag', runner)).spec.args).toEqual([expected]);
});

it('strips exactly the stamped block and its blank line, preserving task whitespace and other blocks', async () => {
  const body = '\n\nCheck code\n\n';
  const other = '<haive_app_reach>\nKeep this.\n</haive_app_reach>\n\n';
  const source = other + withSandboxToolchain(body, fact);
  const s = { ...spec(), args: [source] };
  expect((await recheckSandboxToolchain(s, 'image:tag', runner)).spec.args).toEqual([other + body]);
});
it('continues to handle legacy full-prompt stamps already queued before the upgrade', async () => {
  const s = { ...spec(), sandboxToolchain: { imageId: OLD, prompt } };
  expect((await recheckSandboxToolchain(s, 'image:tag', runner)).spec.args[1]).toBe('Check code');
});

it.each(['argv', 'stdin', 'steering', 'antigravity', 'file', 'app-server'] as const)(
  'keeps a full quoted advisory including its blank line in %s delivery',
  async (mode) => {
    const body = `Task text quoting the advisory:\n${block}\n\nKeep $& $$ $\` $' verbatim.`;
    const quoted = withSandboxToolchain(body, fact);
    const s: CliCommandSpec = {
      ...spec(),
      args: mode === 'argv' ? [quoted] : ['--model', 'chosen'],
    };
    if (mode === 'stdin') s.stdinPrompt = quoted;
    if (mode === 'steering') s.stdinInitial = steeringUserMessageLine(quoted);
    if (mode === 'antigravity') s.stdinPrompt = antigravityStdinPrompt(quoted);
    if (mode === 'file') s.promptFile = { containerPath: '/prompt', content: quoted };
    if (mode === 'app-server')
      s.codexAppServer = { prompt: quoted, model: 'chosen', effort: 'high', execArgs: ['exec'] };
    const { spec: clean } = await recheckSandboxToolchain(s, 'image:tag', runner);
    if (mode === 'argv') expect(clean.args).toEqual([body]);
    if (mode === 'stdin') expect(clean.stdinPrompt).toBe(body);
    if (mode === 'steering') expect(clean.stdinInitial).toBe(steeringUserMessageLine(body));
    if (mode === 'antigravity') expect(clean.stdinPrompt).toBe(antigravityStdinPrompt(body));
    if (mode === 'file') expect(clean.promptFile?.content).toBe(body);
    if (mode === 'app-server') expect(clean.codexAppServer?.prompt).toBe(body);
  },
);

it.each(['block', 'legacy'] as const)(
  'removes native leading copies while retaining interleaved quotes with %s stamps',
  async (kind) => {
    const body = `Quoted advisory:\n${block}\n\nDo not change it.`;
    const prompts = [withSandboxToolchain(body, fact), withSandboxToolchain(body, fact), prompt];
    const prepared = prepareSandboxToolchainPrompts(prompts, OLD);
    expect(prepared.stamp).toMatchObject({ copies: 3, occurrences: [1, 3, 5] });
    const assembled = prompts.join('\nNext agent:\n');
    const stamp = kind === 'legacy' ? { imageId: OLD, segments: prompts } : prepared.stamp;
    const s = { ...spec(), args: [assembled], sandboxToolchain: stamp };
    const checked = await recheckSandboxToolchain(s, 'image:tag', runner);
    expect(checked.spec.args).toEqual([[body, body, 'Check code'].join('\nNext agent:\n')]);
  },
);
it.each(['single', 'native'] as const)(
  'rebuilds %s prompts without the advisory if any leading block is missing',
  (kind) => {
    const prompts = kind === 'single' ? ['No block here'] : [prompt, 'No block here'];
    const prepared = prepareSandboxToolchainPrompts(prompts, OLD);
    expect(prepared.stamp).toBeUndefined();
    expect(prepared.prompts).toEqual(
      kind === 'single' ? ['No block here'] : ['Check code', 'No block here'],
    );
  },
);

it('finds the advisory behind extra separator lines without consuming task-leading blank lines', async () => {
  const outer = '<haive_agent_rules>\nKeep these rules.\n</haive_agent_rules>\n\n\n\n';
  const s = { ...spec(), args: [outer + withSandboxToolchain('\n\nCheck code', fact)] };
  expect((await recheckSandboxToolchain(s, 'image:tag', runner)).spec.args).toEqual([
    outer + '\n\nCheck code',
  ]);
});

for (const rules of ['agent', 'house']) {
  it.each(['argv', 'stdin', 'steering', 'antigravity', 'file', 'app-server'] as const)(
    `keeps a full advisory quote in ${rules} rules before the owned copy over %s`,
    async (mode) => {
      const prefix = `<haive_${rules}_rules>\nKeep 💡 "rules" and this quote:\n${block}\n\nEnd.\n</haive_${rules}_rules>\n\n`;
      const body = `Check $& $$ code, retaining a later quote:\n${block}\n\nEnd.`;
      const queued = prefix + withSandboxToolchain(body, fact);
      const s: CliCommandSpec = {
        ...spec(),
        args: mode === 'argv' ? [queued] : ['--model', 'chosen'],
        sandboxToolchain: { imageId: OLD, block, offset: sandboxToolchainOffset(queued) },
      };
      if (mode === 'stdin') s.stdinPrompt = queued;
      if (mode === 'steering') s.stdinInitial = steeringUserMessageLine(queued);
      if (mode === 'antigravity') s.stdinPrompt = antigravityStdinPrompt(queued);
      if (mode === 'file') s.promptFile = { containerPath: '/prompt', content: queued };
      if (mode === 'app-server')
        s.codexAppServer = { prompt: queued, model: 'chosen', effort: 'high', execArgs: ['exec'] };
      for (const [r, wrapper, extraEnv] of [
        [runner, undefined, undefined],
        [
          fakeDockerRunner({ inspect: async () => ({ exists: true, imageId: OLD }) }),
          'wrapper',
          undefined,
        ],
        [
          fakeDockerRunner({ inspect: async () => ({ exists: true, imageId: OLD }) }),
          undefined,
          { PATH: '/custom' },
        ],
      ] as const) {
        const queuedPayload = structuredClone(s);
        const { spec: clean } = await recheckSandboxToolchain(s, 'image:tag', r, wrapper, extraEnv);
        const expected = prefix + body;
        if (mode === 'argv') expect(clean.args).toEqual([expected]);
        if (mode === 'stdin') expect(clean.stdinPrompt).toBe(expected);
        if (mode === 'steering') expect(clean.stdinInitial).toBe(steeringUserMessageLine(expected));
        if (mode === 'antigravity')
          expect(clean.stdinPrompt).toBe(antigravityStdinPrompt(expected));
        if (mode === 'file') expect(clean.promptFile?.content).toBe(expected);
        if (mode === 'app-server') expect(clean.codexAppServer?.prompt).toBe(expected);
        // Queue redelivery carries the original stamped payload, with the same environment.
        expect((await recheckSandboxToolchain(s, 'image:tag', r, wrapper, extraEnv)).spec).toEqual(
          clean,
        );
        expect(s).toEqual(queuedPayload);
      }
    },
  );
}

it.each(['argv', 'stdin', 'steering', 'antigravity', 'file', 'app-server'] as const)(
  'refuses a mismatched owned offset in %s rather than stripping a different quote',
  async (mode) => {
    const quoted = `Moved prompt\n${prompt}`;
    const s: CliCommandSpec = {
      ...spec(),
      args: mode === 'argv' ? [quoted] : [],
      sandboxToolchain: { imageId: OLD, block, offset: 0 },
    };
    if (mode === 'stdin') s.stdinPrompt = quoted;
    if (mode === 'steering') s.stdinInitial = steeringUserMessageLine(quoted);
    if (mode === 'antigravity') s.stdinPrompt = antigravityStdinPrompt(quoted);
    if (mode === 'file') s.promptFile = { containerPath: '/prompt', content: quoted };
    if (mode === 'app-server')
      s.codexAppServer = { prompt: quoted, model: null, effort: null, execArgs: ['exec'] };
    await expect(recheckSandboxToolchain(s, 'image:tag', runner)).rejects.toThrow(
      'Sandbox toolchain advisory does not match its stamped prompt position',
    );
    expect(JSON.stringify(s)).toContain('haive_sandbox_toolchain');
  },
);

it('retains first-match removal for a legacy stamp even with an earlier full quote', async () => {
  const prefix = `Quoted:\n${block}\n\nEnd.\n`;
  const s = { ...spec(), args: [prefix + prompt] };
  expect((await recheckSandboxToolchain(s, 'image:tag', runner)).spec.args).toEqual([
    `Quoted:\nEnd.\n${prompt}`,
  ]);
});
