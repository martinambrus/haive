import { describe, expect, it } from 'vitest';
import type { CliProviderName } from '@haive/shared';
import {
  buildClaudeSettingsJson,
  buildGeminiSettingsJson,
  buildRtkMdRefBlock,
  buildRtkTemplateItems,
  insertRtkHookEntry,
  RTK_HOOK_CLAUDE_COMMAND,
  RTK_HOOK_GEMINI_COMMAND,
  RTK_REF_MARKER_END,
  RTK_REF_MARKER_START,
  RTK_SLIM,
  type RtkRenderInputs,
} from '../src/step-engine/steps/onboarding/_rtk-templates.js';

function ctx(rtkEnabled: boolean, enabledNames: ReadonlyArray<CliProviderName>): RtkRenderInputs {
  return {
    rtkEnabled,
    enabledCliProviders: enabledNames.map((name) => ({ name })),
  };
}

describe('buildRtkTemplateItems gating', () => {
  it('emits zero renderings when rtkEnabled=false', () => {
    const items = buildRtkTemplateItems<RtkRenderInputs>();
    const c = ctx(false, ['claude-code', 'gemini', 'codex', 'amp']);
    for (const item of items) {
      expect(item.render(c)).toEqual([]);
    }
  });

  it('emits zero renderings when rtkEnabled=true but no CLI is enabled', () => {
    const items = buildRtkTemplateItems<RtkRenderInputs>();
    const c = ctx(true, []);
    for (const item of items) {
      expect(item.render(c)).toEqual([]);
    }
  });

  it('claude-code enabled emits .claude/settings.json + .claude/RTK.md + CLAUDE.md ref', () => {
    const items = buildRtkTemplateItems<RtkRenderInputs>();
    const c = ctx(true, ['claude-code']);
    const paths = items
      .flatMap((i) => i.render(c))
      .map((r) => r.diskPath)
      .sort();
    expect(paths).toEqual(['.claude/RTK.md', '.claude/settings.json', 'CLAUDE.md']);
  });

  it('zai routes through the same .claude/ files as claude-code', () => {
    const items = buildRtkTemplateItems<RtkRenderInputs>();
    const c = ctx(true, ['zai']);
    const paths = items
      .flatMap((i) => i.render(c))
      .map((r) => r.diskPath)
      .sort();
    expect(paths).toEqual(['.claude/RTK.md', '.claude/settings.json', 'CLAUDE.md']);
  });

  it('gemini enabled emits .gemini/settings.json + .gemini/RTK.md + GEMINI.md ref', () => {
    const items = buildRtkTemplateItems<RtkRenderInputs>();
    const c = ctx(true, ['gemini']);
    const paths = items
      .flatMap((i) => i.render(c))
      .map((r) => r.diskPath)
      .sort();
    expect(paths).toEqual(['.gemini/RTK.md', '.gemini/settings.json', 'GEMINI.md']);
  });

  it('codex enabled emits repo-root RTK.md + AGENTS.md ref', () => {
    const items = buildRtkTemplateItems<RtkRenderInputs>();
    const c = ctx(true, ['codex']);
    const paths = items
      .flatMap((i) => i.render(c))
      .map((r) => r.diskPath)
      .sort();
    expect(paths).toEqual(['AGENTS.md', 'RTK.md']);
  });

  it('amp enabled routes through codex/agents-md path (no rtk-native flag, but project-level files still apply)', () => {
    const items = buildRtkTemplateItems<RtkRenderInputs>();
    const c = ctx(true, ['amp']);
    const paths = items
      .flatMap((i) => i.render(c))
      .map((r) => r.diskPath)
      .sort();
    expect(paths).toEqual(['AGENTS.md', 'RTK.md']);
  });

  it('all CLIs enabled together fans out across every config file', () => {
    const items = buildRtkTemplateItems<RtkRenderInputs>();
    const c = ctx(true, ['claude-code', 'gemini', 'codex', 'amp', 'zai']);
    const paths = items
      .flatMap((i) => i.render(c))
      .map((r) => r.diskPath)
      .sort();
    expect(paths).toEqual([
      '.claude/RTK.md',
      '.claude/settings.json',
      '.gemini/RTK.md',
      '.gemini/settings.json',
      'AGENTS.md',
      'CLAUDE.md',
      'GEMINI.md',
      'RTK.md',
    ]);
  });

  it('renders are deterministic — same context, same content', () => {
    const items = buildRtkTemplateItems<RtkRenderInputs>();
    const c = ctx(true, ['claude-code', 'codex']);
    const a = items.flatMap((i) => i.render(c));
    const b = items.flatMap((i) => i.render(c));
    expect(a).toEqual(b);
  });
});

describe('buildClaudeSettingsJson', () => {
  it('contains the PreToolUse Bash hook with the rtk hook claude command', () => {
    const json = buildClaudeSettingsJson();
    const parsed = JSON.parse(json) as {
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
    };
    expect(parsed.hooks.PreToolUse).toHaveLength(1);
    expect(parsed.hooks.PreToolUse[0]?.matcher).toBe('Bash');
    expect(parsed.hooks.PreToolUse[0]?.hooks[0]?.command).toBe(RTK_HOOK_CLAUDE_COMMAND);
  });

  it("ends with a trailing newline so file writes don't produce no-final-newline diffs", () => {
    expect(buildClaudeSettingsJson().endsWith('\n')).toBe(true);
  });
});

describe('buildGeminiSettingsJson', () => {
  it('contains the BeforeTool run_shell_command hook with the rtk hook gemini command', () => {
    const json = buildGeminiSettingsJson();
    const parsed = JSON.parse(json) as {
      hooks: { BeforeTool: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
    };
    expect(parsed.hooks.BeforeTool).toHaveLength(1);
    expect(parsed.hooks.BeforeTool[0]?.matcher).toBe('run_shell_command');
    expect(parsed.hooks.BeforeTool[0]?.hooks[0]?.command).toBe(RTK_HOOK_GEMINI_COMMAND);
  });
});

describe('buildRtkMdRefBlock', () => {
  it('wraps the @-ref line in the haive:rtk-ref marker pair', () => {
    const block = buildRtkMdRefBlock('@.claude/RTK.md');
    expect(block).toContain(RTK_REF_MARKER_START);
    expect(block).toContain(RTK_REF_MARKER_END);
    expect(block).toContain('@.claude/RTK.md');
  });
});

describe('insertRtkHookEntry', () => {
  it('creates the hooks tree from scratch when settings is empty', () => {
    const root: Record<string, unknown> = {};
    const changed = insertRtkHookEntry(root, 'PreToolUse', 'Bash', RTK_HOOK_CLAUDE_COMMAND);
    expect(changed).toBe(true);
    expect(root).toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: RTK_HOOK_CLAUDE_COMMAND }],
          },
        ],
      },
    });
  });

  it('preserves unrelated keys (theme, hasCompletedOnboarding) — does not clobber user state', () => {
    const root: Record<string, unknown> = {
      theme: 'dark',
      hasCompletedOnboarding: true,
      mcpServers: { foo: { command: 'foo' } },
    };
    insertRtkHookEntry(root, 'PreToolUse', 'Bash', RTK_HOOK_CLAUDE_COMMAND);
    expect(root.theme).toBe('dark');
    expect(root.hasCompletedOnboarding).toBe(true);
    expect(root.mcpServers).toEqual({ foo: { command: 'foo' } });
    expect((root.hooks as { PreToolUse: unknown[] }).PreToolUse).toHaveLength(1);
  });

  it('is idempotent — re-inserting the same command does not duplicate', () => {
    const root: Record<string, unknown> = {};
    expect(insertRtkHookEntry(root, 'PreToolUse', 'Bash', RTK_HOOK_CLAUDE_COMMAND)).toBe(true);
    expect(insertRtkHookEntry(root, 'PreToolUse', 'Bash', RTK_HOOK_CLAUDE_COMMAND)).toBe(false);
    expect(insertRtkHookEntry(root, 'PreToolUse', 'Bash', RTK_HOOK_CLAUDE_COMMAND)).toBe(false);
    const arr = (root.hooks as { PreToolUse: unknown[] }).PreToolUse;
    expect(arr).toHaveLength(1);
  });

  it('adds alongside an existing non-rtk PreToolUse entry without removing it', () => {
    const root: Record<string, unknown> = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Edit',
            hooks: [{ type: 'command', command: 'echo user-hook' }],
          },
        ],
      },
    };
    insertRtkHookEntry(root, 'PreToolUse', 'Bash', RTK_HOOK_CLAUDE_COMMAND);
    const arr = (root.hooks as { PreToolUse: Array<{ matcher: string }> }).PreToolUse;
    expect(arr).toHaveLength(2);
    expect(arr.some((e) => e.matcher === 'Edit')).toBe(true);
    expect(arr.some((e) => e.matcher === 'Bash')).toBe(true);
  });

  it('repairs a non-object hooks value by replacing it with an empty object', () => {
    const root: Record<string, unknown> = { hooks: 'corrupted' as unknown };
    insertRtkHookEntry(root, 'PreToolUse', 'Bash', RTK_HOOK_CLAUDE_COMMAND);
    expect(typeof root.hooks).toBe('object');
    expect(Array.isArray(root.hooks)).toBe(false);
  });

  it('repairs a non-array PreToolUse value by replacing it with an empty array', () => {
    const root: Record<string, unknown> = {
      hooks: { PreToolUse: { malformed: true } as unknown },
    };
    insertRtkHookEntry(root, 'PreToolUse', 'Bash', RTK_HOOK_CLAUDE_COMMAND);
    const arr = (root.hooks as { PreToolUse: unknown }).PreToolUse;
    expect(Array.isArray(arr)).toBe(true);
    expect((arr as unknown[]).length).toBe(1);
  });
});

describe('RTK_SLIM body', () => {
  it('mentions rtk gain for token savings inspection', () => {
    expect(RTK_SLIM).toContain('rtk gain');
  });

  it('mentions rtk proxy for the bypass debugging path', () => {
    expect(RTK_SLIM).toContain('rtk proxy');
  });
});
