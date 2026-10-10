import { describe, it, expect } from 'vitest';
import { codeAuditStep } from './08c2-code-audit.js';

describe('08c2 change-set guard', () => {
  const detect = (implementationFiles: unknown) => ({
    spec: 'the spec',
    implementationFiles,
  });

  it('refuses to build the audit prompt when no changed file is known', () => {
    // The auditor's prompt used to fall back to "determine the recently-changed files from
    // the workspace and read each in full". It cannot: git is masked inside the sandbox
    // (worktreeGitfileMask), so the only thing it can read is the whole project — which is
    // the repo-wide audit the changed-file list exists to prevent. Guarded in buildPrompt
    // rather than detect() so a replayed detect_output is covered too.
    expect(() =>
      codeAuditStep.llm!.buildPrompt!({
        detected: detect({ files: [], total: 0, truncated: false, scanError: null }),
      } as never),
    ).toThrow(/08c2-code-audit has no changed files to review/);
  });

  it('names the failed scan rather than blaming the implementation', () => {
    // A broken worktree and an implementation that wrote nothing are different facts, and
    // the message is what a human acts on.
    expect(() =>
      codeAuditStep.llm!.buildPrompt!({
        detected: detect({
          files: [],
          total: 0,
          truncated: false,
          scanError: 'fatal: not a git repository',
        }),
      } as never),
    ).toThrow(/the worktree scan failed \(git: fatal: not a git repository\)/);
  });

  it('tells the auditor the list may lack files of the change when the scan of it failed', () => {
    const prompt = (scanError: string | null) =>
      codeAuditStep.llm!.buildPrompt!({
        detected: detect({ files: ['src/a.ts'], total: 1, truncated: false, scanError }),
      } as never);

    expect(prompt('git failed')).toContain('COVERAGE: the change could not be read in full');
    expect(prompt('git failed')).toContain('do NOT report a clean result');
    expect(prompt(null)).not.toContain('could not be read in full');
  });

  it('stores the failed scan on the coverage the gate reads, and leaves the flag off where it ran', async () => {
    const run = (scanError: string | null) =>
      codeAuditStep.apply(
        {} as never,
        {
          detected: detect({ files: ['src/a.ts'], total: 1, truncated: false, scanError }),
          llmOutput: '```json\n{"findings":[]}\n```',
        } as never,
      );

    expect((await run('git failed')).coverage).toEqual({
      listed: 1,
      total: 1,
      truncated: false,
      scanFailed: true,
    });
    expect((await run(null)).coverage).toEqual({ listed: 1, total: 1, truncated: false });
  });

  it('builds the prompt with the changed files listed when there is a change set', () => {
    const prompt = codeAuditStep.llm!.buildPrompt!({
      detected: detect({ files: ['src/a.ts'], total: 1, truncated: false, scanError: null }),
    } as never);
    expect(prompt).toContain('Changed files to review (read each in full):\n- src/a.ts');
    expect(prompt).not.toContain('Do NOT try to work out what changed');
  });
});
