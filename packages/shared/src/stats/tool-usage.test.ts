import { describe, expect, it } from 'vitest';
import {
  buildUnusedReport,
  classifyInstalledItem,
  emptyToolUsageStepRow,
  HAIVE_MCP_SERVER_NAMES,
  isHaiveMcpServer,
  sumToolUsageSteps,
  type ToolUsageStepRow,
  type UnusedReportInput,
} from './tool-usage.js';

describe('classifyInstalledItem', () => {
  const facts = (onDisk: boolean, liveArtifact: boolean, knownTemplate: boolean, loaded: boolean) =>
    classifyInstalledItem({ onDisk, liveArtifact, knownTemplate, loadedByCli: loaded });

  it('is the full table', () => {
    // On disk: Haive's when an artifact row or a template vouches for it, whatever the CLI says.
    expect(facts(true, true, true, true)).toBe('haive');
    expect(facts(true, true, false, false)).toBe('haive');
    expect(facts(true, false, true, false)).toBe('haive');
    expect(facts(true, false, false, true)).toBe('unmanaged');
    expect(facts(true, false, false, false)).toBe('unmanaged');
    // Not on disk: loaded and not a template is a CLI built-in (or a file removed since).
    expect(facts(false, false, false, true)).toBe('cli-builtin');
    // A template that is not on disk was removed; nothing to report.
    expect(facts(false, false, true, true)).toBeNull();
    expect(facts(false, false, true, false)).toBeNull();
    expect(facts(false, false, false, false)).toBeNull();
    // A live artifact row with no file behind it is the upgrade path's business, not ours.
    expect(facts(false, true, false, false)).toBeNull();
  });
});

describe('buildUnusedReport', () => {
  const base: UnusedReportInput = {
    installed: [
      {
        kind: 'agent',
        id: 'code-reviewer',
        paths: ['.codex/agents/code-reviewer.toml', '.claude/agents/code-reviewer.md'],
        liveArtifact: true,
        knownTemplate: true,
      },
      {
        kind: 'agent',
        id: 'pdf-specialist',
        paths: ['.claude/agents/pdf-specialist.md'],
        liveArtifact: false,
        knownTemplate: false,
      },
      {
        kind: 'agent',
        id: 'test-writer',
        paths: ['.claude/agents/test-writer.md'],
        liveArtifact: true,
        knownTemplate: true,
      },
      {
        kind: 'skill',
        id: 'dataviz',
        paths: ['.claude/skills/dataviz/SKILL.md'],
        liveArtifact: false,
        knownTemplate: false,
      },
      {
        kind: 'skill',
        id: 'project-context',
        paths: ['.claude/skills/project-context/SKILL.md'],
        liveArtifact: false,
        knownTemplate: false,
      },
    ],
    loaded: {
      agents: ['code-reviewer', 'pdf-specialist', 'test-writer', 'Explore', 'spec-writer'],
      skills: ['dataviz', 'project-context', 'loop'],
      mcpServers: ['haive-rag', 'filesystem', 'context7'],
    },
    seen: {
      // code-reviewer only ASSIGNED, test-writer only OPENED: both count as used.
      agents: ['code-reviewer', 'test-writer'],
      skills: ['project-context'],
      mcpServers: ['haive-rag'],
    },
    // spec-writer is a template that is not on disk: removed, so not a built-in.
    knownTemplateAgents: ['code-reviewer', 'test-writer', 'spec-writer'],
    lastSeenAt: new Map([
      ['agent:pdf-specialist', '2026-08-01T10:00:00.000Z'],
      ['mcp:filesystem', '2026-07-15T09:00:00.000Z'],
    ]),
    observableRuns: 12,
  };

  it('lists what was installed or offered and not used, by kind then id, with history', () => {
    expect(buildUnusedReport(base)).toEqual([
      {
        kind: 'agent',
        id: 'Explore',
        class: 'cli-builtin',
        paths: [],
        lastSeenAt: null,
      },
      {
        kind: 'agent',
        id: 'pdf-specialist',
        class: 'unmanaged',
        paths: ['.claude/agents/pdf-specialist.md'],
        lastSeenAt: '2026-08-01T10:00:00.000Z',
      },
      {
        kind: 'skill',
        id: 'dataviz',
        class: 'unmanaged',
        paths: ['.claude/skills/dataviz/SKILL.md'],
        lastSeenAt: null,
      },
      { kind: 'skill', id: 'loop', class: 'cli-builtin', paths: [], lastSeenAt: null },
      { kind: 'mcp', id: 'context7', class: 'unmanaged', paths: [], lastSeenAt: null },
      {
        kind: 'mcp',
        id: 'filesystem',
        class: 'haive',
        paths: [],
        lastSeenAt: '2026-07-15T09:00:00.000Z',
      },
    ]);
  });

  it('keeps a Haive-managed item in the list, labelled, when nothing used it', () => {
    const rows = buildUnusedReport({ ...base, seen: { agents: [], skills: [], mcpServers: [] } });
    const codeReviewer = rows.find((r) => r.kind === 'agent' && r.id === 'code-reviewer');
    expect(codeReviewer).toMatchObject({
      class: 'haive',
      paths: ['.claude/agents/code-reviewer.md', '.codex/agents/code-reviewer.toml'],
    });
  });

  it('is empty when the window has no observable run', () => {
    expect(buildUnusedReport({ ...base, observableRuns: 0 })).toEqual([]);
  });

  it('does not mutate its inputs', () => {
    const item = base.installed[0]!;
    const before = [...item.paths];
    buildUnusedReport({ ...base, seen: { agents: [], skills: [], mcpServers: [] } });
    expect(item.paths).toEqual(before);
  });
});

describe('isHaiveMcpServer', () => {
  it('knows the servers Haive wires and nothing else', () => {
    for (const name of HAIVE_MCP_SERVER_NAMES) expect(isHaiveMcpServer(name)).toBe(true);
    // A server from the repository's own .claude/mcp_settings.json.
    expect(isHaiveMcpServer('context7')).toBe(false);
    expect(isHaiveMcpServer('')).toBe(false);
  });
});

describe('sumToolUsageSteps', () => {
  const step = (overrides: Partial<ToolUsageStepRow>): ToolUsageStepRow => ({
    ...emptyToolUsageStepRow(),
    ...overrides,
  });

  it('is the empty row for no steps', () => {
    expect(sumToolUsageSteps([])).toEqual(emptyToolUsageStepRow());
  });

  it('sums the counters and merges every list by id, ordered by count then id', () => {
    const total = sumToolUsageSteps([
      step({
        runs: 3,
        observable: 2,
        unobservable: 1,
        toolCalls: 10,
        personasAssigned: [{ id: 'peer-reviewer', n: 2 }],
        personasRead: [{ id: 'test-writer', n: 1 }],
        skillsInvoked: [{ id: '(unnamed)', n: 1 }],
        skillsRead: [
          { id: 'project-context', n: 2 },
          { id: 'dataviz', n: 1 },
        ],
        mcp: [
          { server: 'haive-rag', tool: 'rag_search', calls: 3 },
          { server: 'chrome-devtools', tool: 'take_snapshot', calls: 1 },
        ],
        subagents: [{ id: 'general-purpose', n: 1 }],
      }),
      step({
        runs: 2,
        observable: 1,
        partial: 1,
        unrecorded: 1,
        toolCalls: 4,
        personasAssigned: [
          { id: 'peer-reviewer', n: 1 },
          { id: 'security-code-reviewer', n: 1 },
        ],
        skillsRead: [{ id: 'dataviz', n: 5 }],
        mcp: [{ server: 'haive-rag', tool: 'rag_search', calls: 2 }],
        subagents: [{ id: 'wait', n: 4 }],
      }),
    ]);
    expect(total).toEqual({
      runs: 5,
      observable: 3,
      partial: 1,
      unobservable: 1,
      unrecorded: 1,
      toolCalls: 14,
      personasAssigned: [
        { id: 'peer-reviewer', n: 3 },
        { id: 'security-code-reviewer', n: 1 },
      ],
      personasRead: [{ id: 'test-writer', n: 1 }],
      skillsInvoked: [{ id: '(unnamed)', n: 1 }],
      skillsRead: [
        { id: 'dataviz', n: 6 },
        { id: 'project-context', n: 2 },
      ],
      mcp: [
        { server: 'haive-rag', tool: 'rag_search', calls: 5 },
        { server: 'chrome-devtools', tool: 'take_snapshot', calls: 1 },
      ],
      subagents: [
        { id: 'wait', n: 4 },
        { id: 'general-purpose', n: 1 },
      ],
    });
  });

  it('does not mutate its inputs', () => {
    const row = step({ mcp: [{ server: 'haive-rag', tool: 'rag_search', calls: 1 }] });
    sumToolUsageSteps([row, row]);
    expect(row.mcp[0]?.calls).toBe(1);
  });
});
