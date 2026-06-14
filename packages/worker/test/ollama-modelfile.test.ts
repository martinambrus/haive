import { describe, expect, it } from 'vitest';
import { parseModelfile } from '../src/sandbox/ollama-provision.js';

describe('parseModelfile', () => {
  it('parses FROM and coerces a numeric PARAMETER', () => {
    const p = parseModelfile('FROM qwen3-coder:30b\nPARAMETER num_ctx 262144');
    expect(p.from).toBe('qwen3-coder:30b');
    expect(p.parameters.num_ctx).toBe(262144);
  });

  it('captures a multi-line triple-quoted TEMPLATE verbatim (incl. Go-template {{ }})', () => {
    const mf = [
      'FROM gemma',
      'TEMPLATE """{{ if .System }}<sys>{{ .System }}</sys>',
      '{{ end }}{{ .Prompt }}"""',
      'PARAMETER temperature 0.7',
    ].join('\n');
    const p = parseModelfile(mf);
    expect(p.from).toBe('gemma');
    expect(p.template).toContain('<sys>{{ .System }}</sys>');
    expect(p.template).toContain('{{ .Prompt }}');
    expect(p.parameters.temperature).toBe(0.7);
  });

  it('parses single-line SYSTEM and collapses repeated PARAMETER to an array', () => {
    const mf = [
      'FROM base',
      'SYSTEM "You are a careful engineer."',
      'PARAMETER stop "<|im_end|>"',
      'PARAMETER stop "<|endoftext|>"',
    ].join('\n');
    const p = parseModelfile(mf);
    expect(p.system).toBe('You are a careful engineer.');
    expect(p.parameters.stop).toEqual(['<|im_end|>', '<|endoftext|>']);
  });

  it('ignores comments and unsupported directives', () => {
    const mf = ['# a comment', 'FROM base', 'LICENSE "MIT"', 'ADAPTER ./x.gguf'].join('\n');
    const p = parseModelfile(mf);
    expect(p.from).toBe('base');
    expect(p.template).toBeUndefined();
    expect(p.system).toBeUndefined();
    expect(p.parameters).toEqual({});
  });
});
