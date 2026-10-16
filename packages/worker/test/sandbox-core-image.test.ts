import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CORE_IDENTITY_LABEL,
  ensureSandboxCoreImage,
  SANDBOX_CORE_IMAGE_HEADLINE,
  sandboxCoreIdentity,
} from '../src/sandbox/sandbox-core-image.js';
import type { DockerBuildOpts, DockerRunner } from '../src/sandbox/docker-runner.js';

const CORE = 'haive-cli-sandbox:latest';

interface Recorder {
  runner: DockerRunner;
  inspects: string[];
  builds: DockerBuildOpts[];
  release: () => void;
}

/** `exists` and `labels` answer every inspect. `gate` (when true) holds each build open until
 *  `release()` so a test can have several callers in flight at once. */
function makeRunner(opts: {
  exists: boolean;
  labels?: Record<string, string>;
  exitCode?: number;
  gate?: boolean;
}): Recorder {
  const inspects: string[] = [];
  const builds: DockerBuildOpts[] = [];
  let unblock = () => {};
  const gate = opts.gate ? new Promise<void>((resolve) => (unblock = resolve)) : null;

  const runner = {
    inspect: async (tag: string) => {
      inspects.push(tag);
      return opts.exists
        ? { exists: true, imageId: 'sha256:abc', labels: opts.labels ?? {} }
        : { exists: false, imageId: null };
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
  delete process.env.SANDBOX_CORE_CONTEXT;
});

describe('ensureSandboxCoreImage', () => {
  it('does not build when the image on the host carries the current identity', async () => {
    const r = makeRunner({
      exists: true,
      labels: { [CORE_IDENTITY_LABEL]: sandboxCoreIdentity() },
    });
    await ensureSandboxCoreImage(CORE, r.runner);
    expect(r.inspects).toEqual([CORE]);
    expect(r.builds).toHaveLength(0);
  });

  // What the label is for: an install that already had the base kept it through every release
  // that changed what it is built from, so an rtk bump reached fresh installs only.
  it('rebuilds an image built from another definition', async () => {
    const r = makeRunner({ exists: true, labels: { [CORE_IDENTITY_LABEL]: 'an-older-one' } });
    await ensureSandboxCoreImage(CORE, r.runner);
    expect(r.builds).toHaveLength(1);
    expect(r.builds[0]?.buildArgs?.HAIVE_CORE_IDENTITY).toBe(sandboxCoreIdentity());
  });

  it('rebuilds an image with no identity: a hand build, or one from before the label', async () => {
    const r = makeRunner({ exists: true });
    await ensureSandboxCoreImage(CORE, r.runner);
    expect(r.builds).toHaveLength(1);
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

  it('forwards rtk build args only when they are pinned, beside the identity', async () => {
    const bare = makeRunner({ exists: false });
    await ensureSandboxCoreImage(CORE, bare.runner);
    expect(bare.builds[0]?.buildArgs).toEqual({ HAIVE_CORE_IDENTITY: sandboxCoreIdentity() });

    process.env.RTK_RELEASE_VERSION = 'v0.99.0';
    process.env.RTK_X86_64_MUSL_SHA256 = 'deadbeef';
    const pinned = makeRunner({ exists: false });
    await ensureSandboxCoreImage(CORE, pinned.runner);
    expect(pinned.builds[0]?.buildArgs).toEqual({
      RTK_RELEASE_VERSION: 'v0.99.0',
      RTK_X86_64_MUSL_SHA256: 'deadbeef',
      HAIVE_CORE_IDENTITY: sandboxCoreIdentity(),
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

describe('sandboxCoreIdentity', () => {
  // Every file of the context goes into the image (restore-claude.sh is COPYed), so an edit to any
  // of them is a new definition, and a pinned rtk arg builds another image from the same files.
  it('follows every file of the build context and the pinned build args', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'core-context-'));
    try {
      await mkdir(join(dir, 'sub'));
      await writeFile(join(dir, 'Dockerfile'), 'FROM scratch\n');
      await writeFile(join(dir, 'sub', 'helper.sh'), 'echo one\n');
      process.env.SANDBOX_CORE_CONTEXT = dir;
      const first = sandboxCoreIdentity();
      expect(sandboxCoreIdentity()).toBe(first);

      await writeFile(join(dir, 'sub', 'helper.sh'), 'echo two\n');
      const edited = sandboxCoreIdentity();
      expect(edited).not.toBe(first);

      process.env.RTK_RELEASE_VERSION = 'v9.9.9';
      expect(sandboxCoreIdentity()).not.toBe(edited);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Compose hands the worker both rtk variables, empty when the operator pinned nothing, so an
  // empty one must build, and stamp, exactly what an unset one does.
  it('reads an empty rtk variable as unpinned, as compose passes it then', async () => {
    const unset = sandboxCoreIdentity();
    process.env.RTK_RELEASE_VERSION = '';
    process.env.RTK_X86_64_MUSL_SHA256 = '';
    expect(sandboxCoreIdentity()).toBe(unset);
    const r = makeRunner({ exists: false });
    await ensureSandboxCoreImage(CORE, r.runner);
    expect(r.builds[0]?.buildArgs).toEqual({ HAIVE_CORE_IDENTITY: unset });
  });
});
