import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { AgentSpec } from '@haive/shared';
import { parseFlatToml } from '../src/bundle-parser/decoders/codex-toml.js';
import { buildMcpConfigForCli } from '../src/sandbox/mcp-config.js';
import { agentsIndexMarkdown } from '../src/step-engine/steps/onboarding/07-generate-files.js';
import {
  skillToMarkdown,
  subSkillToMarkdown,
} from '../src/step-engine/steps/onboarding/09_5-skill-generation.js';
import { buildAgentFileForTarget } from '../src/step-engine/steps/onboarding/_agent-templates.js';

const BASE: AgentSpec = {
  id: 'synthetic',
  title: 'Synthetic',
  description: 'Synthetic description',
  color: 'blue',
  field: 'general',
  tools: [],
  coreMission: 'Synthetic mission',
  responsibilities: [],
  whenInvoked: [],
  executionSteps: [],
  outputFormat: '',
  qualityCriteria: [],
  antiPatterns: [],
};
const frontmatter = (md: string) => md.split('\n---\n')[0]!.slice(4);
const python = spawnSync('python3', ['-I', '-c', 'import tomllib'], { timeout: 5000 });
const pythonToml = (documents: string[]) => {
  const run = spawnSync(
    'python3',
    [
      '-I',
      '-c',
      'import json,sys,tomllib; print(json.dumps([tomllib.loads(s) for s in json.load(sys.stdin)]))',
    ],
    { input: JSON.stringify(documents), encoding: 'utf8', timeout: 5000 },
  );
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(run.stdout) as Record<string, unknown>[];
};

describe.skipIf(python.status !== 0)('T740.3 multiline TOML quote delimiters', () => {
  it('reads closing runs of three, four and five quotes like tomllib', () => {
    const documents = [3, 4, 5].map(
      (n) => `developer_instructions = """body${'"'.repeat(n)}\nname = "after"\n`,
    );
    const expected = pythonToml(documents);
    documents.forEach((doc, i) => expect(parseFlatToml(doc)).toEqual(expected[i]));
  });

  it('round-trips emitted runs of 5, 8 and 11 quotes without truncating the body', () => {
    const documents = [5, 8, 11].map((n) =>
      buildAgentFileForTarget(
        { ...BASE, coreMission: `Before ${'"'.repeat(n)} after` },
        { dir: '.codex/agents', format: 'toml' },
      ),
    );
    const expected = pythonToml(documents);
    documents.forEach((doc, i) => expect(parseFlatToml(doc)).toEqual(expected[i]));
  });

  it('respects escaped quotes and even/odd backslashes before a delimiter', () => {
    const documents = [
      String.raw`developer_instructions = """a \""" b"""`,
      String.raw`developer_instructions = """a \\"""`,
      String.raw`developer_instructions = """a \\\""" b"""`,
      'developer_instructions = """\r\nbody\r\n"""',
    ];
    const expected = pythonToml(documents);
    documents.forEach((doc, i) => expect(parseFlatToml(doc)).toEqual(expected[i]));
  });
});

describe('T740.4 lenient escapes and TOML continuations', () => {
  it('keeps unknown and malformed escapes verbatim in both string forms', () => {
    for (const raw of [
      String.raw`x\qy`,
      String.raw`x\u12G4y`,
      String.raw`x\uD800y`,
      String.raw`x\U00110000y`,
    ]) {
      expect(parseFlatToml(`description = "${raw}"`).description).toBe(raw);
      expect(parseFlatToml(`developer_instructions = """${raw}"""`).developer_instructions).toBe(
        raw,
      );
    }
  });

  it.skipIf(python.status !== 0)(
    'trims only unescaped line-ending backslashes and TOML whitespace',
    () => {
      const documents = [
        'developer_instructions = """\nfirst \\\n\n \tsecond\\ \t\r\n  third\\\n  """',
        'developer_instructions = """first\\\\\n  second"""',
        'developer_instructions = """first\\\\\\\n  second"""',
        'developer_instructions = """first\\\n  \u00a0second"""',
        String.raw`developer_instructions = """first\n  second"""`,
      ];
      const expected = pythonToml(documents);
      documents.forEach((doc, i) => expect(parseFlatToml(doc)).toEqual(expected[i]));
    },
  );
});

describe.skipIf(python.status !== 0)('T740.5 MCP TOML encoding', () => {
  it.each([
    'line one\nline two',
    Array.from({ length: 128 }, (_, n) => String.fromCharCode(n)).join('') + 'Prüft 😀',
  ])('round-trips env values and arguments %#', (value) => {
    const config = buildMcpConfigForCli('codex', [], undefined, {
      synthetic: { command: 'runner', args: [value], env: { VALUE: value } },
    })!;
    const [doc] = pythonToml([config.content]);
    expect(doc).toEqual({
      mcp_servers: { synthetic: { command: 'runner', args: [value], env: { VALUE: value } } },
    });
  });

  it.each(['synthetic', 'synthetic.server "\\\n'])(
    'quotes odd env keys for server %# without changing bare keys',
    (name) => {
      const env = {
        'a.b': 'dot',
        'space key': 'space',
        'a"\\\nkey': 'escaped',
        '': 'empty',
        BARE_1: 'plain',
      };
      const config = buildMcpConfigForCli('codex', [], undefined, {
        [name]: { command: 'runner', args: [], env },
      })!;
      expect(pythonToml([config.content])[0]).toEqual({
        mcp_servers: { [name]: { command: 'runner', args: [], env } },
      });
      expect(config.content).toContain('BARE_1 = "plain"');
    },
  );
});

describe('T740.6 skill description scalars', () => {
  const descriptions = [
    `${'long synthetic prose '.repeat(8)}control\u0001end`,
    'line one\nline two\u0001end',
    `${'x'.repeat(125)}\u0085NEL\u2028LS\u2029PS\uFFFFend`,
    'line one\nline two',
  ];
  it.each(descriptions)('round-trips description %# through YAML 1.1 and 1.2', (description) => {
    const fm = frontmatter(skillToMarkdown({ id: 'synthetic', title: 'Synthetic', description }));
    for (const version of ['1.1', '1.2'] as const)
      expect(parse(fm, { version }).description).toBe(description);
  });

  it('uses the same description scalar for generated sub-skills', () => {
    const description = descriptions[0]!;
    const fm = frontmatter(
      subSkillToMarkdown('synthetic', {
        slug: 'sub',
        name: 'synthetic-sub',
        title: 'Synthetic sub',
        description,
        summary: 'Synthetic summary',
        body: 'Synthetic body',
      }),
    );
    expect(parse(fm).description).toBe(description);
  });

  const pythonYaml = ['python3', '/usr/bin/python3'].find(
    (cmd) => spawnSync(cmd, ['-I', '-c', 'import yaml'], { timeout: 5000 }).status === 0,
  );
  it.skipIf(!pythonYaml)('round-trips those descriptions through PyYAML', () => {
    const documents = descriptions.map((description) =>
      frontmatter(skillToMarkdown({ id: 'synthetic', title: 'Synthetic', description })),
    );
    const run = spawnSync(
      pythonYaml!,
      [
        '-I',
        '-c',
        'import json,sys,yaml; print(json.dumps([yaml.safe_load(s)["description"] for s in json.load(sys.stdin)]))',
      ],
      { input: JSON.stringify(documents), encoding: 'utf8', timeout: 5000 },
    );
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual(descriptions);
  });
});

describe('T740.7 agents index cells', () => {
  it('collapses controls and line breaks while escaping pipes after backslashes', () => {
    const description = 'before\u0001after\u007fDEL\u0085NEL\u2028LS\u2029PS\r\nlast\\|cell';
    const md = agentsIndexMarkdown([{ ...BASE, description }]);
    expect(md).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/);
    expect(md.split('\n').filter((l) => l.startsWith('| ['))).toEqual([
      '| [synthetic](synthetic.md) | before after DEL NEL LS PS last\\\\\\|cell |',
    ]);
  });
});

describe('T740.8 names have independent serializer controls', () => {
  const names = ['yes', 'a: b', 'a\nline\u0001\u007f\u0085\u2028\uFFFF', 'a"\\b'];
  it.skipIf(python.status !== 0)(
    'round-trips varied names and a fixed description through TOML',
    () => {
      const docs = names.map((id) =>
        buildAgentFileForTarget({ ...BASE, id }, { dir: '.codex/agents', format: 'toml' }),
      );
      const parsed = pythonToml(docs);
      expect(parsed.map((d) => d.name)).toEqual(names);
      expect(parsed.map((d) => d.description)).toEqual(names.map(() => BASE.description));
    },
  );
  it('round-trips varied names and a fixed description through each YAML serializer', () => {
    for (const dir of ['.claude/agents', '.gemini/agents']) {
      for (const id of names) {
        const fm = frontmatter(
          buildAgentFileForTarget({ ...BASE, id }, { dir, format: 'markdown' }),
        );
        for (const version of ['1.1', '1.2'] as const) expect(parse(fm, { version }).name).toBe(id);
      }
    }
  });
});
