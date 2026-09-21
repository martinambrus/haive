import { describe, expect, it, vi } from 'vitest';

// The sandbox and the mirror lookup are the faked boundaries: the spawner's composition of what
// gets mounted is real, as in sandbox-config-files.test.ts.
const runInSandbox = vi.hoisted(() => vi.fn());
vi.mock('../src/sandbox/sandbox-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sandbox/sandbox-runner.js')>()),
  runInSandbox,
}));
const resolveRepoMirrors = vi.hoisted(() => vi.fn());
vi.mock('../src/queues/cli-exec/repo-mirrors.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/queues/cli-exec/repo-mirrors.js')>()),
  resolveRepoMirrors,
}));

import { createSandboxSpawner } from '../src/queues/cli-exec/exec-core.js';
import { AntigravityAdapter } from '../src/cli-adapters/antigravity.js';
import { SANDBOX_WORKDIR } from '../src/sandbox/sandbox-runner.js';
import type { CliProviderRecord } from '../src/cli-adapters/types.js';
import type { DockerVolumeMount } from '../src/sandbox/docker-runner.js';

const provider = {
  id: 'prov-agy',
  name: 'antigravity',
  wrapperPath: null,
  executablePath: null,
  cliArgs: [],
  envVars: {},
  effortLevel: null,
  model: null,
} as unknown as CliProviderRecord;

describe('sandbox spawner: repo mirrors', () => {
  it("passes the adapter's mirrors and the run's own tree to the resolver, and mounts what it returns", async () => {
    runInSandbox.mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 1,
      timedOut: false,
      resolvedCommand: 'agy',
      wrapperId: null,
    });
    const skillsMount: DockerVolumeMount = {
      source: 'haive_repos',
      target: '/home/node/.gemini/config/skills',
      subpath: 'u/r/.agents/skills',
      readOnly: true,
    };
    const agentFile = {
      containerPath: '/home/node/.gemini/config/agents/code-reviewer/agent.md',
      content: '---\nname: code-reviewer\ndescription: Reviews.\n---\n',
    };
    resolveRepoMirrors.mockResolvedValue({ mounts: [skillsMount], files: [agentFile] });
    const spec = new AntigravityAdapter().buildCliInvocation(provider, 'do x', {});
    const repoMount: DockerVolumeMount = {
      source: 'haive_repos',
      target: SANDBOX_WORKDIR,
      subpath: 'u/r',
    };
    const mask = { containerPath: `${SANDBOX_WORKDIR}/.env`, content: '' };

    await createSandboxSpawner(null, null, repoMount, SANDBOX_WORKDIR, null, [], [mask])(spec);

    // `undefined` is the positional storageRoot, left as the resolver's own default.
    expect(resolveRepoMirrors).toHaveBeenCalledWith(spec.repoMirrors, repoMount, undefined, {
      maskAgentDefinitions: false,
    });
    const [runSpec, options] = runInSandbox.mock.calls[0]! as [
      { extraFiles: { containerPath: string }[] },
      { extraMounts: DockerVolumeMount[] },
    ];
    expect(options.extraMounts).toContainEqual(skillsMount);
    // Masks first: the runner keeps the FIRST claim on a path, so a mirrored file never displaces one.
    expect(runSpec.extraFiles.map((f) => f.containerPath)).toEqual([
      mask.containerPath,
      agentFile.containerPath,
    ]);
  });

  it('tells the resolver to drop the agent mirror when the invocation is isolated', async () => {
    // agy loads its agents from `~/.gemini/config`, not the workspace, so the mirror bypassed the
    // workspace mask entirely and per-call isolation was inert for this provider. The rule lives in
    // resolveRepoMirrors; what this asserts is that the spawner actually tells it — the argument
    // could be deleted and every unit test of the rule itself would still pass.
    runInSandbox.mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 1,
      timedOut: false,
      resolvedCommand: 'agy',
      wrapperId: null,
    });
    resolveRepoMirrors.mockResolvedValue({ mounts: [], files: [] });
    const spec = new AntigravityAdapter().buildCliInvocation(provider, 'do x', {});
    spec.maskAgentDefinitions = true;
    const repoMount: DockerVolumeMount = {
      source: 'haive_repos',
      target: SANDBOX_WORKDIR,
      subpath: 'u/r',
    };

    await createSandboxSpawner(null, null, repoMount, SANDBOX_WORKDIR)(spec);

    expect(resolveRepoMirrors).toHaveBeenCalledWith(spec.repoMirrors, repoMount, undefined, {
      maskAgentDefinitions: true,
    });
  });
});
