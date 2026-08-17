import { describe, expect, it } from 'vitest';
// @ts-expect-error - plain .mjs sidecar source, no types
import { hoistSystemMessages } from '../../../docker/openrouter-compat-proxy/hoist.mjs';

function run(payload: unknown): Record<string, unknown> {
  const out = hoistSystemMessages(Buffer.from(JSON.stringify(payload)));
  return JSON.parse(out.toString('utf8'));
}

function unchanged(payload: unknown): boolean {
  const raw = Buffer.from(JSON.stringify(payload));
  return hoistSystemMessages(raw).toString('utf8') === raw.toString('utf8');
}

describe('hoistSystemMessages', () => {
  it('moves the trailing system message into the top-level system field', () => {
    // The exact shape the claude binary sends, and the reason this proxy exists:
    // vLLM-style OpenRouter backends answer 400 "System message must be at the
    // beginning." when that message stays in position.
    const out = run({
      model: 'qwen/qwen3.8-27b',
      system: [{ type: 'text', text: 'You are a Claude agent.' }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'say PONG' }] },
        { role: 'system', content: [{ type: 'text', text: 'Available agent types...' }] },
      ],
    });
    expect(out.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'say PONG' }] }]);
    expect(out.system).toEqual([
      { type: 'text', text: 'You are a Claude agent.' },
      { type: 'text', text: 'Available agent types...' },
    ]);
  });

  it('preserves order when several system messages are hoisted', () => {
    const out = run({
      system: [{ type: 'text', text: 'first' }],
      messages: [
        { role: 'system', content: 'second' },
        { role: 'user', content: 'hi' },
        { role: 'system', content: 'third' },
      ],
    });
    expect((out.system as { text: string }[]).map((b) => b.text)).toEqual([
      'first',
      'second',
      'third',
    ]);
    expect(out.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('accepts a string top-level system and normalizes it to blocks', () => {
    const out = run({
      system: 'plain string system',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'system', content: 'moved' },
      ],
    });
    expect(out.system).toEqual([
      { type: 'text', text: 'plain string system' },
      { type: 'text', text: 'moved' },
    ]);
  });

  it('creates the system field when the request had none', () => {
    const out = run({
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'system', content: 'moved' },
      ],
    });
    expect(out.system).toEqual([{ type: 'text', text: 'moved' }]);
  });

  it('is a NO-OP when there is no in-array system message', () => {
    // This is what makes it safe in front of ALL OpenRouter traffic, including the
    // models that already work.
    expect(
      unchanged({
        system: 'x',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'there' },
        ],
      }),
    ).toBe(true);
  });

  it('leaves non-text blocks behind rather than mangling them', () => {
    const out = run({
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'system',
          content: [
            { type: 'text', text: 'keep' },
            { type: 'image', source: { data: 'x' } },
          ],
        },
      ],
    });
    expect(out.system).toEqual([{ type: 'text', text: 'keep' }]);
  });

  it('forwards unchanged when the body is not JSON', () => {
    const raw = Buffer.from('not json at all');
    expect(hoistSystemMessages(raw).toString('utf8')).toBe('not json at all');
  });

  it('forwards unchanged when there is no messages array', () => {
    expect(unchanged({ model: 'x', system: 'y' })).toBe(true);
    expect(unchanged({ messages: 'not-an-array' })).toBe(true);
  });

  it('refuses to empty the messages array', () => {
    // A request with nothing but system messages would become invalid; leave it
    // alone and let upstream answer for itself.
    expect(unchanged({ messages: [{ role: 'system', content: 'only' }] })).toBe(true);
  });

  it('does not disturb the rest of the payload', () => {
    const out = run({
      model: 'qwen/qwen3.8-27b',
      max_tokens: 32000,
      tools: [{ name: 'Read' }],
      output_config: { effort: 'xhigh' },
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'system', content: 'moved' },
      ],
    });
    expect(out.model).toBe('qwen/qwen3.8-27b');
    expect(out.max_tokens).toBe(32000);
    expect(out.tools).toEqual([{ name: 'Read' }]);
    expect(out.output_config).toEqual({ effort: 'xhigh' });
  });
});
