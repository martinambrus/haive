import { describe, expect, it } from 'vitest';
import { CLI_PROVIDER_LIST } from '@haive/shared';
import {
  applyProviderObservability,
  classifyReadPath,
  commandPathTokens,
  createToolUsageTally,
  parseMcpToolName,
  unobservedToolUsage,
} from '../src/cli-executor/tool-usage.js';

// Every event below is a real shape MEASURED on the dev install's stored
// cli_invocations.stream_log rows on 2026-09-15 (claude-code 2.1.270, grok 1.0.31, codex
// 0.154.0 exec --json and app-server) — trimmed, never invented. The whole feature exists
// because what these CLIs emit differs from what their docs imply.

const WORKDIR = '/haive/workdir';

// The measured claude-family init event, agents/skills/tools trimmed to a handful of names.
const CLAUDE_INIT = {
  type: 'system',
  subtype: 'init',
  cwd: '/haive/workdir',
  session_id: '5d0f0d5a-0000-4000-8000-000000000000',
  tools: [
    'Task',
    'Bash',
    'Glob',
    'Grep',
    'Read',
    'Edit',
    'Write',
    'Skill',
    'mcp__haive-rag__rag_search',
  ],
  mcp_servers: [
    { name: 'haive-rag', status: 'connected' },
    { name: 'filesystem', status: 'connected' },
  ],
  model: 'claude-opus-5',
  permissionMode: 'bypassPermissions',
  slash_commands: ['compact', 'context'],
  agents: ['peer-reviewer', 'security-code-reviewer', 'claude', 'Explore'],
  skills: ['project-context', 'loop', 'code-review'],
  claude_code_version: '2.1.270',
};

// The measured grok init event: `skills`, `tools` and `mcp_servers`, no `agents` key.
const GROK_INIT = {
  type: 'system',
  subtype: 'init',
  session_id: '01a09bc3-04a9-7243-b0e5-b20278f56af1',
  apiKeySource: 'oauth',
  model: 'grok-4.6',
  cwd: '/haive/workdir',
  permissionMode: 'bypassPermissions',
  tools: ['run_terminal_command', 'read_file', 'grep', 'spawn_subagent', 'use_tool', 'write'],
  mcp_servers: [
    { name: 'filesystem', status: 'connected' },
    { name: 'git', status: 'connected' },
  ],
  skills: ['build-with-ai', 'code-review', 'create-skill'],
};

describe('classifyReadPath', () => {
  const agentDirs = CLI_PROVIDER_LIST.filter((p) => p.projectAgentsDir !== null).map((p) => ({
    dir: p.projectAgentsDir as string,
    ext: p.agentFileFormat === 'toml' ? 'toml' : 'md',
  }));
  const skillDirs = [...new Set(CLI_PROVIDER_LIST.map((p) => p.projectSkillsDir))];

  it('recognises an agent definition under every catalog directory, in every path form', () => {
    expect(agentDirs.length).toBeGreaterThan(0);
    for (const { dir, ext } of agentDirs) {
      const expected = { kind: 'agent', id: 'peer-reviewer', dir };
      expect(classifyReadPath(`${dir}/peer-reviewer.${ext}`, WORKDIR)).toEqual(expected);
      expect(classifyReadPath(`./${dir}/peer-reviewer.${ext}`, WORKDIR)).toEqual(expected);
      expect(classifyReadPath(`${WORKDIR}/${dir}/peer-reviewer.${ext}`, WORKDIR)).toEqual(expected);
      // A worktree run: the repo root stays mounted at the workdir and the tree lives under
      // .haive/worktrees/<name>, DAG issue worktrees under <name>--<issue>.
      expect(
        classifyReadPath(`${WORKDIR}/.haive/worktrees/feat-x/${dir}/peer-reviewer.${ext}`, WORKDIR),
      ).toEqual(expected);
      expect(
        classifyReadPath(`.haive/worktrees/feat-x--ISSUE-001/${dir}/peer-reviewer.${ext}`, WORKDIR),
      ).toEqual(expected);
      expect(classifyReadPath(`"${dir}/peer-reviewer.${ext}"`, WORKDIR)).toEqual(expected);
    }
  });

  it('recognises a skill and its sub-skills under every catalog skills directory', () => {
    expect(skillDirs.length).toBeGreaterThan(0);
    for (const dir of skillDirs) {
      const expected = { kind: 'skill', id: 'project-context', dir };
      expect(classifyReadPath(`${dir}/project-context/SKILL.md`, WORKDIR)).toEqual(expected);
      expect(classifyReadPath(`${WORKDIR}/${dir}/project-context/SKILL.md`, WORKDIR)).toEqual(
        expected,
      );
      expect(classifyReadPath(`${dir}/project-context/sub-skills/charts.md`, WORKDIR)).toEqual(
        expected,
      );
      // Support files under a skill are not the skill being read.
      expect(classifyReadPath(`${dir}/project-context/scripts/run.sh`, WORKDIR)).toBeNull();
      expect(classifyReadPath(`${dir}/project-context`, WORKDIR)).toBeNull();
    }
  });

  it('ignores the README index, directories, other extensions and the -legacy quarantine', () => {
    expect(classifyReadPath('.claude/agents/README.md', WORKDIR)).toBeNull();
    expect(classifyReadPath('.claude/agents', WORKDIR)).toBeNull();
    expect(classifyReadPath('.claude/agents/', WORKDIR)).toBeNull();
    expect(classifyReadPath('.claude/agents/peer-reviewer.txt', WORKDIR)).toBeNull();
    expect(classifyReadPath('.claude/agents/nested/peer-reviewer.md', WORKDIR)).toBeNull();
    expect(classifyReadPath('.claude/agents-legacy/peer-reviewer.md', WORKDIR)).toBeNull();
  });

  it('anchors on whole segments from the root, never on a substring', () => {
    expect(classifyReadPath('docs/.claude/agents/peer-reviewer.md', WORKDIR)).toBeNull();
    expect(classifyReadPath('.claude/agentsx/peer-reviewer.md', WORKDIR)).toBeNull();
    expect(classifyReadPath('../.claude/agents/peer-reviewer.md', WORKDIR)).toBeNull();
  });

  it('never classifies a CLI built-in skill outside the sandbox tree', () => {
    // codex reads its own skills from HOME; grok ships `bundled/skills`. Neither is a
    // repository file, so neither is a purge candidate.
    expect(classifyReadPath('/home/node/.codex/skills/.system/SKILL.md', WORKDIR)).toBeNull();
    expect(classifyReadPath('/root/.claude/skills/loop/SKILL.md', WORKDIR)).toBeNull();
    expect(classifyReadPath('bundled/skills/code-review/SKILL.md', WORKDIR)).toBeNull();
  });

  it('with no workdir, an absolute path never classifies', () => {
    expect(classifyReadPath('/haive/workdir/.claude/agents/peer-reviewer.md', null)).toBeNull();
    expect(classifyReadPath('.claude/agents/peer-reviewer.md', null)).toEqual({
      kind: 'agent',
      id: 'peer-reviewer',
      dir: '.claude/agents',
    });
  });
});

describe('parseMcpToolName', () => {
  it('splits the claude-family form at the first double underscore after the prefix', () => {
    expect(parseMcpToolName('mcp__chrome-devtools__take_snapshot')).toEqual({
      server: 'chrome-devtools',
      tool: 'take_snapshot',
    });
    expect(parseMcpToolName('mcp__haive-rag__rag_search')).toEqual({
      server: 'haive-rag',
      tool: 'rag_search',
    });
    expect(parseMcpToolName('mcp__filesystem__read_text_file')).toEqual({
      server: 'filesystem',
      tool: 'read_text_file',
    });
  });

  it("accepts grok's unprefixed use_tool form", () => {
    expect(parseMcpToolName('haive-rag__rag_search')).toEqual({
      server: 'haive-rag',
      tool: 'rag_search',
    });
  });

  it('returns null for a name that is not server__tool', () => {
    expect(parseMcpToolName('mcp__')).toBeNull();
    expect(parseMcpToolName('mcp__haive-rag__')).toBeNull();
    expect(parseMcpToolName('rag_search')).toBeNull();
  });
});

describe('commandPathTokens', () => {
  it('keeps the path-looking tokens of a plain command', () => {
    expect(commandPathTokens('cat .claude/skills/project-context/SKILL.md')).toEqual([
      '.claude/skills/project-context/SKILL.md',
    ]);
  });

  it('splits on shell operators and strips quotes', () => {
    const tokens = commandPathTokens(
      `sed -n '1,240p' .claude/agents/peer-reviewer.md && head "/haive/workdir/.claude/agents/test-writer.md" 2>/dev/null`,
    );
    expect(tokens).toEqual([
      '.claude/agents/peer-reviewer.md',
      '/haive/workdir/.claude/agents/test-writer.md',
      '/dev/null',
    ]);
  });

  it("sees through codex's /bin/bash -lc wrapper", () => {
    // Measured app-server commandExecution.command shape.
    const tokens = commandPathTokens(
      `/bin/bash -lc "sed -n '1,240p' .claude/knowledge_base/INDEX.md; cat .claude/agents/pdf-specialist.md"`,
    );
    expect(tokens).toContain('.claude/knowledge_base/INDEX.md');
    expect(tokens).toContain('.claude/agents/pdf-specialist.md');
  });
});

describe('createToolUsageTally — claude family', () => {
  it('records the init inventory, counting tools rather than naming them', () => {
    const tally = createToolUsageTally({ workdir: WORKDIR });
    tally.claudeInit(CLAUDE_INIT);
    const usage = tally.finalize('stream');
    expect(usage.loaded).toEqual({
      agents: ['peer-reviewer', 'security-code-reviewer', 'claude', 'Explore'],
      skills: ['project-context', 'loop', 'code-review'],
      mcpServers: ['haive-rag', 'filesystem'],
      toolCount: 9,
    });
    // An observable stream that called nothing is `full` with empty counters, not `none`.
    expect(usage.coverage).toBe('full');
    expect(usage.tools).toEqual({});
  });

  it('keeps the first init event', () => {
    const tally = createToolUsageTally({ workdir: WORKDIR });
    tally.claudeInit(CLAUDE_INIT);
    tally.claudeInit({ ...CLAUDE_INIT, agents: ['other'] });
    expect(tally.finalize('stream').loaded?.agents).toEqual(CLAUDE_INIT.agents);
  });

  it('tallies native tools, file reads, MCP calls, sub-agents and skills from measured blocks', () => {
    const tally = createToolUsageTally({ workdir: WORKDIR });
    tally.claudeInit(CLAUDE_INIT);
    tally.claudeToolUse('Bash', {
      command: 'cat .claude/skills/project-context/SKILL.md',
      description: 'Read the project context skill',
    });
    tally.claudeToolUse('Bash', { command: 'ls -la', description: 'List files' });
    tally.claudeToolUse('Read', { file_path: '/haive/workdir/.claude/agents/peer-reviewer.md' });
    tally.claudeToolUse('Read', { file_path: '/haive/workdir/web/index.php', limit: 40 });
    tally.claudeToolUse('mcp__haive-rag__rag_search', { query: 'inspection signing', top_k: 8 });
    tally.claudeToolUse('mcp__haive-rag__rag_search', { query: 'pdf generation' });
    tally.claudeToolUse('mcp__chrome-devtools__take_snapshot', {});
    tally.claudeToolUse('Agent', {
      description: 'Explore the module',
      prompt: 'Find every caller of pdf_generator',
      subagent_type: 'general-purpose',
      run_in_background: false,
    });
    tally.claudeToolUse('Skill', { skill: 'dataviz' });
    tally.claudeToolUse('Skill', { args: 'no id key at all' });
    tally.claudeToolUse('ReportFindings', { findings: [] });

    const usage = tally.finalize('stream');
    expect(usage.coverage).toBe('full');
    expect(usage.tools).toEqual({
      Agent: 1,
      Bash: 2,
      Read: 2,
      ReportFindings: 1,
      Skill: 2,
    });
    expect(usage.mcp).toEqual([
      { server: 'chrome-devtools', tool: 'take_snapshot', calls: 1 },
      { server: 'haive-rag', tool: 'rag_search', calls: 2 },
    ]);
    expect(usage.subagents).toEqual([{ type: 'general-purpose', calls: 1 }]);
    expect(usage.skills).toEqual({
      invoked: [
        { id: 'dataviz', calls: 1 },
        { id: null, calls: 1 },
      ],
      read: [{ id: 'project-context', reads: 1 }],
    });
    expect(usage.agents).toEqual({ assigned: [], read: [{ id: 'peer-reviewer', reads: 1 }] });
    // sum(tools) + sum(mcp) is the run's total: MCP calls never land in `tools`.
    expect(Object.keys(usage.tools).some((k) => k.startsWith('mcp__'))).toBe(false);
  });

  it('classifies MCP filesystem reads by their path argument', () => {
    const tally = createToolUsageTally({ workdir: WORKDIR });
    tally.claudeToolUse('mcp__filesystem__read_text_file', {
      path: '/haive/workdir/.claude/agents/drupal7-developer.md',
    });
    tally.claudeToolUse('mcp__filesystem__read_multiple_files', {
      paths: [
        '/haive/workdir/.claude/skills/user-permissions/SKILL.md',
        '/haive/workdir/README.md',
      ],
    });
    const usage = tally.finalize('stream');
    expect(usage.agents.read).toEqual([{ id: 'drupal7-developer', reads: 1 }]);
    expect(usage.skills.read).toEqual([{ id: 'user-permissions', reads: 1 }]);
    expect(usage.mcp.map((m) => m.tool)).toEqual(['read_multiple_files', 'read_text_file']);
  });
});

describe('createToolUsageTally — grok', () => {
  it('records the inventory without an agents list and unwraps use_tool', () => {
    const tally = createToolUsageTally({ workdir: WORKDIR });
    tally.claudeInit(GROK_INIT);
    tally.claudeToolUse('use_tool', {
      tool_name: 'haive-rag__rag_search',
      tool_input: { query: 'certificate generation' },
    });
    tally.claudeToolUse('read_file', {
      target_file: '/haive/workdir/.claude/agents/playwright-tester.md',
      limit: 200,
    });
    tally.claudeToolUse('grep', { pattern: 'mpdf', path: '.claude/agents/pdf-specialist.md' });
    tally.claudeToolUse('run_terminal_command', {
      command: 'cat /haive/workdir/.claude/skills/inspection-workflow/SKILL.md',
      description: 'Read the skill',
    });
    tally.claudeToolUse('spawn_subagent', { task: 'review the module' });

    const usage = tally.finalize('stream');
    expect(usage.loaded).toEqual({
      agents: [],
      skills: ['build-with-ai', 'code-review', 'create-skill'],
      mcpServers: ['filesystem', 'git'],
      toolCount: 6,
    });
    expect(usage.tools).toEqual({
      grep: 1,
      read_file: 1,
      run_terminal_command: 1,
      spawn_subagent: 1,
    });
    expect(usage.mcp).toEqual([{ server: 'haive-rag', tool: 'rag_search', calls: 1 }]);
    expect(usage.agents.read).toEqual([{ id: 'playwright-tester', reads: 1 }]);
    expect(usage.skills.read).toEqual([{ id: 'inspection-workflow', reads: 1 }]);
    // A search over a definition is not the definition being read.
    expect(usage.agents.read.some((a) => a.id === 'pdf-specialist')).toBe(false);
    expect(usage.subagents).toEqual([{ type: null, calls: 1 }]);
  });
});

describe('createToolUsageTally — codex', () => {
  const EXEC_ITEMS = [
    {
      id: 'item_2',
      type: 'command_execution',
      command: "/bin/bash -lc 'cat .agents/skills/inspection-records/SKILL.md'",
      aggregated_output: '# inspection-records',
      exit_code: 0,
      status: 'completed',
    },
    {
      id: 'item_3',
      type: 'mcp_tool_call',
      server: 'haive-rag',
      tool: 'rag_search',
      arguments: { query: 'signing' },
      result: { content: [] },
      error: null,
      status: 'completed',
    },
    {
      id: 'item_4',
      type: 'mcp_tool_call',
      server: 'filesystem',
      tool: 'read_text_file',
      arguments: { path: '/haive/workdir/.codex/agents/performance-reviewer.toml' },
      result: { content: [] },
      error: null,
      status: 'completed',
    },
    {
      id: 'item_5',
      type: 'collab_tool_call',
      tool: 'wait',
      status: 'completed',
      sender_thread_id: 't1',
      receiver_thread_ids: ['t2'],
      agents_states: {},
      prompt: null,
    },
    { id: 'item_6', type: 'agent_message', text: 'Done.' },
    { id: 'item_7', type: 'reasoning', text: '…' },
    { id: 'item_8', type: 'web_search', query: 'mpdf', action: 'search' },
  ];

  it('tallies exec --json items and skips the prose ones', () => {
    const tally = createToolUsageTally({ workdir: WORKDIR });
    for (const item of EXEC_ITEMS) tally.codexExecItem(item);
    const usage = tally.finalize('stream');
    expect(usage.coverage).toBe('full');
    expect(usage.tools).toEqual({ collab_tool_call: 1, command_execution: 1, web_search: 1 });
    expect(usage.mcp).toEqual([
      { server: 'filesystem', tool: 'read_text_file', calls: 1 },
      { server: 'haive-rag', tool: 'rag_search', calls: 1 },
    ]);
    expect(usage.subagents).toEqual([{ type: 'wait', calls: 1 }]);
    expect(usage.skills.read).toEqual([{ id: 'inspection-records', reads: 1 }]);
    expect(usage.agents.read).toEqual([{ id: 'performance-reviewer', reads: 1 }]);
    expect(usage.loaded).toBeNull();
  });

  it('folds the app-server spellings onto the exec ones and skips its prose items', () => {
    const tally = createToolUsageTally({ workdir: WORKDIR });
    // Measured app-server items (result/arguments trimmed).
    tally.codexAppServerItem({
      id: 'exec-0ad6eea1-c100-4193-ae40-2a0f67ebc5c8',
      type: 'mcpToolCall',
      server: 'haive-rag',
      tool: 'rag_search',
      status: 'completed',
      arguments: { query: 'section numbering' },
      appContext: null,
      pluginId: null,
      readOnlyHint: null,
      result: {},
      error: null,
      durationMs: 812,
    });
    tally.codexAppServerItem({
      id: 'exec-1',
      type: 'commandExecution',
      pluginId: null,
      scriptPath: null,
      command: '/bin/bash -lc "sed -n \'1,240p\' .claude/agents/pdf-specialist.md"',
      cwd: '/haive/workdir',
      processId: '43612',
      source: 'unifiedExecStartup',
      status: 'completed',
      commandActions: [
        { type: 'read', command: "sed -n '1,240p' .claude/agents/pdf-specialist.md" },
      ],
    });
    tally.codexAppServerItem({ id: 'exec-2', type: 'agentMessage', text: 'Done.' });
    tally.codexAppServerItem({ id: 'exec-3', type: 'userMessage', content: [] });
    tally.codexAppServerItem({ id: 'exec-4', type: 'contextCompaction' });
    tally.codexAppServerItem({ id: 'exec-5', type: 'fooBar' });

    const usage = tally.finalize('stream');
    expect(usage.tools).toEqual({ command_execution: 1, fooBar: 1 });
    expect(usage.mcp).toEqual([{ server: 'haive-rag', tool: 'rag_search', calls: 1 }]);
    expect(usage.agents.read).toEqual([{ id: 'pdf-specialist', reads: 1 }]);
  });

  it('records a prose-only codex stream as observable', () => {
    const tally = createToolUsageTally({ workdir: WORKDIR });
    tally.codexExecItem({ id: 'item_1', type: 'agent_message', text: 'Nothing to do.' });
    expect(tally.sawObservableEvent()).toBe(true);
    expect(tally.finalize('stream').coverage).toBe('full');
  });
});

describe('coverage, shape and determinism', () => {
  it('is none until an event of a tool-bearing format arrives', () => {
    const tally = createToolUsageTally({ workdir: WORKDIR });
    expect(tally.sawObservableEvent()).toBe(false);
    expect(tally.finalize('stream')).toEqual(unobservedToolUsage('stream'));
  });

  it('is partial when the caller reports an elided transcript', () => {
    const tally = createToolUsageTally({ workdir: WORKDIR });
    tally.claudeInit(CLAUDE_INIT);
    expect(tally.finalize('backfill', true).coverage).toBe('partial');
    expect(tally.finalize('backfill', false).coverage).toBe('full');
  });

  it('pins the record shape: every key present, arrays sorted, assigned empty', () => {
    const tally = createToolUsageTally({ workdir: WORKDIR });
    tally.claudeToolUse('mcp__zeta__z', {});
    tally.claudeToolUse('mcp__alpha__b', {});
    tally.claudeToolUse('mcp__alpha__a', {});
    tally.claudeToolUse('Write', { file_path: 'x' });
    tally.claudeToolUse('Bash', {
      command: 'cat .claude/skills/zzz/SKILL.md .claude/skills/aaa/SKILL.md',
    });
    tally.claudeToolUse('Read', { file_path: '.claude/agents/zeta.md' });
    tally.claudeToolUse('Read', { file_path: '.claude/agents/alpha.md' });
    tally.claudeToolUse('Agent', { subagent_type: 'zed' });
    tally.claudeToolUse('spawn_subagent', {});
    tally.claudeToolUse('Agent', { subagent_type: 'abe' });
    const usage = tally.finalize('stream');
    expect(Object.keys(usage)).toEqual([
      'source',
      'coverage',
      'tools',
      'mcp',
      'subagents',
      'skills',
      'agents',
      'loaded',
    ]);
    expect(Object.keys(usage.tools)).toEqual(['Agent', 'Bash', 'Read', 'Write', 'spawn_subagent']);
    expect(usage.mcp.map((m) => `${m.server}/${m.tool}`)).toEqual(['alpha/a', 'alpha/b', 'zeta/z']);
    expect(usage.subagents.map((s) => s.type)).toEqual(['abe', 'zed', null]);
    expect(usage.skills.read.map((s) => s.id)).toEqual(['aaa', 'zzz']);
    expect(usage.agents.read.map((a) => a.id)).toEqual(['alpha', 'zeta']);
    expect(usage.agents.assigned).toEqual([]);
    expect(usage.loaded).toBeNull();
  });

  it('produces byte-identical JSON for the same events, whatever their order', () => {
    const events: Array<[string, Record<string, unknown>]> = [
      ['mcp__haive-rag__rag_search', {}],
      ['Read', { file_path: '.claude/agents/b.md' }],
      ['Read', { file_path: '.claude/agents/a.md' }],
      ['Bash', { command: 'cat .claude/skills/s/SKILL.md' }],
    ];
    const forward = createToolUsageTally({ workdir: WORKDIR });
    const backward = createToolUsageTally({ workdir: WORKDIR });
    for (const [name, input] of events) forward.claudeToolUse(name, input);
    for (const [name, input] of [...events].reverse()) backward.claudeToolUse(name, input);
    expect(JSON.stringify(forward.finalize('backfill'))).toBe(
      JSON.stringify(backward.finalize('backfill')),
    );
  });
});

describe('applyProviderObservability', () => {
  it('empties the counters for amp and keeps what it loaded', () => {
    const tally = createToolUsageTally({ workdir: WORKDIR });
    tally.claudeInit({
      ...CLAUDE_INIT,
      agents: undefined,
      skills: undefined,
      tools: ['shell_command', 'Task'],
    });
    const usage = applyProviderObservability(tally.finalize('stream'), 'amp');
    expect(usage).toEqual({
      ...unobservedToolUsage('stream', {
        agents: [],
        skills: [],
        mcpServers: ['haive-rag', 'filesystem'],
        toolCount: 2,
      }),
    });
  });

  it('leaves every other provider untouched, and null null', () => {
    const tally = createToolUsageTally({ workdir: WORKDIR });
    tally.claudeToolUse('Bash', { command: 'ls' });
    const usage = tally.finalize('stream');
    expect(applyProviderObservability(usage, 'claude-code')).toBe(usage);
    expect(applyProviderObservability(usage, null)).toBe(usage);
    expect(applyProviderObservability(null, 'amp')).toBeNull();
  });
});
