import type { CliProviderName, TemplateItem, TemplateRendering } from '@haive/shared';
import {
  RTK_REF_MARKER_END,
  RTK_REF_MARKER_START,
  RTK_SETTINGS_FILES,
  RTK_SLIM,
  rtkSettingsNeeded,
  type RtkSettingsFile,
} from '@haive/shared';

export { RTK_REF_MARKER_END, RTK_REF_MARKER_START, RTK_SLIM };
export {
  buildClaudeSettingsJson,
  buildGeminiSettingsJson,
  RTK_HOOK_CLAUDE_COMMAND,
  RTK_HOOK_GEMINI_COMMAND,
  withoutRtkHookEntry,
} from '@haive/shared';

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
  return RTK_SETTINGS_FILES.map((file) => rtkSettingsItem<TCtx>(file));
}

function rtkSettingsItem<TCtx extends RtkRenderInputs>(file: RtkSettingsFile): TemplateItem<TCtx> {
  return {
    id: file.templateId,
    kind: 'rtk-config',
    schemaVersion: 1,
    render(ctx): TemplateRendering[] {
      const providers = ctx.enabledCliProviders.map((p) => p.name);
      if (!ctx.rtkEnabled || !rtkSettingsNeeded(file.templateId, providers)) return [];
      return [{ diskPath: file.diskPath, content: file.render() }];
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
