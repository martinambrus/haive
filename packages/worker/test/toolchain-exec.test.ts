import { expect, it, vi } from 'vitest';
import {
  recheckSandboxToolchain,
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
    sandboxToolchain: { imageId: OLD, block },
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
