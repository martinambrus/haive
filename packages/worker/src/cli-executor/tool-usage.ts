import { CLI_PROVIDER_LIST, type InvocationToolUsage } from '@haive/shared';
import { WORKTREE_SUBDIR } from '../repo/worktree-paths.js';

/* ------------------------------------------------------------------ */
/* What an invocation USED                                             */
/* ------------------------------------------------------------------ */
/* Haive knows what it OFFERS a CLI: every repository agent definition, every skill, the MCP
 * servers it wires. It did not know what a run USED, so "which persona did this step follow"
 * and "which skills are dead weight in every prompt" had no answer. The evidence is already on
 * the wire — the same stream the token-usage pass parses — so nothing extra is spawned,
 * prompted or billed to collect it. This module is the pure tally; the collectors feed it one
 * event at a time and exec-core persists `finalize()` beside tokenUsage and modelIdentity.
 *
 * "Used" means three different things, each with its own evidence:
 *   assigned  Haive pasted a persona into the prompt. The CLI never reports this; it is stamped
 *             at dispatch (a follow-up behind the per-call agent isolation refactor), so
 *             `agents.assigned` is always empty here.
 *   called    the CLI invoked something natively: a tool, an MCP tool, a sub-agent, a skill.
 *   read      the agent opened a definition file itself, which only shows up as a PATH inside
 *             a shell command or a read tool's input.
 *
 * Coverage is MEASURED per output format on stored transcripts (2026-09-15), not assumed:
 *   claude-code, zai, ollama, muse, openrouter   stream-json `tool_use` blocks + `init` inventory
 *   grok                                          same blocks, lowercase names, MCP via `use_tool`
 *   codex exec / app-server                       `item.completed` / `item/completed` items
 *   amp                                           NOTHING — assistant events are text-only
 *   gemini, antigravity                           NOTHING / unmeasured
 * Re-measure against real rows before "correcting" any of this; a name here that stops
 * matching degrades to an uncounted native tool, never to a wrong count.
 *
 * LEAF MODULE: `cli-executor/` is dependency-free of `queues/` (the codex collectors live here
 * and `stream.ts` imports downward), so this file may import only `@haive/shared` and
 * `repo/worktree-paths.js`. The sandbox workdir is passed in for the same reason. */

export interface ReadTarget {
  kind: 'agent' | 'skill';
  id: string;
  /** The catalog directory the path matched, repo-relative (`.claude/agents`). */
  dir: string;
}

/** VOLATILE — CLI naming quirks, isolated here on purpose. MEASURED on the dev install's
 *  stored transcripts on 2026-09-15 unless marked otherwise. Every entry is matched exactly;
 *  a name the binary renames tomorrow falls through to a plain `tools[name]` count. */
const CLI_TOOL_NAMES = {
  /** Read-a-file tools → the input keys that carry the path. claude-family `Read`
   *  (`file_path`); grok `read_file` (`target_file`). Search tools (`Grep`, grok `grep`) are
   *  deliberately absent: a search over a directory is not opening a definition. */
  readTools: {
    Read: ['file_path'],
    read_file: ['target_file', 'path'],
  } as Record<string, readonly string[]>,
  /** Shell tools → the input key that carries the command line. */
  shellTools: {
    Bash: 'command',
    bash: 'command',
    execute_command: 'command',
    run_terminal_command: 'command',
  } as Record<string, string>,
  /** claude family: every MCP tool is exposed as `mcp__<server>__<tool>`. */
  mcpPrefix: 'mcp__',
  /** grok: MCP tools go through one wrapper whose input names `<server>__<tool>`. */
  mcpWrapperTool: 'use_tool',
  mcpWrapperNameKey: 'tool_name',
  mcpWrapperInputKey: 'tool_input',
  /** Native sub-agent tools → the input key naming the sub-agent type. `Agent` measured
   *  (`subagent_type: "general-purpose"`); `Task` is the same tool's older name (UNMEASURED);
   *  grok's `spawn_subagent` input is UNMEASURED, so its type is recorded as null. */
  subagentTools: {
    Agent: 'subagent_type',
    Task: 'subagent_type',
    spawn_subagent: null,
  } as Record<string, string | null>,
  /** The claude `Skill` tool → candidate input keys for the skill id. UNMEASURED: 0 calls in
   *  3,509 stored runs; the binary's own schema names `skill` and `args`. */
  skillTool: 'Skill',
  skillIdKeys: ['skill', 'name'],
  /** MCP read tools (the filesystem server) → the argument keys carrying a path or paths.
   *  `read_text_file{path}` measured on codex; the rest follow the server's documented schema. */
  mcpReadTools: {
    read_text_file: ['path'],
    read_file: ['path'],
    read_media_file: ['path'],
    read_multiple_files: ['paths'],
  } as Record<string, readonly string[]>,
  codex: {
    /** `item.completed` item types. Everything not listed is counted verbatim under its type. */
    command: 'command_execution',
    mcp: 'mcp_tool_call',
    collab: 'collab_tool_call',
    skipped: ['agent_message', 'reasoning', 'error'],
    /** app-server camelCase → the exec spelling, so one record shape covers both transports.
     *  `commandExecution` and `mcpToolCall` measured; the rest follow the same convention. */
    appServerSpelling: {
      commandExecution: 'command_execution',
      mcpToolCall: 'mcp_tool_call',
      fileChange: 'file_change',
      webSearch: 'web_search',
      collabToolCall: 'collab_tool_call',
    } as Record<string, string>,
    appServerSkipped: ['agentMessage', 'userMessage', 'reasoning', 'contextCompaction'],
  },
  /** Providers whose stream carries no tool events at all, so a tally over it would report
   *  "used nothing" for a run that may have used plenty. amp MEASURED across all 39 stored runs. */
  unobservableProviders: ['amp'],
};

/** Agent and skill directories every CLI reads from, derived from the catalog so a new provider
 *  joins without a change here. Pre-split into segments for the whole-segment prefix test. */
interface ToolingDir {
  kind: ReadTarget['kind'];
  dir: string;
  segments: string[];
}

function buildToolingDirs(): ToolingDir[] {
  const seen = new Set<string>();
  const out: ToolingDir[] = [];
  const add = (kind: ReadTarget['kind'], dir: string): void => {
    const key = `${kind}:${dir}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, dir, segments: dir.split('/').filter((s) => s.length > 0) });
  };
  for (const provider of CLI_PROVIDER_LIST) {
    if (provider.projectAgentsDir) add('agent', provider.projectAgentsDir);
    add('skill', provider.projectSkillsDir);
  }
  return out;
}

const TOOLING_DIRS = buildToolingDirs();
const WORKTREE_SEGMENTS = WORKTREE_SUBDIR.split('/').filter((s) => s.length > 0);
const AGENT_FILE_RE = /^(.+)\.(md|toml)$/;
/** What a persona or skill id may look like: a plain filename stem. The tokenizer hands over
 *  whatever sat in the command, so a glob or a shell variable arrives too — MEASURED on the dev
 *  install, `cat .claude/agents/*.md` and `sed -n 1,40p .claude/agents/$f.md` ranked `*` and
 *  `$f` beside real personas. Such a read names every file or none, and the tally cannot say
 *  which, so it counts as no read. Exported as a string so the data migration that resets rows
 *  written before this check can use the SAME pattern in SQL. */
export const TOOLING_ID_PATTERN = '^[A-Za-z0-9_.-]+$';
const TOOLING_ID_RE = new RegExp(TOOLING_ID_PATTERN);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
}

function stripQuotes(token: string): string {
  return token.replace(/^['"]+/, '').replace(/['"]+$/, '');
}

function startsWithSegments(segments: readonly string[], prefix: readonly string[]): boolean {
  if (segments.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (segments[i] !== prefix[i]) return false;
  }
  return true;
}

/** Split `mcp__<server>__<tool>` (claude family) or `<server>__<tool>` (grok's `use_tool`) at
 *  the FIRST `__` after the prefix. Tool names carry their own underscores
 *  (`mcp__chrome-devtools__take_snapshot`), server names do not. */
export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  const body = name.startsWith(CLI_TOOL_NAMES.mcpPrefix)
    ? name.slice(CLI_TOOL_NAMES.mcpPrefix.length)
    : name;
  const idx = body.indexOf('__');
  if (idx <= 0 || idx + 2 >= body.length) return null;
  return { server: body.slice(0, idx), tool: body.slice(idx + 2) };
}

/** Which agent definition or skill a path opens, or null. `workdir` is the sandbox MOUNT
 *  ROOT (`/haive/workdir`), never the resolved cwd: a worktree run's cwd is
 *  `<workdir>/.haive/worktrees/<name>`, and an absolute repo-root path must still classify.
 *  `null` means only relative paths classify. Matched on whole segments from the root, the
 *  way `isDeniedPath` is: `.claude/agents/x.md` counts, `docs/.claude/agents/x.md` does not. */
export function classifyReadPath(raw: string, workdir: string | null): ReadTarget | null {
  let path = stripQuotes(raw.trim());
  if (!path) return null;
  if (path.startsWith('/')) {
    if (workdir === null) return null;
    const prefix = workdir.endsWith('/') ? workdir : `${workdir}/`;
    if (!path.startsWith(prefix)) return null;
    path = path.slice(prefix.length);
  }
  while (path.startsWith('./')) path = path.slice(2);
  let segments = path.split('/').filter((s) => s.length > 0 && s !== '.');
  if (
    startsWithSegments(segments, WORKTREE_SEGMENTS) &&
    segments.length > WORKTREE_SEGMENTS.length + 1
  ) {
    segments = segments.slice(WORKTREE_SEGMENTS.length + 1);
  }
  for (const dir of TOOLING_DIRS) {
    if (!startsWithSegments(segments, dir.segments)) continue;
    const rest = segments.slice(dir.segments.length);
    if (dir.kind === 'agent') {
      if (rest.length !== 1) return null;
      const m = AGENT_FILE_RE.exec(rest[0] ?? '');
      const stem = m?.[1];
      if (!stem || stem.toLowerCase() === 'readme' || !TOOLING_ID_RE.test(stem)) return null;
      return { kind: 'agent', id: stem, dir: dir.dir };
    }
    const skillId = rest[0];
    if (!skillId || !TOOLING_ID_RE.test(skillId)) return null;
    if (rest.length === 2 && rest[1] === 'SKILL.md')
      return { kind: 'skill', id: skillId, dir: dir.dir };
    if (rest.length === 3 && rest[1] === 'sub-skills' && (rest[2] ?? '').endsWith('.md')) {
      return { kind: 'skill', id: skillId, dir: dir.dir };
    }
    return null;
  }
  return null;
}

/** The path-looking tokens of a shell command line. The command is NOT interpreted — any
 *  token that classifies counts as a read, so `cat`, `sed -n`, `head` and even `echo >` all
 *  register. Split on whitespace and the shell operators that glue commands together, so
 *  `/bin/bash -lc "sed -n '1,240p' .claude/agents/y.md; head z.md"` yields both files. */
export function commandPathTokens(command: string): string[] {
  const out: string[] = [];
  for (const raw of command.split(/[\s;|&()<>`]+/)) {
    const token = stripQuotes(raw.trim());
    if (!token) continue;
    if (token.includes('/') || token.startsWith('.')) out.push(token);
  }
  return out;
}

export interface ToolUsageTally {
  /** claude-family / grok `system`/`init` event. First one wins. */
  claudeInit(event: Record<string, unknown>): void;
  /** One `tool_use` block off an `assistant` event (claude family and grok alike). */
  claudeToolUse(name: string, input: unknown): void;
  /** One codex `item.completed` item (exec `--json`). Never feed `item.started`. */
  codexExecItem(item: Record<string, unknown>): void;
  /** One codex app-server `item/completed` item. Never feed `item/started`. */
  codexAppServerItem(item: Record<string, unknown>): void;
  /** Whether any event of a tool-bearing format was seen — the init event included, so an
   *  observable run that called nothing still reports `full` with empty counters. */
  sawObservableEvent(): boolean;
  finalize(source: InvocationToolUsage['source'], elided?: boolean): InvocationToolUsage;
}

export function createToolUsageTally(opts: { workdir: string | null }): ToolUsageTally {
  const tools = new Map<string, number>();
  const mcp = new Map<string, { server: string; tool: string; calls: number }>();
  const subagents = new Map<string | null, number>();
  const skillsInvoked = new Map<string | null, number>();
  const skillsRead = new Map<string, number>();
  const agentsRead = new Map<string, number>();
  let loaded: InvocationToolUsage['loaded'] = null;
  let observable = false;

  const bump = <K>(map: Map<K, number>, key: K): void => {
    map.set(key, (map.get(key) ?? 0) + 1);
  };
  const bumpMcp = (server: string, tool: string): void => {
    // A JSON pair, never a control-character separator: a literal NUL in the source makes
    // the file binary to grep, which then skips it without a word.
    const key = JSON.stringify([server, tool]);
    const entry = mcp.get(key);
    if (entry) entry.calls += 1;
    else mcp.set(key, { server, tool, calls: 1 });
  };
  const noteRead = (raw: unknown): void => {
    if (typeof raw !== 'string') return;
    const target = classifyReadPath(raw, opts.workdir);
    if (!target) return;
    if (target.kind === 'agent') bump(agentsRead, target.id);
    else bump(skillsRead, target.id);
  };
  const notePathsIn = (input: unknown, keys: readonly string[] | undefined): void => {
    if (!keys || !isRecord(input)) return;
    for (const key of keys) {
      const value = input[key];
      if (Array.isArray(value)) value.forEach(noteRead);
      else noteRead(value);
    }
  };
  const noteCommand = (command: unknown): void => {
    if (typeof command !== 'string') return;
    for (const token of commandPathTokens(command)) noteRead(token);
  };
  const noteMcp = (name: string, args: unknown): boolean => {
    const parsed = parseMcpToolName(name);
    if (!parsed) return false;
    bumpMcp(parsed.server, parsed.tool);
    notePathsIn(args, CLI_TOOL_NAMES.mcpReadTools[parsed.tool]);
    return true;
  };

  const codexItem = (item: Record<string, unknown>, type: string): void => {
    const names = CLI_TOOL_NAMES.codex;
    if (type === names.command) {
      bump(tools, type);
      noteCommand(item.command);
      return;
    }
    if (type === names.mcp) {
      if (typeof item.server === 'string' && typeof item.tool === 'string') {
        bumpMcp(item.server, item.tool);
        notePathsIn(item.arguments, CLI_TOOL_NAMES.mcpReadTools[item.tool]);
      } else {
        bump(tools, type);
      }
      return;
    }
    if (type === names.collab) {
      bump(tools, type);
      bump(subagents, typeof item.tool === 'string' ? item.tool : null);
      return;
    }
    bump(tools, type);
  };

  return {
    claudeInit(event) {
      observable = true;
      if (loaded !== null) return;
      const servers: string[] = [];
      if (Array.isArray(event.mcp_servers)) {
        for (const entry of event.mcp_servers) {
          if (isRecord(entry) && typeof entry.name === 'string' && entry.name.trim()) {
            servers.push(entry.name.trim());
          }
        }
      }
      // Sorted like every other array here: the CLI enumerates its inventory in directory
      // order, which is not a fact about the run, and the record promises stable JSON.
      loaded = {
        agents: stringsOf(event.agents).sort(compareStrings),
        skills: stringsOf(event.skills).sort(compareStrings),
        mcpServers: servers.sort(compareStrings),
        toolCount: Array.isArray(event.tools) ? event.tools.length : 0,
      };
    },
    claudeToolUse(name, input) {
      observable = true;
      const inp = isRecord(input) ? input : {};
      const names = CLI_TOOL_NAMES;
      if (name.startsWith(names.mcpPrefix)) {
        if (!noteMcp(name, inp)) bump(tools, name);
        return;
      }
      if (name === names.mcpWrapperTool) {
        const wrapped = inp[names.mcpWrapperNameKey];
        if (typeof wrapped !== 'string' || !noteMcp(wrapped, inp[names.mcpWrapperInputKey])) {
          bump(tools, name);
        }
        return;
      }
      if (name in names.subagentTools) {
        bump(tools, name);
        const key = names.subagentTools[name];
        const type = key !== null && key !== undefined ? inp[key] : null;
        bump(subagents, typeof type === 'string' && type.trim() ? type.trim() : null);
        return;
      }
      if (name === names.skillTool) {
        bump(tools, name);
        const id = names.skillIdKeys
          .map((k) => inp[k])
          .find((v) => typeof v === 'string' && v.trim());
        bump(skillsInvoked, typeof id === 'string' ? id.trim() : null);
        return;
      }
      const readKeys = names.readTools[name];
      if (readKeys) {
        bump(tools, name);
        notePathsIn(inp, readKeys);
        return;
      }
      const commandKey = names.shellTools[name];
      if (commandKey) {
        bump(tools, name);
        noteCommand(inp[commandKey]);
        return;
      }
      bump(tools, name);
    },
    codexExecItem(item) {
      const type = item.type;
      if (typeof type !== 'string') return;
      observable = true;
      if (CLI_TOOL_NAMES.codex.skipped.includes(type)) return;
      codexItem(item, type);
    },
    codexAppServerItem(item) {
      const type = item.type;
      if (typeof type !== 'string') return;
      observable = true;
      if (CLI_TOOL_NAMES.codex.appServerSkipped.includes(type)) return;
      codexItem(item, CLI_TOOL_NAMES.codex.appServerSpelling[type] ?? type);
    },
    sawObservableEvent() {
      return observable;
    },
    finalize(source, elided = false) {
      const coverage: InvocationToolUsage['coverage'] = !observable
        ? 'none'
        : elided
          ? 'partial'
          : 'full';
      return {
        source,
        coverage,
        tools: sortedRecord(tools),
        mcp: [...mcp.values()].sort((a, b) =>
          a.server === b.server
            ? compareStrings(a.tool, b.tool)
            : compareStrings(a.server, b.server),
        ),
        subagents: sortedNullable(subagents).map(([type, calls]) => ({ type, calls })),
        skills: {
          invoked: sortedNullable(skillsInvoked).map(([id, calls]) => ({ id, calls })),
          read: sortedEntries(skillsRead).map(([id, reads]) => ({ id, reads })),
        },
        agents: {
          assigned: [],
          read: sortedEntries(agentsRead).map(([id, reads]) => ({ id, reads })),
        },
        loaded,
      };
    },
  };
}

/** Code-unit order, never `localeCompare`: the record must serialise identically on every
 *  host, and a locale-aware collation can differ with the ICU data Node was built with. */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function sortedEntries(map: Map<string, number>): Array<[string, number]> {
  return [...map.entries()].sort(([a], [b]) => compareStrings(a, b));
}

function sortedNullable(map: Map<string | null, number>): Array<[string | null, number]> {
  return [...map.entries()].sort(([a], [b]) => {
    if (a === null) return b === null ? 0 : 1;
    if (b === null) return -1;
    return compareStrings(a, b);
  });
}

function sortedRecord(map: Map<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of sortedEntries(map)) out[key] = value;
  return out;
}

/** The record for a path that carries no tool events: every list empty, `coverage: 'none'`.
 *  `loaded` may still be known (amp's init lists its tools). */
export function unobservedToolUsage(
  source: InvocationToolUsage['source'],
  loaded: InvocationToolUsage['loaded'] = null,
): InvocationToolUsage {
  return {
    source,
    coverage: 'none',
    tools: {},
    mcp: [],
    subagents: [],
    skills: { invoked: [], read: [] },
    agents: { assigned: [], read: [] },
    loaded,
  };
}

/** A provider whose stream carries no tool events makes every counter a lie, not a zero: the
 *  tally saw its init and text events and would report `full` with nothing used. Empties the
 *  counters and marks the record `none`, keeping `loaded` and whatever was assigned. The rule
 *  lives here so the live write and the backfill cannot disagree about it. */
export function applyProviderObservability(
  usage: InvocationToolUsage | null,
  providerName: string | null,
): InvocationToolUsage | null {
  if (usage === null) return null;
  if (providerName === null || !CLI_TOOL_NAMES.unobservableProviders.includes(providerName)) {
    return usage;
  }
  return {
    ...unobservedToolUsage(usage.source, usage.loaded),
    agents: { assigned: usage.agents.assigned, read: [] },
  };
}
