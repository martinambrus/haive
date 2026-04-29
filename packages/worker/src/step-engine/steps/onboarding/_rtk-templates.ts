import type { CliProviderName, TemplateItem, TemplateRendering } from '@haive/shared';

/** Slim RTK awareness body written to `.claude/RTK.md`, `.gemini/RTK.md`, and
 *  the repo-root `RTK.md` for codex/amp. Vendored from rtk-ai/rtk@v0.37.2
 *  `src/hooks/init.rs` (RTK_SLIM constant). Re-vendor on rtk version bump. */
export const RTK_SLIM = `# RTK (Rust Token Killer)

RTK is installed in this sandbox and proxies common dev commands so their
output is compressed before it lands in your context. Most git, npm, pnpm,
docker, kubectl, pytest, jest, eslint, tsc, curl, and log-tail invocations
are auto-routed via the configured PreToolUse / BeforeTool hook — you do
not need to invoke \`rtk\` explicitly.

Meta commands you can run directly:

- \`rtk gain\` — show cumulative token savings for this session
- \`rtk gain --history\` — per-command savings history
- \`rtk discover\` — analyze recent runs for missed opportunities
- \`rtk proxy <cmd>\` — bypass filters (debugging only)

Trust the hook. If a command output looks unexpectedly compact, that is RTK
working as intended — re-run with \`rtk proxy <cmd>\` only when you suspect
filtering is hiding a real signal.
`;

/** Codex consumes plain markdown; same body as RTK_SLIM today, kept as a
 *  separate constant so we can diverge later (e.g. tooling-specific examples). */
export const RTK_SLIM_CODEX = RTK_SLIM;

/** Marker pair wrapping the `@RTK.md` reference appended into CLAUDE.md /
 *  AGENTS.md / GEMINI.md by step 07. Lets a later upgrade replace or strip
 *  the block cleanly when rtk is toggled off. */
export const RTK_REF_MARKER_START = '<!-- haive:rtk-ref -->';
export const RTK_REF_MARKER_END = '<!-- /haive:rtk-ref -->';

/** Hook commands invoked by each CLI's runtime when an RTK-managed event
 *  fires. Mirrors rtk's own `CLAUDE_HOOK_COMMAND` / gemini hook command. */
export const RTK_HOOK_CLAUDE_COMMAND = 'rtk hook claude';
export const RTK_HOOK_GEMINI_COMMAND = 'rtk hook gemini';

/** Files that step 07's apply must route through `appendOrCreate` with the
 *  rtk-ref markers — every other rtk-config rendering is a plain
 *  `writeIfAllowed`. Worker code reads this list to branch correctly. */
export const RTK_REF_TARGETS = new Set<string>(['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']);

/** Minimal slice of `TemplateRenderContext` that rtk factories actually read.
 *  Declared locally so this module has no dependency on the manifest module
 *  and can be imported by both step-engine and sandbox code without cycles. */
export interface RtkRenderInputs {
  rtkEnabled: boolean;
  enabledCliProviders: ReadonlyArray<{ name: CliProviderName }>;
}

function hasClaudeFamily(ctx: RtkRenderInputs): boolean {
  return ctx.enabledCliProviders.some((p) => p.name === 'claude-code' || p.name === 'zai');
}

function hasGemini(ctx: RtkRenderInputs): boolean {
  return ctx.enabledCliProviders.some((p) => p.name === 'gemini');
}

function hasCodexOrAmp(ctx: RtkRenderInputs): boolean {
  return ctx.enabledCliProviders.some((p) => p.name === 'codex' || p.name === 'amp');
}

/** Hook block written to `.claude/settings.json` (claude-code, zai). Shape
 *  pulled verbatim from rtk's `insert_hook_entry` (PreToolUse → Bash matcher
 *  → command). When rtk is later disabled the upgrade flow surfaces this
 *  file as `obsolete` and removes it on apply. */
export function buildClaudeSettingsJson(): string {
  const obj = {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: RTK_HOOK_CLAUDE_COMMAND }],
        },
      ],
    },
  };
  return `${JSON.stringify(obj, null, 2)}\n`;
}

/** Gemini hook block. `BeforeTool` + `run_shell_command` matcher come from
 *  rtk's `patch_gemini_settings`. */
export function buildGeminiSettingsJson(): string {
  const obj = {
    hooks: {
      BeforeTool: [
        {
          matcher: 'run_shell_command',
          hooks: [{ type: 'command', command: RTK_HOOK_GEMINI_COMMAND }],
        },
      ],
    },
  };
  return `${JSON.stringify(obj, null, 2)}\n`;
}

/** Body of the marker-wrapped `@RTK.md` block appended into AGENTS.md /
 *  CLAUDE.md / GEMINI.md. The leading/trailing newlines around the markers
 *  match the convention `appendOrCreate` already uses for project info. */
export function buildRtkMdRefBlock(refLine: string): string {
  return `${RTK_REF_MARKER_START}\n${refLine}\n${RTK_REF_MARKER_END}\n`;
}

/** Build all rtk template items in a single call. Caller registers the
 *  result alongside the existing manifest items in `buildTemplateItems()`. */
export function buildRtkTemplateItems<TCtx extends RtkRenderInputs>(): TemplateItem<TCtx>[] {
  return [
    rtkClaudeSettingsItem<TCtx>(),
    rtkClaudeRtkMdItem<TCtx>(),
    rtkClaudeMdRefItem<TCtx>(),
    rtkGeminiSettingsItem<TCtx>(),
    rtkGeminiRtkMdItem<TCtx>(),
    rtkGeminiMdRefItem<TCtx>(),
    rtkAgentsRtkMdItem<TCtx>(),
    rtkAgentsMdRefItem<TCtx>(),
  ];
}

function rtkClaudeSettingsItem<TCtx extends RtkRenderInputs>(): TemplateItem<TCtx> {
  return {
    id: 'rtk.claude-settings',
    kind: 'rtk-config',
    schemaVersion: 1,
    render(ctx): TemplateRendering[] {
      if (!ctx.rtkEnabled || !hasClaudeFamily(ctx)) return [];
      return [{ diskPath: '.claude/settings.json', content: buildClaudeSettingsJson() }];
    },
  };
}

function rtkClaudeRtkMdItem<TCtx extends RtkRenderInputs>(): TemplateItem<TCtx> {
  return {
    id: 'rtk.claude-rtk-md',
    kind: 'rtk-config',
    schemaVersion: 1,
    render(ctx): TemplateRendering[] {
      if (!ctx.rtkEnabled || !hasClaudeFamily(ctx)) return [];
      return [{ diskPath: '.claude/RTK.md', content: RTK_SLIM }];
    },
  };
}

function rtkClaudeMdRefItem<TCtx extends RtkRenderInputs>(): TemplateItem<TCtx> {
  return {
    id: 'rtk.claude-md-ref',
    kind: 'rtk-config',
    schemaVersion: 1,
    render(ctx): TemplateRendering[] {
      if (!ctx.rtkEnabled || !hasClaudeFamily(ctx)) return [];
      return [{ diskPath: 'CLAUDE.md', content: buildRtkMdRefBlock('@.claude/RTK.md') }];
    },
  };
}

function rtkGeminiSettingsItem<TCtx extends RtkRenderInputs>(): TemplateItem<TCtx> {
  return {
    id: 'rtk.gemini-settings',
    kind: 'rtk-config',
    schemaVersion: 1,
    render(ctx): TemplateRendering[] {
      if (!ctx.rtkEnabled || !hasGemini(ctx)) return [];
      return [{ diskPath: '.gemini/settings.json', content: buildGeminiSettingsJson() }];
    },
  };
}

function rtkGeminiRtkMdItem<TCtx extends RtkRenderInputs>(): TemplateItem<TCtx> {
  return {
    id: 'rtk.gemini-rtk-md',
    kind: 'rtk-config',
    schemaVersion: 1,
    render(ctx): TemplateRendering[] {
      if (!ctx.rtkEnabled || !hasGemini(ctx)) return [];
      return [{ diskPath: '.gemini/RTK.md', content: RTK_SLIM }];
    },
  };
}

function rtkGeminiMdRefItem<TCtx extends RtkRenderInputs>(): TemplateItem<TCtx> {
  return {
    id: 'rtk.gemini-md-ref',
    kind: 'rtk-config',
    schemaVersion: 1,
    render(ctx): TemplateRendering[] {
      if (!ctx.rtkEnabled || !hasGemini(ctx)) return [];
      return [{ diskPath: 'GEMINI.md', content: buildRtkMdRefBlock('@.gemini/RTK.md') }];
    },
  };
}

function rtkAgentsRtkMdItem<TCtx extends RtkRenderInputs>(): TemplateItem<TCtx> {
  return {
    id: 'rtk.agents-rtk-md',
    kind: 'rtk-config',
    schemaVersion: 1,
    render(ctx): TemplateRendering[] {
      if (!ctx.rtkEnabled || !hasCodexOrAmp(ctx)) return [];
      return [{ diskPath: 'RTK.md', content: RTK_SLIM_CODEX }];
    },
  };
}

function rtkAgentsMdRefItem<TCtx extends RtkRenderInputs>(): TemplateItem<TCtx> {
  return {
    id: 'rtk.agents-md-ref',
    kind: 'rtk-config',
    schemaVersion: 1,
    render(ctx): TemplateRendering[] {
      if (!ctx.rtkEnabled || !hasCodexOrAmp(ctx)) return [];
      return [{ diskPath: 'AGENTS.md', content: buildRtkMdRefBlock('@RTK.md') }];
    },
  };
}

/** Merge-aware insertion of an RTK hook into a parsed JSON settings tree
 *  (Claude `~/.claude/settings.json`, Gemini `~/.gemini/settings.json`).
 *  Mirrors rtk's own `insert_hook_entry` and `hook_already_present` logic
 *  from `src/hooks/init.rs` — idempotent on the command string, preserves
 *  every unrelated key in the tree. Returns `true` if the tree was modified.
 *
 *  Used by the per-task auth-volume seeder to layer rtk on top of any
 *  user-supplied settings.json that the CLI auth restore produced (Claude
 *  Code creates one with theme/onboarding state on first login). Project-
 *  level files written by step 07 do NOT use this helper — they are
 *  haive-managed end-to-end. */
export function insertRtkHookEntry(
  root: Record<string, unknown>,
  eventKey: 'PreToolUse' | 'BeforeTool',
  matcher: string,
  command: string,
): boolean {
  const hooks = ensureObject(root, 'hooks');
  const eventArr = ensureArray(hooks, eventKey);
  if (hookEntryAlreadyPresent(eventArr, command)) return false;
  eventArr.push({
    matcher,
    hooks: [{ type: 'command', command }],
  });
  return true;
}

function ensureObject(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = parent[key];
  if (current && typeof current === 'object' && !Array.isArray(current)) {
    return current as Record<string, unknown>;
  }
  const fresh: Record<string, unknown> = {};
  parent[key] = fresh;
  return fresh;
}

function ensureArray(parent: Record<string, unknown>, key: string): unknown[] {
  const current = parent[key];
  if (Array.isArray(current)) return current;
  const fresh: unknown[] = [];
  parent[key] = fresh;
  return fresh;
}

function hookEntryAlreadyPresent(arr: ReadonlyArray<unknown>, command: string): boolean {
  for (const entry of arr) {
    if (!entry || typeof entry !== 'object') continue;
    const hooksField = (entry as { hooks?: unknown }).hooks;
    if (!Array.isArray(hooksField)) continue;
    for (const h of hooksField) {
      if (!h || typeof h !== 'object') continue;
      const cmd = (h as { command?: unknown }).command;
      if (typeof cmd === 'string' && cmd === command) return true;
    }
  }
  return false;
}
