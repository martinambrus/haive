/** Hook commands invoked by each CLI's runtime when an RTK-managed event
 *  fires. Mirrors rtk's own `CLAUDE_HOOK_COMMAND` / gemini hook command. */
export const RTK_HOOK_CLAUDE_COMMAND = 'rtk hook claude';
export const RTK_HOOK_GEMINI_COMMAND = 'rtk hook gemini';

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

/** The settings file each RTK template writes and the hook it puts there, stated once for the
 *  worker that renders them and the api that looks for them. */
export const RTK_SETTINGS_FILES = [
  {
    templateId: 'rtk.claude-settings',
    diskPath: '.claude/settings.json',
    eventKey: 'PreToolUse',
    command: RTK_HOOK_CLAUDE_COMMAND,
    render: buildClaudeSettingsJson,
  },
  {
    templateId: 'rtk.gemini-settings',
    diskPath: '.gemini/settings.json',
    eventKey: 'BeforeTool',
    command: RTK_HOOK_GEMINI_COMMAND,
    render: buildGeminiSettingsJson,
  },
] as const;

export type RtkSettingsFile = (typeof RTK_SETTINGS_FILES)[number];

/** A settings file without the hook its RTK template wrote: every hook item whose command is exactly
 *  RTK's, and each entry, event list and `hooks` object that leaves empty, written back with the
 *  file's own indent, line endings and final newline. Null when it holds no such hook, is not
 *  strict JSON, or is a file that parsing and writing back would change anywhere else. */
export function withoutRtkHookEntry(templateId: string, text: string): string | null {
  const hook = RTK_SETTINGS_FILES.find((f) => f.templateId === templateId);
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
