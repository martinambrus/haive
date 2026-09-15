import { describe, expect, it } from 'vitest';
import { toolUsageFromStreamLog } from '../src/queues/cli-exec/tool-usage-backfill.js';
import { formatCliHeader } from '../src/queues/cli-exec/exec-core.js';
import { formatSteerLine } from '../src/queues/cli-exec/steer-echo.js';
import { createStreamLogBuffer } from '../src/queues/cli-exec/stream-log-buffer.js';

// A stored stream_log is the persisted replay: the ANSI command header exec-core writes, the
// CLI's own NDJSON, stderr chunks, the `[you] …` steer echoes and, past the cap, the elision
// marker. Event shapes are the ones MEASURED on stored rows (see tool-usage.test.ts).

const WORKDIR = '/haive/workdir';
const line = (event: unknown) => `${JSON.stringify(event)}\n`;

const CLAUDE_INIT = {
  type: 'system',
  subtype: 'init',
  model: 'claude-opus-5',
  tools: ['Bash', 'Read', 'mcp__haive-rag__rag_search'],
  mcp_servers: [{ name: 'haive-rag', status: 'connected' }],
  agents: ['peer-reviewer', 'claude'],
  skills: ['project-context'],
};
const toolUse = (name: string, input: Record<string, unknown>) => ({
  type: 'assistant',
  message: { model: 'claude-opus-5', content: [{ type: 'tool_use', id: 't', name, input }] },
});

function claudeTranscript(): string {
  const header = formatCliHeader(
    { command: 'claude', args: ['-p', 'do the work', '--output-format', 'stream-json'], env: {} },
    WORKDIR,
  );
  return (
    header +
    line(CLAUDE_INIT) +
    line(toolUse('Bash', { command: 'cat .claude/skills/project-context/SKILL.md' })) +
    formatSteerLine('also check the agents dir') +
    line(toolUse('Read', { file_path: '/haive/workdir/.claude/agents/peer-reviewer.md' })) +
    line(toolUse('mcp__haive-rag__rag_search', { query: 'signing' })) +
    'stderr noise that is not json\n' +
    line({ type: 'result', subtype: 'success', result: 'done' })
  );
}

describe('toolUsageFromStreamLog', () => {
  it('reads a claude transcript past its header, steer echo and stderr lines', () => {
    const usage = toolUsageFromStreamLog('claude-code', claudeTranscript(), WORKDIR);
    expect(usage.source).toBe('backfill');
    expect(usage.coverage).toBe('full');
    expect(usage.tools).toEqual({ Bash: 1, Read: 1 });
    expect(usage.mcp).toEqual([{ server: 'haive-rag', tool: 'rag_search', calls: 1 }]);
    expect(usage.skills.read).toEqual([{ id: 'project-context', reads: 1 }]);
    expect(usage.agents.read).toEqual([{ id: 'peer-reviewer', reads: 1 }]);
    expect(usage.loaded).toEqual({
      agents: ['claude', 'peer-reviewer'],
      skills: ['project-context'],
      mcpServers: ['haive-rag'],
      toolCount: 3,
    });
  });

  it('marks a head+tail-elided transcript partial, keeping the inventory from its head', () => {
    // A real marker, produced by the buffer that writes it, never a hand-typed one.
    const buffer = createStreamLogBuffer({ headChars: 400, tailChars: 200 });
    buffer.push(line(CLAUDE_INIT));
    for (let i = 0; i < 20; i++) buffer.push(line(toolUse('Bash', { command: `echo ${i}` })));
    buffer.push(line({ type: 'result', subtype: 'success', result: 'done' }));
    const stored = buffer.toString();
    expect(stored).toContain('characters elided');
    const usage = toolUsageFromStreamLog('claude-code', stored, WORKDIR);
    expect(usage.coverage).toBe('partial');
    expect(usage.loaded?.agents).toEqual(['claude', 'peer-reviewer']);
  });

  it('reads a codex exec transcript', () => {
    const stored =
      line({ type: 'thread.started', thread_id: 't1' }) +
      line({
        type: 'item.started',
        item: { id: 'i1', type: 'command_execution', command: 'cat .agents/skills/x/SKILL.md' },
      }) +
      line({
        type: 'item.completed',
        item: {
          id: 'i1',
          type: 'command_execution',
          command: 'cat .agents/skills/x/SKILL.md',
          exit_code: 0,
          status: 'completed',
        },
      }) +
      line({
        type: 'item.completed',
        item: { id: 'i2', type: 'mcp_tool_call', server: 'haive-rag', tool: 'rag_search' },
      }) +
      line({ type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: 'Done.' } }) +
      line({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } });
    const usage = toolUsageFromStreamLog('codex', stored, WORKDIR);
    expect(usage.coverage).toBe('full');
    expect(usage.tools).toEqual({ command_execution: 1 });
    expect(usage.mcp).toEqual([{ server: 'haive-rag', tool: 'rag_search', calls: 1 }]);
    expect(usage.skills.read).toEqual([{ id: 'x', reads: 1 }]);
    expect(usage.loaded).toBeNull();
  });

  it('tallies both halves of an app-server transcript followed by its exec fallback', () => {
    // exec-core stores the abandoned app-server transcript, a notice, then the exec run's.
    const stored =
      line({ id: 1, result: { userAgent: 'haive/0.154.0' } }) +
      line({
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: { id: 'e1', type: 'mcpToolCall', server: 'haive-rag', tool: 'rag_search' },
        },
      }) +
      '[haive] codex app-server unavailable at stream; re-running on codex exec\n' +
      line({
        type: 'item.completed',
        item: {
          id: 'i1',
          type: 'command_execution',
          command: 'sed -n 1,40p .codex/agents/peer-reviewer.toml',
          status: 'completed',
        },
      });
    const usage = toolUsageFromStreamLog('codex', stored, WORKDIR);
    expect(usage.coverage).toBe('full');
    expect(usage.mcp).toEqual([{ server: 'haive-rag', tool: 'rag_search', calls: 1 }]);
    expect(usage.tools).toEqual({ command_execution: 1 });
    expect(usage.agents.read).toEqual([{ id: 'peer-reviewer', reads: 1 }]);
  });

  it('records an amp transcript as not observable, keeping what its init listed', () => {
    const stored =
      line({ type: 'system', subtype: 'init', tools: ['shell_command', 'Task'], mcp_servers: [] }) +
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } }) +
      line({ type: 'result', subtype: 'success', result: 'Done.' });
    const usage = toolUsageFromStreamLog('amp', stored, WORKDIR);
    expect(usage.coverage).toBe('none');
    expect(usage.tools).toEqual({});
    expect(usage.loaded).toEqual({ agents: [], skills: [], mcpServers: [], toolCount: 2 });
  });

  it('records a gemini envelope and a missing transcript as not observable', () => {
    const gemini = `${JSON.stringify({ response: 'Done.', stats: { models: {} } })}\n`;
    expect(toolUsageFromStreamLog('gemini', gemini, WORKDIR).coverage).toBe('none');
    expect(toolUsageFromStreamLog('claude-code', null, WORKDIR)).toEqual({
      source: 'backfill',
      coverage: 'none',
      tools: {},
      mcp: [],
      subagents: [],
      skills: { invoked: [], read: [] },
      agents: { assigned: [], read: [] },
      loaded: null,
    });
  });

  it('is idempotent: the same transcript serialises to the same JSON', () => {
    const stored = claudeTranscript();
    expect(JSON.stringify(toolUsageFromStreamLog('claude-code', stored, WORKDIR))).toBe(
      JSON.stringify(toolUsageFromStreamLog('claude-code', stored, WORKDIR)),
    );
  });
});
