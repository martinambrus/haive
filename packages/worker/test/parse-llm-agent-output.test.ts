import { describe, expect, it } from 'vitest';
import { parseLlmAgentOutput } from '../src/step-engine/steps/onboarding/06_5-agent-discovery.js';

describe('parseLlmAgentOutput', () => {
  it('parses a simple single-block fenced JSON', () => {
    const raw = '```json\n{"predefined":{"code-reviewer":true},"custom":[]}\n```';
    const out = parseLlmAgentOutput(raw);
    expect(out?.predefined['code-reviewer']).toBe(true);
    expect(out?.custom).toEqual([]);
  });

  it('parses JSON whose string values contain embedded triple backticks', () => {
    const raw = [
      '```json',
      '{',
      '  "predefined": { "code-reviewer": true, "migration-author": false },',
      '  "custom": [',
      '    {',
      '      "id": "pty",',
      '      "label": "pty",',
      '      "hint": "h",',
      '      "recommended": true,',
      '      "body": {',
      '        "title": "PTY",',
      '        "description": "d",',
      '        "outputFormat": "```\\n## Block\\n- Scripts: x\\n```"',
      '      }',
      '    }',
      '  ]',
      '}',
      '```',
    ].join('\n');
    const out = parseLlmAgentOutput(raw);
    expect(out).not.toBeNull();
    expect(out!.predefined['migration-author']).toBe(false);
    expect(out!.custom).toHaveLength(1);
    expect(out!.custom[0]!.id).toBe('pty');
  });

  it('returns null when no fenced block is present', () => {
    expect(parseLlmAgentOutput('just a plain sentence, no fence')).toBeNull();
  });

  it('returns null when fenced content is not valid JSON under either strategy', () => {
    const raw = '```json\n{"predefined": not-json-here```\nmore garbage\n```';
    expect(parseLlmAgentOutput(raw)).toBeNull();
  });

  it('normalises missing predefined/custom to empty defaults', () => {
    const raw = '```json\n{}\n```';
    const out = parseLlmAgentOutput(raw);
    expect(out).toEqual({ predefined: {}, custom: [] });
  });
});
