import { describe, expect, it } from 'vitest';
import {
  emptyToolUsageStepRow,
  HAIVE_MCP_SERVER_NAMES,
  isHaiveMcpServer,
  sumToolUsageSteps,
  type ToolUsageStepRow,
} from './tool-usage.js';

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
