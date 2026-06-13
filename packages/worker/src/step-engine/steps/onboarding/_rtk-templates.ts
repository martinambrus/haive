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

/** Marker pair wrapping the RTK awareness block inlined into AGENTS.md by
 *  step 07. Lets `stripHaiveContent` (onboarding reset) and a re-run strip or
 *  refresh the block cleanly. The `rtk-ref` slug is retained for backwards
 *  compatibility with blocks written by earlier Haive versions. */
export const RTK_REF_MARKER_START = '<!-- haive:rtk-ref -->';
export const RTK_REF_MARKER_END = '<!-- /haive:rtk-ref -->';

/** Hook commands invoked by each CLI's runtime when an RTK-managed event
 *  fires. Mirrors rtk's own `CLAUDE_HOOK_COMMAND` / gemini hook command. */
export const RTK_HOOK_CLAUDE_COMMAND = 'rtk hook claude';
export const RTK_HOOK_GEMINI_COMMAND = 'rtk hook gemini';

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

/** Marker-wrapped RTK awareness block inlined into AGENTS.md — the single
 *  rules source every CLI reads (codex/amp/antigravity natively; claude/zai/
 *  gemini via `@AGENTS.md`). Inlined rather than an `@RTK.md` reference because
 *  native AGENTS.md readers do not expand `@` imports. */
export function buildRtkAwarenessBlock(): string {
  return `${RTK_REF_MARKER_START}\n${RTK_SLIM}${RTK_REF_MARKER_END}\n`;
}

/** Build all rtk template items in a single call. Caller registers the
 *  result alongside the existing manifest items in `buildTemplateItems()`.
 *
 *  Only the per-CLI hook settings files are manifest-tracked. They are
 *  dedicated, single-purpose files, so the upgrade path's whole-file
 *  overwrite/delete is safe for them. The RTK awareness *markdown* is NOT a
 *  manifest item: it is inlined into AGENTS.md (alongside project-info and
 *  cli-rules, which are likewise step-07-only) via `buildRtkAwarenessBlock`,
 *  because a manifest item pointing at AGENTS.md would let an upgrade clobber
 *  or delete the whole project-spec + rules file. */
export function buildRtkTemplateItems<TCtx extends RtkRenderInputs>(): TemplateItem<TCtx>[] {
  return [rtkClaudeSettingsItem<TCtx>(), rtkGeminiSettingsItem<TCtx>()];
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
