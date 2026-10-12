import { describe, expect, it, vi } from 'vitest';
import { loadDeclaredVerifyCommands } from './_task-meta.js';

const dbWith = (task: unknown, repo: unknown) =>
  ({
    query: {
      tasks: { findFirst: vi.fn(async () => task) },
      repositories: { findFirst: vi.fn(async () => repo) },
    },
  }) as never;
const log = () => ({ warn: vi.fn() });

describe('loadDeclaredVerifyCommands', () => {
  it('returns the stored commands, trimmed by the shared schema', async () => {
    const out = await loadDeclaredVerifyCommands(
      dbWith({ repositoryId: 'r' }, { verifyCommands: { test: ' make test ', lint: null } }),
      't',
      log() as never,
    );
    expect(out).toEqual({ test: 'make test', lint: null });
  });

  it('returns null for a task without a repository or a repository without commands', async () => {
    expect(await loadDeclaredVerifyCommands(dbWith({}, null), 't', log() as never)).toBeNull();
    expect(
      await loadDeclaredVerifyCommands(
        dbWith({ repositoryId: 'r' }, { verifyCommands: null }),
        't',
        log() as never,
      ),
    ).toBeNull();
  });

  it('treats an invalid stored value as absent and logs a warning', async () => {
    const l = log();
    const out = await loadDeclaredVerifyCommands(
      dbWith({ repositoryId: 'r' }, { verifyCommands: { test: 'a\nb', extra: 1 } }),
      't',
      l as never,
    );
    expect(out).toBeNull();
    expect(l.warn).toHaveBeenCalledTimes(1);
  });
});
