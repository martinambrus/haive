import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureSandboxCoreImage,
  SANDBOX_CORE_IMAGE_HEADLINE,
} from '../src/sandbox/sandbox-core-image.js';
import type { DockerBuildOpts, DockerRunner } from '../src/sandbox/docker-runner.js';

const CORE = 'haive-cli-sandbox:latest';

interface Recorder {
  runner: DockerRunner;
  inspects: string[];
  builds: DockerBuildOpts[];
  release: () => void;
}

/** `exists` answers every inspect. `gate` (when true) holds each build open until
 *  `release()` so a test can have several callers in flight at once. */
function makeRunner(opts: { exists: boolean; exitCode?: number; gate?: boolean }): Recorder {
  const inspects: string[] = [];
  const builds: DockerBuildOpts[] = [];
  let unblock = () => {};
  const gate = opts.gate ? new Promise<void>((resolve) => (unblock = resolve)) : null;

  const runner = {
    inspect: async (tag: string) => {
      inspects.push(tag);
      return { exists: opts.exists, imageId: opts.exists ? 'sha256:abc' : null };
    },
    build: async (buildOpts: DockerBuildOpts) => {
      builds.push(buildOpts);
      if (gate) await gate;
      return {
        exitCode: opts.exitCode ?? 0,
        imageTag: buildOpts.tag,
        imageId: 'sha256:def',
        durationMs: 1,
        stderr: opts.exitCode === 0 || opts.exitCode === undefined ? '' : 'pull access denied',
        timedOut: false,
      };
    },
  } as unknown as DockerRunner;

  return { runner, inspects, builds, release: () => unblock() };
}

afterEach(() => {
  delete process.env.RTK_RELEASE_VERSION;
  delete process.env.RTK_X86_64_MUSL_SHA256;
});

describe('ensureSandboxCoreImage', () => {
  it('does not build when the image is already on the host', async () => {
    const r = makeRunner({ exists: true });
    await ensureSandboxCoreImage(CORE, r.runner);
    expect(r.inspects).toEqual([CORE]);
    expect(r.builds).toHaveLength(0);
  });

  it('builds the core tag when the image is missing', async () => {
    const r = makeRunner({ exists: false });
    await ensureSandboxCoreImage(CORE, r.runner);
    expect(r.builds).toHaveLength(1);
    expect(r.builds[0]?.tag).toBe(CORE);
    expect(r.builds[0]?.contextDir).toMatch(/sandbox-image$/);
  });

  // The reason this is a promise and not a boolean flag: cli-exec runs several jobs at
  // once and each needs the base, so a flag set only on success lets every one of them
  // start the same multi-minute build.
  it('coalesces concurrent callers into a single build', async () => {
    const r = makeRunner({ exists: false, gate: true });
    const all = Promise.all([
      ensureSandboxCoreImage(CORE, r.runner),
      ensureSandboxCoreImage(CORE, r.runner),
      ensureSandboxCoreImage(CORE, r.runner),
    ]);
    r.release();
    await all;
    expect(r.builds).toHaveLength(1);
  });

  it('re-checks on the next call rather than caching the result', async () => {
    const r = makeRunner({ exists: false });
    await ensureSandboxCoreImage(CORE, r.runner);
    await ensureSandboxCoreImage(CORE, r.runner);
    expect(r.inspects).toHaveLength(2);
  });

  // An operator who pinned SANDBOX_IMAGE owns that image; building ours over their tag
  // would silently replace it.
  it('is inert for an image that is not the core tag', async () => {
    const r = makeRunner({ exists: false });
    await ensureSandboxCoreImage('my-registry.example/custom-sandbox:v3', r.runner);
    expect(r.inspects).toHaveLength(0);
    expect(r.builds).toHaveLength(0);
  });

  it('forwards rtk build args only when they are pinned', async () => {
    const bare = makeRunner({ exists: false });
    await ensureSandboxCoreImage(CORE, bare.runner);
    expect(bare.builds[0]?.buildArgs).toEqual({});

    process.env.RTK_RELEASE_VERSION = 'v0.99.0';
    process.env.RTK_X86_64_MUSL_SHA256 = 'deadbeef';
    const pinned = makeRunner({ exists: false });
    await ensureSandboxCoreImage(CORE, pinned.runner);
    expect(pinned.builds[0]?.buildArgs).toEqual({
      RTK_RELEASE_VERSION: 'v0.99.0',
      RTK_X86_64_MUSL_SHA256: 'deadbeef',
    });
  });

  // The whole point of the error copy: a failed build must name the remedy, not leave the
  // user reading docker's "pull access denied" and concluding they have an auth problem.
  it('fails with the remedy, keeping the build output as detail', async () => {
    const r = makeRunner({ exists: false, exitCode: 1 });
    await expect(ensureSandboxCoreImage(CORE, r.runner)).rejects.toThrow(
      SANDBOX_CORE_IMAGE_HEADLINE,
    );

    const again = makeRunner({ exists: false, exitCode: 1 });
    const err = await ensureSandboxCoreImage(CORE, again.runner).catch((e: unknown) => e);
    expect(String(err)).toContain('pnpm docker sandbox-build');
    expect(String(err)).toContain('pull access denied');
  });
});
