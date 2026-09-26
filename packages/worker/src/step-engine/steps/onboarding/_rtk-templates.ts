import type { CliProviderName, TemplateItem, TemplateRendering } from '@haive/shared';
import {
  RTK_REF_MARKER_END,
  RTK_REF_MARKER_START,
  RTK_SLIM,
  rtkSettingsNeeded,
} from '@haive/shared';

export { RTK_REF_MARKER_END, RTK_REF_MARKER_START, RTK_SLIM };

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

/** Which providers get the project-level `.claude/settings.json` rtk hook: the family
 *  `RTK_SETTINGS_READERS` names. 07-generate-files.ts calls this rather than keeping its own copy,
 *  since a second list is how ollama once went missing from one of them. */
export function hasClaudeFamily(ctx: RtkRenderInputs): boolean {
  return rtkSettingsNeeded(
    'rtk.claude-settings',
    ctx.enabledCliProviders.map((p) => p.name),
  );
}

export function hasGemini(ctx: RtkRenderInputs): boolean {
  return rtkSettingsNeeded(
    'rtk.gemini-settings',
    ctx.enabledCliProviders.map((p) => p.name),
  );
}

/** Hook block written to `.claude/settings.json` (claude-code, zai). Shape
 *  pulled verbatim from rtk's `insert_hook_entry` (PreToolUse → Bash matcher
 *  → command). Once rtk is disabled the next upgrade offers this file for
 *  removal as `obsolete`, and keeps it when it no longer holds these bytes. */
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

const RTK_SETTINGS_HOOKS: Readonly<Record<string, { eventKey: string; command: string }>> = {
  'rtk.claude-settings': { eventKey: 'PreToolUse', command: RTK_HOOK_CLAUDE_COMMAND },
  'rtk.gemini-settings': { eventKey: 'BeforeTool', command: RTK_HOOK_GEMINI_COMMAND },
};

/** A settings file without the hook its RTK template wrote: every hook item whose command is exactly
 *  RTK's, and each entry, event list and `hooks` object that leaves empty, written back with the
 *  file's own indent, line endings and final newline. Null when it holds no such hook, is not
 *  strict JSON, or is a file that parsing and writing back would change anywhere else. */
export function withoutRtkHookEntry(templateId: string, text: string): string | null {
  const hook = RTK_SETTINGS_HOOKS[templateId];
  if (!hook) return null;
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return null;
  }
  const indent = /^[ \t]+(?=\S)/m.exec(text)?.[0] ?? '';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const serialize = (value: unknown) => {
    const body = JSON.stringify(value, null, indent).replace(/\n/g, eol);
    return /\n$/.test(text) ? `${body}${eol}` : body;
  };
  // A value a parse cannot keep as written (an integer past 2^53, `1.0`, an escape, a repeated key)
  // would be rewritten with the hook, and one nested too deep cannot be written at all, so only a
  // file that round-trips exactly is edited.
  try {
    if (serialize(root) !== text) return null;
  } catch {
    return null;
  }
  if (!isRecord(root) || !isRecord(root.hooks)) return null;
  const hooks = root.hooks;
  const entries = hooks[hook.eventKey];
  if (!Array.isArray(entries)) return null;
  let removed = false;
  const kept = entries.filter((entry) => {
    if (!isRecord(entry) || !Array.isArray(entry.hooks)) return true;
    const items = entry.hooks.filter((item) => !(isRecord(item) && item.command === hook.command));
    if (items.length === entry.hooks.length) return true;
    removed = true;
    entry.hooks = items;
    return items.length > 0;
  });
  if (!removed) return null;
  if (kept.length > 0) hooks[hook.eventKey] = kept;
  else delete hooks[hook.eventKey];
  if (Object.keys(hooks).length === 0) delete root.hooks;
  return serialize(root);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
