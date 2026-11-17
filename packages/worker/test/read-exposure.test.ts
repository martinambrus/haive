import { describe, expect, it } from 'vitest';
import { createStreamJsonCollector } from '../src/queues/cli-exec/stream.js';
import { createCodexJsonlCollector } from '../src/cli-executor/codex-jsonl.js';
import {
  READ_EXPOSURE_FILE_LIMIT,
  READ_EXPOSURE_PATH_LIMIT,
} from '../src/cli-executor/read-exposure.js';
import { createToolUsageTally } from '../src/cli-executor/tool-usage.js';
import { toolUsageFromStreamLog } from '../src/queues/cli-exec/tool-usage-backfill.js';
import { createStreamLogBuffer } from '../src/queues/cli-exec/stream-log-buffer.js';

const root = '/haive/workdir';
const assistant = (id: string, content: unknown[] = []) => ({
  type: 'assistant',
  message: { id, content },
});
const use = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input });
const result = (id: string, content: unknown) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content }] },
});
const log = (events: unknown[]) => events.map((e) => JSON.stringify(e)).join('\n') + '\n';
const read = (events: unknown[]) => toolUsageFromStreamLog('claude-code', log(events), root).reads!;
// Shell fixtures explicitly report cwd; missing-cwd coverage lives below.
const one = (name: string, input: unknown) => [
  assistant('a', [use('t', name, name === 'Bash' ? { cwd: root, ...(input as object) } : input)]),
  result('t', 'abcd'),
  assistant('b'),
  { type: 'result' },
];

describe('read exposure', () => {
  it('counts whole and ranged reads by returned characters and later distinct turns', () => {
    const events = [
      assistant('a', [use('t', 'Read', { file_path: 'src/a.ts' })]),
      result('t', 'abcd'),
      assistant('b', [use('u', 'Read', { file_path: 'src/a.ts', offset: 2, limit: 1 })]),
      result('u', [{ type: 'text', text: 'xy' }]),
      assistant('c'),
      { type: 'result' },
    ];
    expect(read(events)).toMatchObject({
      version: 1,
      coverage: 'full',
      turns: 3,
      compactions: 0,
      resultSeen: true,
      results: { reads: 2, chars: 6, weightedChars: 10 },
      fileReads: { reads: 2, chars: 6, weightedChars: 10 },
      files: [{ path: 'src/a.ts', reads: 2, chars: 6, weightedChars: 10 }],
    });
    const tally = createToolUsageTally({ workdir: root });
    const live = createStreamJsonCollector(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      tally,
    );
    live.onChunk(log(events));
    expect(live.getToolUsage().reads).toEqual(read(events));
  });

  it.each([
    'sed -n 1,20p src/a.ts',
    'cat src/a.ts 2>/dev/null',
    'cat src/a.ts 2>&1',
    'sed -n 1,20p src/a.ts 1>&2',
    'cat src/a.ts >&-',
    'head -n 4 src/a.ts',
    'tail -10 src/a.ts',
    'nl src/a.ts',
  ])('recognises a reader without charging redirects: %s', (command) => {
    expect(read(one('Bash', { command })).files).toEqual([
      { path: 'src/a.ts', reads: 1, chars: 4, weightedChars: 4 },
    ]);
  });

  it.each(['cat src/a.ts src/b.ts', 'cat src/a.ts && cat src/b.ts'])(
    'puts combined output in one multi-file bucket: %s',
    (command) => {
      expect(read(one('Bash', { command }))).toMatchObject({
        files: [],
        multiFile: { reads: 1, chars: 4, weightedChars: 4 },
        fileReads: { reads: 1, chars: 4, weightedChars: 4 },
      });
    },
  );

  it('normalises mount and worktree paths, dot segments and outside paths', () => {
    expect(
      read(one('Read', { file_path: `${root}/.haive/worktrees/task/src/../a.ts` })).files[0]?.path,
    ).toBe('a.ts');
    expect(read(one('Bash', { command: 'cat /tmp/a /tmp/b' }))).toMatchObject({
      outside: { chars: 4 },
      fileReads: { chars: 0 },
    });
    expect(read(one('Bash', { command: 'cat src/a.ts /tmp/b' }))).toMatchObject({
      unattributed: { chars: 4 },
      fileReads: { chars: 0 },
    });
    for (const file_path of ['/tmp/private', `${root}/../../etc/passwd`, '../elsewhere']) {
      expect(read(one('Read', { file_path }))).toMatchObject({
        files: [],
        outside: { chars: 4 },
        fileReads: { chars: 0 },
      });
    }
  });

  it.each([
    'cat "$file"',
    'cat *.ts',
    'cat src/[ab].ts',
    'cat ~/.claude/skills/x/SKILL.md',
    'cat "~/.codex/skills/x/SKILL.md"',
    'cat src/a.ts > ~/out',
    'cat src/a.ts | head -5',
    'echo cat src/a.ts',
    'python -c "print(1)"',
  ])('keeps unknown syntax unattributed: %s', (command) => {
    expect(read(one('Bash', { command }))).toMatchObject({
      files: [],
      unattributed: { chars: command.startsWith('python ') ? 0 : 4 },
      fileReads: { chars: 0 },
    });
  });

  it.each(['exec', 'app-server'] as const)(
    'resolves reported cwd before classifying %s commands, identically live and replayed',
    (transport) => {
      for (const [cwd, command, bucket, path] of [
        [root + '/packages/worker', 'cat package.json', 'files', 'packages/worker/package.json'],
        [
          root + '/.haive/worktrees/task/packages/worker',
          'cat ../shared/a.ts',
          'files',
          'packages/shared/a.ts',
        ],
        [root + '/.haive/worktrees/task', 'cat package.json', 'files', 'package.json'],
        ['/tmp', 'cat package.json', 'outside', null],
        [root + '-other', 'cat package.json', 'outside', null],
        [root, 'cat ../private', 'outside', null],
        [
          undefined,
          'cat package.json',
          transport === 'exec' ? 'files' : 'unattributed',
          transport === 'exec' ? 'package.json' : null,
        ],
        [null, 'cat package.json', 'unattributed', null],
        ['', 'cat package.json', 'unattributed', null],
        ['packages/worker', 'cat package.json', 'unattributed', null],
        [root + '/bad\u0000', 'cat package.json', 'unattributed', null],
        [undefined, 'cat ' + root + '/src/a.ts', 'files', 'src/a.ts'],
        [root, 'cd packages/worker && cat package.json', 'unattributed', null],
      ] as const) {
        const item = {
          id: 'cwd',
          type: transport === 'exec' ? 'command_execution' : 'commandExecution',
          command,
          cwd,
          aggregated_output: 'abcd',
          aggregatedOutput: 'abcd',
        };
        const tally = createToolUsageTally({ workdir: root });
        if (transport === 'exec') tally.codexExecItem(item);
        else tally.codexAppServerItem(item);
        const event =
          transport === 'exec'
            ? { type: 'item.completed', item }
            : { method: 'item/completed', params: { item } };
        const stored = toolUsageFromStreamLog('codex', log([event]), root).reads!;
        expect(tally.finalize('stream').reads).toEqual(stored);
        expect(stored, JSON.stringify({ cwd, command })).toMatchObject({
          files: path ? [{ path, chars: 4 }] : [],
          [bucket === 'files' ? 'fileReads' : bucket]: { chars: 4 },
        });
        if (!path) expect(stored.fileReads.chars).toBe(0);
      }
    },
  );

  it('attributes real Codex exec items without cwd to the launch root, live and replayed', () => {
    // Production exec items omit cwd entirely, unlike app-server commandExecution items.
    const item = {
      id: 'exec-no-cwd',
      type: 'command_execution',
      command: "sed -n '1,20p' src/a.ts",
      aggregated_output: 'abcd',
    };
    for (const command of [item.command, `/bin/bash -lc "${item.command}"`]) {
      const event = { type: 'item.completed', item: { ...item, command } };
      const stored = toolUsageFromStreamLog('codex', log([event]), root).reads!;
      const live = createCodexJsonlCollector(undefined, createToolUsageTally({ workdir: root }));
      live.onChunk(log([event]));
      expect(live.getToolUsage().reads).toEqual(stored);
      expect(stored).toMatchObject({
        files: [{ path: 'src/a.ts', chars: 4, weightedChars: null }],
        fileReads: { chars: 4 },
        unattributed: { chars: 0 },
      });
    }
    for (const command of ["cd src && sed -n '1,20p' a.ts", "pushd src; sed -n '1,20p' a.ts"]) {
      expect(
        toolUsageFromStreamLog(
          'codex',
          log([{ type: 'item.completed', item: { ...item, command } }]),
          root,
        ).reads,
      ).toMatchObject({ files: [], fileReads: { chars: 0 }, unattributed: { chars: 4 } });
    }
    expect(
      read([
        assistant('a', [use('t', 'Bash', { command: item.command })]),
        result('t', 'abcd'),
        assistant('b'),
      ]),
    ).toMatchObject({ files: [], fileReads: { chars: 0 }, unattributed: { chars: 4 } });
    const unknownRoot = createToolUsageTally({ workdir: null });
    unknownRoot.codexExecItem(item);
    expect(unknownRoot.finalize('stream').reads).toMatchObject({
      files: [],
      unattributed: { chars: 4 },
    });
  });

  it.each(['bash -lc', 'sh -c'])(
    'rejects expansion and escape characters anywhere inside outer double quotes: %s',
    (shell) => {
      for (const inner of [
        "cat '$HOME/x'",
        "cat '`pwd`/x'",
        "cat 'src/a\\b.ts'",
        "sed -n '$p' src/a.ts",
      ]) {
        const command = `${shell} "${inner}"`;
        expect(read(one('Bash', { command })), command).toMatchObject({
          files: [],
          fileReads: { chars: 0 },
          unattributed: { chars: 4 },
        });
        const tally = createToolUsageTally({ workdir: root });
        tally.codexExecItem({
          id: 'wrapper',
          type: 'command_execution',
          command,
          aggregated_output: 'abcd',
        });
        expect(tally.finalize('stream').reads, command).toMatchObject({
          files: [],
          fileReads: { chars: 0 },
          unattributed: { chars: 4 },
        });
      }
    },
  );

  it.each(['Bash', 'bash', 'execute_command', 'run_terminal_command'])(
    'respects per-call cwd and does not infer one from init for %s',
    (name) => {
      for (const [metadata, bucket, path] of [
        [{ cwd: root + '/packages/worker' }, 'files', 'packages/worker/package.json'],
        [
          { cwd: root + '/.haive/worktrees/task/packages/worker' },
          'files',
          'packages/worker/package.json',
        ],
        [{ cwd: '/tmp' }, 'outside', null],
        [{}, 'unattributed', null],
        [{ cwd: null }, 'unattributed', null],
      ] as const) {
        const events = [
          { type: 'system', subtype: 'init', cwd: root },
          ...one(name, Object.assign({ command: 'cat package.json', cwd: undefined }, metadata)),
        ];
        expect(read(events)).toMatchObject({
          files: path ? [{ path, chars: 4 }] : [],
          [bucket === 'files' ? 'fileReads' : bucket]: { chars: 4 },
        });
      }
    },
  );

  it.each([
    'cat <<< README.md',
    'cat << EOF README.md',
    'cat <<- EOF README.md',
    'cat src/a.ts <<< text',
    'cat src/a.ts <> target',
    'cat src/a.ts >| target',
    'cat src/a.ts <&0',
    'cat src/a.ts &> out',
    'cat src/a.ts > > target',
    'cat src/a.ts >>&1',
    'cat src/a.ts < input',
  ])('keeps unsupported redirects unattributed: %s', (command) => {
    expect(read(one('Bash', { command }))).toMatchObject({
      files: [],
      fileReads: { chars: 0 },
      outside: { chars: 0 },
      unattributed: { chars: 4 },
    });
  });

  it.each([
    "sed -n 'r /tmp/generated.txt' src/a.ts",
    "sed -n 'R /tmp/generated.txt' src/a.ts",
    "sed -n 'w /tmp/output' src/a.ts",
    "sed -n 'W /tmp/output' src/a.ts",
    "sed -n 'e echo text' src/a.ts",
    "sed -n 's/x/y/e' src/a.ts",
    "sed -n '1p;r /tmp/generated.txt' src/a.ts",
    "sed -n 'd' src/a.ts",
    "sed -n -e 1p -e 'r /tmp/generated.txt' src/a.ts",
    "sed -n -e 1p -e 's/x/y/' src/a.ts",
    'sed -n -e src/a.ts',
    "sed -n --expression='r /tmp/generated.txt' src/a.ts",
    'sed -n -f script.sed src/a.ts',
  ])('requires every sed expression to be a known print form: %s', (command) => {
    expect(read(one('Bash', { command }))).toMatchObject({
      files: [],
      fileReads: { chars: 0 },
      unattributed: { chars: 4 },
    });
  });

  it.each([
    "sed -n '1,20p' src/a.ts",
    "sed -n '2p' src/a.ts",
    "sed -n '/read/p' src/a.ts",
    "sed -n '$p' src/a.ts",
    "sed -n 'p' src/a.ts",
    "sed '2p' src/a.ts",
    "sed '/read/p' src/a.ts",
    "sed '$p' src/a.ts",
    'sed p src/a.ts',
    "sed -n -e 1p -e '/read/p' src/a.ts",
    'sed -n --expression=1p src/a.ts',
    'sed -n -e1p src/a.ts',
    "sed -n '1p;2,4p' src/a.ts",
  ])('attributes supported sed print expressions: %s', (command) => {
    expect(read(one('Bash', { command })).files).toEqual([
      { path: 'src/a.ts', reads: 1, chars: 4, weightedChars: 4 },
    ]);
  });

  it.each(['Read', 'mcp__filesystem__read_text_file'])(
    'keeps home-relative %s paths outside',
    (name) => {
      expect(
        read(one(name, { file_path: '~/.claude/skills/x/SKILL.md', path: '~/.codex/config' })),
      ).toMatchObject({
        files: [],
        outside: { chars: 4 },
        fileReads: { chars: 0 },
      });
    },
  );

  it.each(['a\u0000b.ts', 'x\ud83d.ts', 'x\udc00.ts', 'a'.repeat(1025)])(
    'keeps unsafe or oversized paths unattributed: %j',
    (path) => {
      for (const [name, input] of [
        ['Read', { file_path: path }],
        ['mcp__filesystem__read_text_file', { path }],
        ['Bash', { command: `cat '${path}'` }],
      ] as const) {
        expect(read(one(name, input))).toMatchObject({
          files: [],
          unattributed: { chars: 4 },
          outside: { chars: 0 },
          fileReads: { chars: 0 },
        });
      }
    },
  );

  it('accepts paired surrogates and the path length boundary', () => {
    for (const path of ['src/\ud83d\ude00.ts', 'a'.repeat(1024)])
      expect(read(one('Read', { file_path: path })).files[0]?.path).toBe(path);
  });

  it('bounds path lengths with a small injectable limit', () => {
    expect(READ_EXPOSURE_PATH_LIMIT).toBe(1024);
    const tally = createToolUsageTally({ workdir: root, readPathLimit: 4 });
    for (const event of [
      assistant('a', [use('t', 'Read', { file_path: 'ab.ts' })]),
      result('t', 'abcd'),
      assistant('b'),
    ])
      tally.claudeEvent(event);
    expect(tally.finalize('stream').reads).toMatchObject({
      files: [],
      unattributed: { chars: 4, weightedChars: 4 },
    });
  });

  it('excludes only fully angle-bracketed placeholder models from turns', () => {
    const events: unknown[] = one('Read', { file_path: 'a.ts' });
    events.splice(
      2,
      0,
      {
        ...assistant('synthetic'),
        message: { id: 'synthetic', content: [], model: '<synthetic>' },
      },
      { ...assistant('real'), message: { id: 'real', content: [], model: '<model' } },
    );
    expect(read(events)).toMatchObject({ turns: 3, fileReads: { weightedChars: 8 } });
  });

  it('ends exposure at compaction and deduplicates messages, blocks, results and boundaries', () => {
    const a = assistant('a', [use('t', 'Read', { file_path: 'a.ts' })]);
    const b = assistant('b');
    const compact = { type: 'system', subtype: 'compact_boundary', uuid: 'compact-1' };
    expect(
      read([
        a,
        a,
        result('t', 'abcd'),
        result('t', 'abcd'),
        b,
        b,
        compact,
        compact,
        assistant('c'),
      ]),
    ).toMatchObject({
      turns: 3,
      compactions: 1,
      results: { reads: 1, chars: 4, weightedChars: 4 },
    });
    expect(toolUsageFromStreamLog('claude-code', log([a, a]), root).tools).toEqual({ Read: 1 });
  });

  it('does not invent turns for missing message ids or codex items; deduplicates completed items', () => {
    expect(
      read([
        { type: 'assistant', message: { content: [use('t', 'Read', { file_path: 'a.ts' })] } },
        result('t', 'abcd'),
      ]),
    ).toMatchObject({ turns: null, results: { chars: 4, weightedChars: null } });
    const item = {
      id: 'i',
      type: 'command_execution',
      cwd: root,
      command: 'cat src/a.ts',
      aggregated_output: 'abcd',
    };
    const events = [
      { type: 'item.started', item },
      { type: 'item.completed', item },
      { type: 'item.completed', item },
    ];
    const stored = toolUsageFromStreamLog('codex', log(events), root);
    expect(stored.reads).toMatchObject({
      turns: null,
      files: [{ path: 'src/a.ts', reads: 1, chars: 4, weightedChars: null }],
    });
    const live = createCodexJsonlCollector(undefined, createToolUsageTally({ workdir: root }));
    live.onChunk(log(events));
    expect(live.getToolUsage().reads).toEqual(stored.reads);
  });

  it('keeps weighted exposure unknown in an elided transcript', () => {
    const buffer = createStreamLogBuffer({ headChars: 300, tailChars: 100 });
    buffer.push(log(one('Read', { file_path: 'a.ts' })));
    buffer.push('x'.repeat(600));
    buffer.push(log([{ type: 'result' }]));
    const usage = toolUsageFromStreamLog('claude-code', buffer.toString(), root);
    expect(usage.reads).toMatchObject({ coverage: 'partial', results: { weightedChars: null } });
  });

  it('bounds the file list by weighted exposure, then characters, with a reconciling overflow', () => {
    const tally = createToolUsageTally({ workdir: root, readFileLimit: 2 });
    for (const event of [
      assistant('a', [
        use('a', 'Read', { file_path: 'a.ts' }),
        use('b', 'Read', { file_path: 'b.ts' }),
        use('c', 'Read', { file_path: 'c.ts' }),
      ]),
      result('a', 'aa'),
      result('b', 'bbb'),
      result('c', 'c'),
      assistant('b'),
    ])
      tally.claudeEvent(event);
    const usage = tally.finalize('stream').reads!;
    expect(usage.files.map((f) => f.path)).toEqual(['b.ts', 'a.ts']);
    expect(usage.overflow).toEqual({ omitted: 1, reads: 1, chars: 1, weightedChars: 1 });
    expect(usage.fileReads).toEqual({ reads: 3, chars: 6, weightedChars: 6 });
    const weighted = createToolUsageTally({ workdir: root, readFileLimit: 1 });
    for (const event of [
      assistant('a', [use('a', 'Read', { file_path: 'a.ts' })]),
      result('a', 'aa'),
      assistant('b'),
      assistant('c', [use('b', 'Read', { file_path: 'b.ts' })]),
      result('b', 'bbbb'),
      assistant('d'),
    ])
      weighted.claudeEvent(event);
    expect(weighted.finalize('stream').reads?.files).toEqual([
      { path: 'a.ts', reads: 1, chars: 2, weightedChars: 6 },
    ]);
  });

  it('writes an explicit versioned terminal state for unobservable transcripts', () => {
    expect(toolUsageFromStreamLog('gemini', null, root).reads).toMatchObject({
      version: 1,
      coverage: 'none',
      turns: null,
      results: { weightedChars: null },
    });
  });
  it('pins the production cap and preserves lifetime across repeated snapshots', () => {
    expect(READ_EXPOSURE_FILE_LIMIT).toBe(50);
    const tally = createToolUsageTally({ workdir: root });
    for (const e of [
      assistant('a', [use('t', 'Read', { file_path: 'a.ts' })]),
      result('t', 'abcd'),
      assistant('b'),
    ])
      tally.claudeEvent(e);
    const first = tally.finalize('stream');
    expect(tally.finalize('stream')).toEqual(first);
    tally.claudeEvent(assistant('c'));
    expect(tally.finalize('stream').reads?.fileReads.weightedChars).toBe(8);
    expect(first.reads?.fileReads.weightedChars).toBe(4);
  });

  it('keeps subagent context exposure separate from the parent and other agents', () => {
    const child = (e: object) => ({ ...e, parent_tool_use_id: 'child' });
    const events = [
      assistant('a', [use('t', 'Read', { file_path: 'a.ts' })]),
      result('t', 'abcd'),
      child(assistant('x', [use('u', 'Read', { file_path: 'b.ts' })])),
      child(result('u', 'xy')),
      child(assistant('y')),
      assistant('b'),
    ];
    expect(read(events)).toMatchObject({
      turns: 4,
      files: [
        { path: 'a.ts', weightedChars: 4 },
        { path: 'b.ts', weightedChars: 2 },
      ],
    });
  });

  it('handles quoted shell wrappers and app-server output with the same tally', () => {
    const item = {
      id: 'i',
      type: 'commandExecution',
      cwd: root,
      command: '/bin/bash -lc "sed -n \'1,20p\' src/a.ts"',
      aggregatedOutput: 'abcd',
    };
    const tally = createToolUsageTally({ workdir: root });
    tally.codexAppServerItem(item);
    tally.codexAppServerItem(item);
    const stored = toolUsageFromStreamLog(
      'codex',
      log([{ method: 'item/completed', params: { item } }]),
      root,
    );
    expect(tally.finalize('stream').reads).toEqual(stored.reads);
    expect(stored.reads).toMatchObject({
      files: [{ path: 'src/a.ts', chars: 4, weightedChars: null }],
    });
  });

  it('counts MCP read results and retains an observed zero on a tool-free Claude run', () => {
    expect(read(one('mcp__filesystem__read_text_file', { path: 'src/a.ts' })).files[0]?.chars).toBe(
      4,
    );
    expect(read([assistant('a'), { type: 'result' }])).toMatchObject({
      turns: 1,
      results: { reads: 0, chars: 0, weightedChars: 0 },
    });
    const item = {
      id: 'm',
      type: 'mcp_tool_call',
      server: 'filesystem',
      tool: 'read_text_file',
      arguments: { path: 'a.ts' },
      result: { content: [{ type: 'text', text: 'abcd' }] },
    };
    expect(
      toolUsageFromStreamLog('codex', log([{ type: 'item.completed', item }]), root).reads,
    ).toMatchObject({ results: { reads: 1, chars: 4 }, files: [{ path: 'a.ts', chars: 4 }] });
  });
});
