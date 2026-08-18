import { describe, expect, it } from 'vitest';
import {
  buildModelIdentity,
  classifyModelMatch,
  isPlaceholderModel,
  parseAntigravityModelLabel,
  requestedFromSpec,
} from '../src/queues/cli-exec/model-identity.js';

// Every fixture here is a real string MEASURED off a live CLI on 2026-08-18 (via
// test/model-report-discover.ts) or pulled from a recorded cli_invocations.stream_log
// row — not invented. That matters: the whole feature exists because what these CLIs
// actually emit differs from what their docs imply.

describe('isPlaceholderModel', () => {
  it('rejects the CLI-generated <synthetic> sentinel', () => {
    // Measured on an OpenRouter 402 run: claude-code emits an assistant event with
    // model "<synthetic>" and zero usage when it authors the message itself.
    expect(isPlaceholderModel('<synthetic>')).toBe(true);
  });

  it('rejects any other bracketed sentinel, not just the one word', () => {
    expect(isPlaceholderModel('<unknown>')).toBe(true);
  });

  it('accepts real model ids, including ones with punctuation', () => {
    for (const id of ['claude-sonnet-4-6', 'glm-5.2[1m]', 'deepseek/deepseek-v4-pro-0813']) {
      expect(isPlaceholderModel(id)).toBe(false);
    }
  });
});

describe('parseAntigravityModelLabel', () => {
  const REAL_LINE =
    'ERROR: logging before google.Init: I0818 06:29:09.374366       1 model_config_manager.go:311] ' +
    'Propagating selected model override to backend: label="Gemini 3.7 Flash (High)"';

  it('extracts the label from the real agy log line', () => {
    expect(parseAntigravityModelLabel(REAL_LINE)).toBe('Gemini 3.7 Flash (High)');
  });

  it('finds it inside a full multi-line log', () => {
    const log = ['some unrelated line', REAL_LINE, 'Language server shutting down'].join('\n');
    expect(parseAntigravityModelLabel(log)).toBe('Gemini 3.7 Flash (High)');
  });

  it('returns null (never throws) when upstream rewords the line', () => {
    // The line is volatile Go log prose. A reword must degrade to "no served
    // model" — the same honest outcome as codex — not crash the invocation.
    expect(parseAntigravityModelLabel('Now using model: Gemini 3.7 Flash')).toBeNull();
    expect(parseAntigravityModelLabel('')).toBeNull();
    expect(parseAntigravityModelLabel(null)).toBeNull();
  });
});

describe('requestedFromSpec', () => {
  it('reads codex’s --model flag, which is its only model signal', () => {
    // Measured: codex exec --json names no model anywhere in its event stream, so
    // the executed command is the only remaining evidence.
    const spec = { args: ['--model', 'gpt-5.6-sol', 'exec', '--json'], env: {} };
    expect(requestedFromSpec(spec)).toBe('gpt-5.6-sol');
  });

  it('ignores a --model with no value', () => {
    expect(requestedFromSpec({ args: ['exec', '--model'], env: {} })).toBeNull();
    expect(requestedFromSpec({ args: ['--model', '--json'], env: {} })).toBeNull();
  });

  it('falls back to an explicit ANTHROPIC_MODEL', () => {
    expect(requestedFromSpec({ args: [], env: { ANTHROPIC_MODEL: 'glm-4.6' } })).toBe('glm-4.6');
  });

  it('does NOT guess from the ANTHROPIC_DEFAULT_* tier triple', () => {
    // zai sets all three to different values; which one applies depends on the tier
    // the binary picks at runtime, so guessing records a model never asked for.
    const spec = {
      args: [],
      env: {
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.2[1m]',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2[1m]',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.7',
      },
    };
    expect(requestedFromSpec(spec)).toBeNull();
  });

  it('returns null for amp, which takes no model argument at all', () => {
    expect(
      requestedFromSpec({ args: ['--dangerously-allow-all', '-x', 'hi'], env: {} }),
    ).toBeNull();
  });
});

describe('classifyModelMatch', () => {
  it('flags the measured Z.AI swap as differs', () => {
    // The case the feature exists for: asked glm-5.2[1m], served glm-5.3.
    expect(classifyModelMatch('glm-5.2[1m]', 'glm-5.3')).toBe('differs');
  });

  it('forgives an endpoint dropping a trailing variant tag', () => {
    // Measured: zai asks for glm-5.3[1m] and is served glm-5.3. Same model, tag not
    // echoed — warning on it every single run was noise nobody could act on.
    expect(classifyModelMatch('glm-5.3[1m]', 'glm-5.3')).toBe('exact');
    // Symmetric: forgiveness is about the tag's PRESENCE, not which side carries it.
    expect(classifyModelMatch('glm-5.3', 'glm-5.3[1m]')).toBe('exact');
  });

  it('still flags a version change that also drops the tag', () => {
    // The rule must not degrade into "strip tags, then compare": this is a real swap.
    expect(classifyModelMatch('glm-5.2[1m]', 'glm-5.3')).toBe('differs');
    expect(classifyModelMatch('glm-5.2[1m]', 'glm-5.2')).toBe('exact');
  });

  it('flags two DIFFERENT variant tags', () => {
    // Being handed a different context variant is a real difference, not cosmetic —
    // which is why the rule keys on tag presence rather than tag-stripped equality.
    expect(classifyModelMatch('glm-5.3[1m]', 'glm-5.3[200k]')).toBe('differs');
  });

  it('leaves non-bracket variant markers alone', () => {
    // ollama marks variants with a colon; nothing here may touch that.
    expect(classifyModelMatch('glm-5.2:cloud', 'glm-5.2')).toBe('differs');
  });

  it('strips at most one trailing tag and never eats the base', () => {
    // Only the final bracket group is ever a candidate, so a doubly-tagged id cannot
    // collapse onto a bare base. 'differs' is the conservative verdict for an exotic
    // shape nothing in the measured set produces.
    expect(classifyModelMatch('model[a][b]', 'model[a]')).toBe('differs');
    expect(classifyModelMatch('model[a][b]', 'model')).toBe('differs');
    // A tagged id compared with itself is still exact, tag and all.
    expect(classifyModelMatch('glm-5.3[1m]', 'glm-5.3[1m]')).toBe('exact');
  });

  it('reports exact when the endpoint echoes what was asked', () => {
    expect(classifyModelMatch('claude-sonnet-4-6', 'claude-sonnet-4-6')).toBe('exact');
  });

  it('is unknown whenever either side is missing', () => {
    expect(classifyModelMatch('gpt-5.6-sol', null)).toBe('unknown');
    expect(classifyModelMatch(null, 'grok-4.6')).toBe('unknown');
    expect(classifyModelMatch(null, null)).toBe('unknown');
  });
});

describe('buildModelIdentity', () => {
  it('records the Z.AI mismatch from its stream', () => {
    const id = buildModelIdentity({
      stream: { requested: 'glm-5.2[1m]', served: 'glm-5.3', billed: ['glm-5.2[1m]'] },
    })!;
    expect(id).toMatchObject({
      requested: 'glm-5.2[1m]',
      served: 'glm-5.3',
      source: 'stream-json',
      match: 'differs',
    });
  });

  it('keeps claude-code’s side model in billed, out of served', () => {
    // The haiku key is claude-code billing its own session-title call. Treating it
    // as the answering model would report the wrong model for every run.
    const id = buildModelIdentity({
      stream: {
        requested: 'claude-sonnet-4-6',
        served: 'claude-sonnet-4-6',
        billed: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6'],
      },
    })!;
    expect(id.served).toBe('claude-sonnet-4-6');
    expect(id.match).toBe('exact');
    expect(id.billed).toContain('claude-haiku-4-5-20251001');
  });

  it('does not let grok’s billing name become the served model', () => {
    // Measured: grok serves `grok-4.6` but bills usage under `grok-4.6-build`.
    const id = buildModelIdentity({
      stream: { requested: 'grok-4.6', served: 'grok-4.6', billed: ['grok-4.6-build'] },
    })!;
    expect(id.served).toBe('grok-4.6');
    expect(id.match).toBe('exact');
  });

  it('falls back to the spec for codex, which reports no model', () => {
    const id = buildModelIdentity({ stream: null, specRequested: 'gpt-5.6-sol' })!;
    expect(id).toMatchObject({
      requested: 'gpt-5.6-sol',
      served: null,
      source: 'provider-config',
      match: 'unknown',
    });
  });

  it('takes gemini’s first stats.models key as served and keeps every key billed', () => {
    const id = buildModelIdentity({ geminiModels: ['gemini-2.5-pro', 'gemini-2.5-flash'] })!;
    expect(id.served).toBe('gemini-2.5-pro');
    expect(id.source).toBe('gemini-stats');
    expect(id.billed).toEqual(['gemini-2.5-pro', 'gemini-2.5-flash']);
  });

  it('uses the antigravity log label when nothing else names a model', () => {
    const id = buildModelIdentity({
      antigravityLog:
        'model_config_manager.go:311] Propagating selected model override to backend: label="Gemini 3.7 Flash (High)"',
    })!;
    expect(id).toMatchObject({ served: 'Gemini 3.7 Flash (High)', source: 'antigravity-log' });
  });

  it('returns null when no channel said anything (amp)', () => {
    // amp names no model and takes no model flag. Storing a row of nulls would
    // imply we looked and found nothing, rather than that this path reports nothing.
    expect(buildModelIdentity({ stream: null, specRequested: null })).toBeNull();
  });

  it('still records requested when the run died before any assistant turn', () => {
    const id = buildModelIdentity({
      stream: { requested: 'qwen/qwen3.8-27b', served: null, billed: [] },
    })!;
    expect(id).toMatchObject({ requested: 'qwen/qwen3.8-27b', served: null, match: 'unknown' });
  });
});
