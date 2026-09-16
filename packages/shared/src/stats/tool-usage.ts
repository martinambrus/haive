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

/* ------------------------------------------------------------------ */
/* Installed against used: the unused report                            */
/* ------------------------------------------------------------------ */

/** How an installed persona or skill relates to Haive. `haive`: on disk and Haive's — a live
 *  artifact row or a known template — so never a purge candidate, an onboarding upgrade would
 *  write it back. `unmanaged`: on disk and nobody's, the real candidates. `cli-builtin`: not on
 *  disk yet listed in a run's `loaded` inventory and not a template — a CLI built-in (claude's
 *  `Explore`, `general-purpose`, …) or a file removed since the run; the lever is a flag, not a
 *  deletion. */
export type InstalledToolingClass = 'haive' | 'unmanaged' | 'cli-builtin';

export interface InstalledToolingFacts {
  /** A definition file for the id exists under the repository. */
  onDisk: boolean;
  /** A live `onboarding_artifacts` row names one of its paths. */
  liveArtifact: boolean;
  /** Haive's template manifest knows the id, so an upgrade would write it back. */
  knownTemplate: boolean;
  /** A CLI listed the id in a run's `loaded` inventory within the window. */
  loadedByCli: boolean;
}

/** Decided from the four facts and nothing else. A known template that is not on disk is a
 *  removed one, which is `null`: neither installed nor built in. */
export function classifyInstalledItem(facts: InstalledToolingFacts): InstalledToolingClass | null {
  if (facts.onDisk) return facts.liveArtifact || facts.knownTemplate ? 'haive' : 'unmanaged';
  if (facts.loadedByCli && !facts.knownTemplate) return 'cli-builtin';
  return null;
}

export type UnusedToolingKind = 'agent' | 'skill' | 'mcp';

/** One persona or skill the on-disk scan found, with the two facts the database adds. */
export interface InstalledToolingItem {
  kind: 'agent' | 'skill';
  id: string;
  /** Repository-relative definition paths, one per CLI directory it is installed in. */
  paths: string[];
  liveArtifact: boolean;
  knownTemplate: boolean;
}

export interface UnusedToolingRow {
  kind: UnusedToolingKind;
  id: string;
  class: InstalledToolingClass;
  paths: string[];
  /** ISO time a run in the caller's WHOLE history last used it; null = never since install. */
  lastSeenAt: string | null;
}

export interface UnusedReportInput {
  installed: InstalledToolingItem[];
  /** Ids the CLIs listed as loaded in the window's runs (`loaded.agents`, `loaded.skills`,
   *  `loaded.mcpServers`). */
  loaded: { agents: Iterable<string>; skills: Iterable<string>; mcpServers: Iterable<string> };
  /** Ids the window's runs USED: assigned ∪ opened personas, invoked ∪ opened skills, called
   *  servers. */
  seen: { agents: Iterable<string>; skills: Iterable<string>; mcpServers: Iterable<string> };
  /** Agent ids Haive's template manifest knows, for the verdict on ids that are not on disk. */
  knownTemplateAgents: Iterable<string>;
  /** `${kind}:${id}` → ISO time of the last use in the caller's whole history. */
  lastSeenAt: ReadonlyMap<string, string>;
  /** Observable runs in the window. */
  observableRuns: number;
}

const UNUSED_KIND_ORDER: Record<UnusedToolingKind, number> = { agent: 0, skill: 1, mcp: 2 };

/**
 * What is installed or offered and was not used in the window. EMPTY when the window has no
 * observable run: with nothing observed, nothing can be called unused. "Not seen in this
 * window" and "never seen since install" are different claims, which is why every row carries
 * `lastSeenAt` from the whole history — only the second supports deleting a file. MCP rows are
 * offered-minus-called from the runs' own inventories, never from a settings file. Ordered by
 * kind, then id, so the same facts always render the same table.
 */
export function buildUnusedReport(input: UnusedReportInput): UnusedToolingRow[] {
  if (input.observableRuns <= 0) return [];
  const loaded = {
    agents: new Set(input.loaded.agents),
    skills: new Set(input.loaded.skills),
    mcpServers: new Set(input.loaded.mcpServers),
  };
  const seen = {
    agents: new Set(input.seen.agents),
    skills: new Set(input.seen.skills),
    mcpServers: new Set(input.seen.mcpServers),
  };
  const templates = new Set(input.knownTemplateAgents);
  const lastSeen = (kind: UnusedToolingKind, id: string): string | null =>
    input.lastSeenAt.get(`${kind}:${id}`) ?? null;
  const onDisk = { agent: new Set<string>(), skill: new Set<string>() };
  const rows: UnusedToolingRow[] = [];

  for (const item of input.installed) {
    onDisk[item.kind].add(item.id);
    const seenIds = item.kind === 'agent' ? seen.agents : seen.skills;
    if (seenIds.has(item.id)) continue;
    const loadedIds = item.kind === 'agent' ? loaded.agents : loaded.skills;
    const cls = classifyInstalledItem({
      onDisk: true,
      liveArtifact: item.liveArtifact,
      knownTemplate: item.knownTemplate,
      loadedByCli: loadedIds.has(item.id),
    });
    if (cls === null) continue;
    rows.push({
      kind: item.kind,
      id: item.id,
      class: cls,
      paths: [...item.paths].sort(compareStrings),
      lastSeenAt: lastSeen(item.kind, item.id),
    });
  }
  for (const id of loaded.agents) {
    if (onDisk.agent.has(id) || seen.agents.has(id)) continue;
    const cls = classifyInstalledItem({
      onDisk: false,
      liveArtifact: false,
      knownTemplate: templates.has(id),
      loadedByCli: true,
    });
    if (cls !== null) {
      rows.push({ kind: 'agent', id, class: cls, paths: [], lastSeenAt: lastSeen('agent', id) });
    }
  }
  for (const id of loaded.skills) {
    if (onDisk.skill.has(id) || seen.skills.has(id)) continue;
    const cls = classifyInstalledItem({
      onDisk: false,
      liveArtifact: false,
      knownTemplate: false,
      loadedByCli: true,
    });
    if (cls !== null) {
      rows.push({ kind: 'skill', id, class: cls, paths: [], lastSeenAt: lastSeen('skill', id) });
    }
  }
  for (const server of loaded.mcpServers) {
    if (seen.mcpServers.has(server)) continue;
    rows.push({
      kind: 'mcp',
      id: server,
      class: isHaiveMcpServer(server) ? 'haive' : 'unmanaged',
      paths: [],
      lastSeenAt: lastSeen('mcp', server),
    });
  }
  return rows.sort(
    (a, b) => UNUSED_KIND_ORDER[a.kind] - UNUSED_KIND_ORDER[b.kind] || compareStrings(a.id, b.id),
  );
}
