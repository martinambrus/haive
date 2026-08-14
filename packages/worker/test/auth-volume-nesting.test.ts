import { describe, expect, it } from 'vitest';
import { assertNoAuthVolumeNesting, type SandboxExtraFile } from '../src/sandbox/sandbox-runner.js';
import type { DockerVolumeMount } from '../src/sandbox/docker-runner.js';
import { resolveTaskAuthMounts } from '../src/sandbox/task-auth-volume.js';
import { worktreeGitfileMask } from '../src/queues/cli-exec/gitfile-mask.js';

const repoMount: DockerVolumeMount = { source: 'haive_repos', target: '/haive/workdir' };

function file(containerPath: string): SandboxExtraFile {
  return { containerPath, content: '' };
}

describe('assertNoAuthVolumeNesting', () => {
  // The masks are the reason this cannot be a blanket "no nested extra files" rule: every secret
  // mask and the worktree gitfile mask sit under the repo mount by design.
  it('allows masks nested under the repo mount', () => {
    expect(() =>
      assertNoAuthVolumeNesting(
        [
          ...worktreeGitfileMask(true),
          file('/haive/workdir/.env'),
          file('/haive/workdir/web/x.key'),
        ],
        [repoMount],
      ),
    ).not.toThrow();
  });

  it('rejects a file inside an auth-volume mount', () => {
    const mounts = [repoMount, ...resolveTaskAuthMounts('grok', 'task-1')];
    expect(() => assertNoAuthVolumeNesting([file('/home/node/.grok/config.toml')], mounts)).toThrow(
      'is inside the auth-volume mount /home/node/.grok',
    );
  });

  it('names the offending file and the mount it collides with', () => {
    const mounts = resolveTaskAuthMounts('codex', 'task-2');
    let message = '';
    try {
      assertNoAuthVolumeNesting([file('/home/node/.codex/config.toml')], mounts);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('/home/node/.codex/config.toml');
    expect(message).toContain('/home/node/.codex');
  });

  // The mount target itself is a directory Docker already creates; only paths BENEATH it are the
  // problem, and a sibling that merely shares a prefix must not be caught.
  it('ignores the mount target itself and prefix look-alikes', () => {
    const mounts = resolveTaskAuthMounts('grok', 'task-3');
    expect(() => assertNoAuthVolumeNesting([file('/home/node/.grok')], mounts)).not.toThrow();
    expect(() =>
      assertNoAuthVolumeNesting([file('/home/node/.grok-notes/x.json')], mounts),
    ).not.toThrow();
  });

  it('passes when no auth mounts are present at all', () => {
    expect(() => assertNoAuthVolumeNesting([file('/haive/mcp.json')], [repoMount])).not.toThrow();
  });
});
