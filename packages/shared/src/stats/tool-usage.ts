/**
 * Agent, skill and MCP usage — the pure half of the statistics built on
 * `cli_invocations.tool_usage`.
 *
 * The api does the fetching and scoping (`lib/tool-usage-rollup.ts`); this file holds the
 * maths that needs no database: merging per-step rows into a task total, and the one list of
 * MCP servers Haive wires itself, so a server in a run's inventory can be told from one the
 * repository's own `.claude/mcp_settings.json` added.
 */

/** The MCP servers Haive configures for a run itself (`sandbox/mcp-config.ts` builds them by
 *  these names). Anything else in a run's `loaded.mcpServers` came from the repository's own
 *  settings. The worker keeps its literals; a worker test pins the two lists to each other. */
export const HAIVE_MCP_SERVER_NAMES = [
  'filesystem',
  'git',
  'postgres',
  'chrome-devtools',
  'haive-rag',
  'ddev-control',
] as const;

export function isHaiveMcpServer(name: string): boolean {
  return (HAIVE_MCP_SERVER_NAMES as readonly string[]).includes(name);
}

/** One id with a count. What `n` counts is the field's business — runs a persona was assigned
 *  in, reads of a definition file, calls of a skill or a sub-agent type. */
export interface ToolUsageCounted {
  id: string;
  n: number;
}

export interface ToolUsageMcpCounted {
  server: string;
  tool: string;
  calls: number;
}

/** What one step (or one task, once merged) used, with the coverage counters a reader needs to
 *  judge the lists by: a step whose runs are all `unobservable` has empty lists that mean
 *  nothing, not a step that used nothing. */
export interface ToolUsageStepRow {
  runs: number;
  observable: number;
  partial: number;
  unobservable: number;
  unrecorded: number;
  personasAssigned: ToolUsageCounted[];
  personasRead: ToolUsageCounted[];
  skillsInvoked: ToolUsageCounted[];
  skillsRead: ToolUsageCounted[];
  mcp: ToolUsageMcpCounted[];
  subagents: ToolUsageCounted[];
  /** Native tool calls, MCP calls excluded — `tools` never carries an `mcp__*` key. */
  toolCalls: number;
}

export function emptyToolUsageStepRow(): ToolUsageStepRow {
  return {
    runs: 0,
    observable: 0,
    partial: 0,
    unobservable: 0,
    unrecorded: 0,
    personasAssigned: [],
    personasRead: [],
    skillsInvoked: [],
    skillsRead: [],
    mcp: [],
    subagents: [],
    toolCalls: 0,
  };
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function mergeCounted(lists: ToolUsageCounted[][]): ToolUsageCounted[] {
  const byId = new Map<string, number>();
  for (const list of lists) {
    for (const entry of list) byId.set(entry.id, (byId.get(entry.id) ?? 0) + entry.n);
  }
  return [...byId.entries()]
    .map(([id, n]) => ({ id, n }))
    .sort((a, b) => b.n - a.n || compareStrings(a.id, b.id));
}

function mergeMcp(lists: ToolUsageMcpCounted[][]): ToolUsageMcpCounted[] {
  const byKey = new Map<string, ToolUsageMcpCounted>();
  for (const list of lists) {
    for (const entry of list) {
      // A JSON pair, never a control-character separator: a literal NUL in the source makes
      // the file binary to grep, which then skips it without a word.
      const key = JSON.stringify([entry.server, entry.tool]);
      const known = byKey.get(key);
      if (known) known.calls += entry.calls;
      else byKey.set(key, { ...entry });
    }
  }
  return [...byKey.values()].sort(
    (a, b) =>
      b.calls - a.calls || compareStrings(a.server, b.server) || compareStrings(a.tool, b.tool),
  );
}

/** A task's total from its per-step rows: counters summed, every list merged by id with its
 *  counts added. Done here so the browser never does arithmetic the api could get wrong
 *  differently. Ordered by count, then id, so the same rows always merge to the same list. */
export function sumToolUsageSteps(rows: ToolUsageStepRow[]): ToolUsageStepRow {
  const total = emptyToolUsageStepRow();
  for (const row of rows) {
    total.runs += row.runs;
    total.observable += row.observable;
    total.partial += row.partial;
    total.unobservable += row.unobservable;
    total.unrecorded += row.unrecorded;
    total.toolCalls += row.toolCalls;
  }
  total.personasAssigned = mergeCounted(rows.map((r) => r.personasAssigned));
  total.personasRead = mergeCounted(rows.map((r) => r.personasRead));
  total.skillsInvoked = mergeCounted(rows.map((r) => r.skillsInvoked));
  total.skillsRead = mergeCounted(rows.map((r) => r.skillsRead));
  total.mcp = mergeMcp(rows.map((r) => r.mcp));
  total.subagents = mergeCounted(rows.map((r) => r.subagents));
  return total;
}
