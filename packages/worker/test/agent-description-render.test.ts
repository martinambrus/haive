import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { AgentSpec } from '@haive/shared';
import { parseFlatToml } from '../src/bundle-parser/decoders/codex-toml.js';
import {
  buildAgentFileForTarget,
  type AgentRenderTarget,
} from '../src/step-engine/steps/onboarding/_agent-templates.js';

// Every agent description must render to valid, lossless output in each format.

const BASE: AgentSpec = {
  id: 'probe',
  title: 'Probe',
  description: 'x',
  color: 'blue',
  field: 'quality',
  tools: [],
  coreMission: 'Probe.',
  responsibilities: [],
  whenInvoked: [],
  executionSteps: [],
  outputFormat: '',
  qualityCriteria: [],
  antiPatterns: [],
};

const TOML_TARGET: AgentRenderTarget = { dir: '.codex/agents', format: 'toml', supportsLsp: false };
const GEMINI_TARGET: AgentRenderTarget = { dir: '.gemini/agents', format: 'markdown' };
const CLAUDE_TARGET: AgentRenderTarget = { dir: '.claude/agents', format: 'markdown' };
const render = (description: string, target: AgentRenderTarget) =>
  buildAgentFileForTarget({ ...BASE, description }, target);
const bodyOf = (md: string) => md.slice(md.indexOf('\n---\n') + 5);

const CASES: [string, string][] = [
  ...Array.from({ length: 256 }, (_, code): [string, string] => [
    `U+${code.toString(16).toUpperCase().padStart(4, '0')}`,
    `a${String.fromCharCode(code)}b`,
  ]),
  ['two lines LF', 'Line one\nLine two'],
  ['two lines CRLF', 'Line one\r\nLine two'],
  ['tab', 'a\tb'],
  ['quote', 'say "hi"'],
  ['backslash', 'a\\b'],
  ['backslash quote', 'a\\"b'],
  ['triple quote', 'a """ b'],
  ['non-ASCII mix', 'Prüft Änderungen \u2028 \u{1F600}'],
];

const BASIC_STRING =
  /^"(?:[^"\\\u0000-\u001F\u007F]|\\(?:[btnfr"\\]|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}))*"$/;
const lineOf = (toml: string, key: string) =>
  toml.split('\n').find((l) => l.startsWith(`${key} = `)) ?? '';

const frontmatterOf = (md: string) => md.split('\n---\n')[0]!;
const YAML_FORBIDDEN = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u2028\u2029\uFFFE\uFFFF]/;
const TOML_BODY_FORBIDDEN = /[\u0000-\u0008\u000B-\u001F\u007F]/;
const tomlInstructions = (toml: string) => {
  const open = toml.indexOf('"""\n');
  const close = toml.lastIndexOf('\n"""');
  return toml.slice(open + 4, close);
};

describe('the Codex TOML renders every description losslessly', () => {
  for (const [label, description] of CASES) {
    it(`renders ${label} as TOML a parser reads back`, () => {
      const toml = render(description, TOML_TARGET);
      expect(lineOf(toml, 'name').slice('name = '.length)).toMatch(BASIC_STRING);
      expect(lineOf(toml, 'description').slice('description = '.length)).toMatch(BASIC_STRING);
      for (const target of [CLAUDE_TARGET, GEMINI_TARGET]) {
        expect(frontmatterOf(render(description, target))).not.toMatch(YAML_FORBIDDEN);
      }
      const instructions = tomlInstructions(toml);
      expect(instructions).not.toMatch(TOML_BODY_FORBIDDEN);
      expect(instructions).not.toContain('"""');
      const parsed = parseFlatToml(toml);
      expect(parsed.name).toBe('probe');
      expect(parsed.description).toBe(description);
      expect(parsed.developer_instructions).toBe(bodyOf(render(description, GEMINI_TARGET)) + '\n');
    });
  }
});

const python = spawnSync('python3', ['-I', '-c', 'import tomllib'], { timeout: 5000 });
describe.skipIf(python.status !== 0)('Python tomllib reads every rendered Codex file', () => {
  it('accepts each file and returns the same name, description and instructions', () => {
    const rows = CASES.map(([label, description]) => {
      const toml = render(description, TOML_TARGET);
      return {
        label,
        toml,
        name: 'probe',
        description,
        instructions: bodyOf(render(description, GEMINI_TARGET)) + '\n',
      };
    });
    const script = [
      'import json, sys, tomllib',
      'bad = []',
      'for r in json.load(sys.stdin):',
      '    try:',
      '        d = tomllib.loads(r["toml"])',
      '        ok = d["name"] == r["name"] and d["description"] == r["description"] and d["developer_instructions"] == r["instructions"]',
      '    except Exception as e:',
      '        ok = False',
      '    if not ok: bad.append(r["label"])',
      'print(json.dumps(bad))',
    ].join('\n');
    const run = spawnSync('python3', ['-I', '-c', script], {
      input: JSON.stringify(rows),
      timeout: 15000,
      encoding: 'utf8',
    });
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual([]);
  });
});

describe('parseFlatToml decodes the TOML 1.0 escape set', () => {
  const ESCAPED = String.raw`a\bb\tc\nd\fe\rf\"g\\h\u0041\U0001F600`;
  const DECODED = 'a\bb\tc\nd\fe\rf"g\\hA\u{1F600}';

  it('decodes every escape in a basic string', () => {
    expect(parseFlatToml(`description = "${ESCAPED}"\n`).description).toBe(DECODED);
  });

  it('decodes every escape in a multi-line string', () => {
    const toml = `developer_instructions = """\nfirst ${ESCAPED}\n"""\n`;
    expect(parseFlatToml(toml).developer_instructions).toBe(`first ${DECODED}\n`);
  });

  it('keeps the character after the backslash for a malformed or non-scalar \\u', () => {
    expect(parseFlatToml(String.raw`description = "x\u12G4y"` + '\n').description).toBe('xu12G4y');
    expect(parseFlatToml(String.raw`description = "x\uD800y"` + '\n').description).toBe('xuD800y');
    expect(parseFlatToml(String.raw`description = "x\U00110000y"` + '\n').description).toBe(
      'xU00110000y',
    );
    expect(
      parseFlatToml('developer_instructions = """\nx\\u12G4y\n"""\n').developer_instructions,
    ).toBe('xu12G4y\n');
  });
});

describe('the description sentence keeps or lowers its first character', () => {
  const sentence = (d: string) => `You are the **Probe**, a specialized agent that ${d}`;
  const WANTED: [string, string][] = [
    ['API gateway', 'API gateway'],
    ['HTTP client', 'HTTP client'],
    ['GitHub Actions runner', 'GitHub Actions runner'],
    ['S3 bucket auditor', 'S3 bucket auditor'],
    ['Q&A reviewer', 'Q&A reviewer'],
    ['Builds the app', 'builds the app'],
    ['A reviewer', 'a reviewer'],
    ['Handles things', 'handles things'],
    ['Builds API gateways', 'builds API gateways'],
    ['Über reviewer', 'über reviewer'],
    ['ΑΒΓ reviewer', 'ΑΒΓ reviewer'],
    ['日本語 reviewer', '日本語 reviewer'],
    ['3D renderer', '3D renderer'],
    ['\u{10400}bc', '\u{10400}bc'],
  ];
  for (const [description, expected] of WANTED) {
    it(`renders "${description}" as "${expected}" in every format`, () => {
      const outputs = [
        render(description, CLAUDE_TARGET),
        render(description, GEMINI_TARGET),
        parseFlatToml(render(description, TOML_TARGET)).developer_instructions ?? '',
      ];
      for (const output of outputs) {
        expect(output.split('\n')).toContain(sentence(expected));
      }
    });
  }
});
