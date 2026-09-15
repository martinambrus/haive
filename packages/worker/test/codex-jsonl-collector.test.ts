import { describe, expect, it } from 'vitest';
import {
  createCodexJsonlCollector,
  extractCodexJsonlOutput,
} from '../src/queues/cli-exec-queue.js';

function feed(c: ReturnType<typeof createCodexJsonlCollector>, events: unknown[]): void {
  for (const e of events) c.onChunk(JSON.stringify(e) + '\n');
}

const DOCUMENTED_RUN = [
  { type: 'thread.started', thread_id: 't1' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { type: 'reasoning', text: 'thinking…' } },
  { type: 'item.completed', item: { type: 'agent_message', text: 'First answer' } },
  {
    type: 'turn.completed',
    usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50 },
  },
];

describe('createCodexJsonlCollector', () => {
  it('extracts the agent message and turn usage from a documented run', () => {
    const c = createCodexJsonlCollector();
    feed(c, DOCUMENTED_RUN);
    expect(c.isJsonl()).toBe(true);
    expect(c.getResult()).toBe('First answer');
    expect(c.getTokenUsage()).toEqual({
      inputTokens: 1000,
      outputTokens: 50,
      totalTokens: 1050,
      cacheReadTokens: 800,
    });
    expect(c.getNoResultReason()).toBeNull();
  });

  it('sums usage across turns and keeps the LAST agent message', () => {
    const c = createCodexJsonlCollector();
    feed(c, [
      ...DOCUMENTED_RUN,
      { type: 'turn.started' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'Second answer' } },
      { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } },
    ]);
    expect(c.getResult()).toBe('Second answer');
    expect(c.getTokenUsage()).toEqual({
      inputTokens: 1010,
      outputTokens: 55,
      totalTokens: 1065,
      cacheReadTokens: 800,
    });
  });

  it('tallies what the run used from completed items only', () => {
    // Item shapes MEASURED on codex 0.154.0 exec --json rows (result/arguments trimmed). Every
    // item also arrives as `item.started` first, which must not count.
    const c = createCodexJsonlCollector();
    feed(c, [
      { type: 'thread.started', thread_id: 't1' },
      { type: 'turn.started' },
      {
        type: 'item.started',
        item: { id: 'item_2', type: 'command_execution', command: 'cat .agents/skills/x/SKILL.md' },
      },
      {
        type: 'item.completed',
        item: {
          id: 'item_2',
          type: 'command_execution',
          command: 'cat .agents/skills/x/SKILL.md',
          aggregated_output: '# x',
          exit_code: 0,
          status: 'completed',
        },
      },
      {
        type: 'item.started',
        item: { id: 'item_3', type: 'mcp_tool_call', server: 'haive-rag', tool: 'rag_search' },
      },
      {
        type: 'item.completed',
        item: {
          id: 'item_3',
          type: 'mcp_tool_call',
          server: 'haive-rag',
          tool: 'rag_search',
          arguments: { query: 'signing' },
          result: {},
          error: null,
          status: 'completed',
        },
      },
      {
        type: 'item.completed',
        item: { id: 'item_4', type: 'collab_tool_call', tool: 'wait', status: 'completed' },
      },
      { type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } },
      { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } },
    ]);
    expect(c.getResult()).toBe('Done.');
    const usage = c.getToolUsage();
    expect(usage.coverage).toBe('full');
    expect(usage.tools).toEqual({ collab_tool_call: 1, command_execution: 1 });
    expect(usage.mcp).toEqual([{ server: 'haive-rag', tool: 'rag_search', calls: 1 }]);
    expect(usage.subagents).toEqual([{ type: 'wait', calls: 1 }]);
    expect(usage.skills.read).toEqual([{ id: 'x', reads: 1 }]);
    expect(usage.loaded).toBeNull();
  });

  it('reports a stream with no codex event as not observable', () => {
    const c = createCodexJsonlCollector();
    c.onChunk('plain text from an older binary that ignored --json\n');
    expect(c.getToolUsage().coverage).toBe('none');
  });

  it('surfaces turn.failed as the no-result reason', () => {
    const c = createCodexJsonlCollector();
    feed(c, [{ type: 'thread.started' }, { type: 'turn.failed', error: { message: 'boom' } }]);
    expect(c.getResult()).toBeNull();
    expect(c.getNoResultReason()).toMatch(/boom/);
  });

  it('treats plain text output as not-JSONL', () => {
    const c = createCodexJsonlCollector();
    c.onChunk('Plain answer with no events\n');
    expect(c.isJsonl()).toBe(false);
    expect(c.getResult()).toBeNull();
    expect(c.getTokenUsage()).toBeNull();
    expect(c.getNoResultReason()).toBeNull();
  });

  it('handles chunks split mid-line', () => {
    const c = createCodexJsonlCollector();
    const line = JSON.stringify(DOCUMENTED_RUN[3]) + '\n';
    c.onChunk(line.slice(0, 20));
    c.onChunk(line.slice(20));
    expect(c.getResult()).toBe('First answer');
  });
});

describe('extractCodexJsonlOutput', () => {
  it('extracts text and usage from a full buffer', () => {
    const stdout = DOCUMENTED_RUN.map((e) => JSON.stringify(e)).join('\n') + '\n';
    const out = extractCodexJsonlOutput(stdout);
    expect(out.text).toBe('First answer');
    expect(out.tokenUsage?.totalTokens).toBe(1050);
    expect(out.eventCount).toBeGreaterThan(0);
  });

  it('flags non-JSONL stdout for raw fallback', () => {
    const out = extractCodexJsonlOutput('Plain answer');
    expect(out.eventCount).toBe(0);
    expect(out.text).toBeNull();
    expect(out.tokenUsage).toBeNull();
  });
});

describe('createCodexJsonlCollector onText (Clean-tab prose stream)', () => {
  it('fires onText for each agent_message, excluding reasoning', () => {
    const prose: string[] = [];
    const c = createCodexJsonlCollector((t) => prose.push(t));
    feed(c, [
      ...DOCUMENTED_RUN,
      { type: 'turn.started' },
      { type: 'item.completed', item: { type: 'agent_message', text: 'Second answer' } },
      { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } },
    ]);
    // DOCUMENTED_RUN carries a 'reasoning' item that must NOT be emitted as prose.
    expect(prose).toEqual(['First answer', 'Second answer']);
  });
});
