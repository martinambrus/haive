import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiCallSpec } from '../src/cli-adapters/types.js';

const anthropicCreate = vi.fn();
const openaiCreate = vi.fn();
const googleGenerate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: anthropicCreate };
  },
}));

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: openaiCreate } };
  },
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent: googleGenerate };
  },
}));

const { callAnthropic, callOpenAI, callGoogleGenAI } =
  await import('../src/queues/cli-exec-queue.js');

function spec(overrides: Partial<ApiCallSpec> = {}): ApiCallSpec {
  return {
    sdkPackage: '@anthropic-ai/sdk',
    defaultModel: 'm',
    apiKeyEnvName: 'KEY',
    prompt: 'hi',
    model: 'm',
    maxOutputTokens: 8192,
    ...overrides,
  };
}

beforeEach(() => {
  anthropicCreate.mockReset();
  openaiCreate.mockReset();
  googleGenerate.mockReset();
});

describe('callAnthropic', () => {
  it('returns exit 0 and parsed text on a normal end_turn response', async () => {
    anthropicCreate.mockResolvedValue({
      content: [{ type: 'text', text: '{"ok":true}' }],
      stop_reason: 'end_turn',
    });
    const result = await callAnthropic(spec(), 'k');
    expect(result.exitCode).toBe(0);
    expect(result.rawOutput).toBe('{"ok":true}');
    expect(result.parsedOutput).toEqual({ ok: true });
    expect(result.errorMessage).toBeNull();
  });

  it('returns exit 1 with truncation error when stop_reason is max_tokens', async () => {
    anthropicCreate.mockResolvedValue({
      content: [{ type: 'text', text: '```json\n{"entries":[' }],
      stop_reason: 'max_tokens',
    });
    const result = await callAnthropic(spec({ maxOutputTokens: 8192 }), 'k');
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain('max_tokens');
    expect(result.errorMessage).toContain('8192');
    expect(result.rawOutput).toContain('```json');
  });

  it('returns exit 1 on SDK throw', async () => {
    anthropicCreate.mockRejectedValue(new Error('rate limited'));
    const result = await callAnthropic(spec(), 'k');
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain('rate limited');
  });
});

describe('callOpenAI', () => {
  it('returns exit 0 on finish_reason=stop', async () => {
    openaiCreate.mockResolvedValue({
      choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
    });
    const result = await callOpenAI(spec({ sdkPackage: 'openai' }), 'k');
    expect(result.exitCode).toBe(0);
    expect(result.rawOutput).toBe('hello');
  });

  it('returns exit 1 with truncation error when finish_reason is length', async () => {
    openaiCreate.mockResolvedValue({
      choices: [{ message: { content: 'truncated' }, finish_reason: 'length' }],
    });
    const result = await callOpenAI(spec({ sdkPackage: 'openai', maxOutputTokens: 4096 }), 'k');
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain('max_tokens');
    expect(result.errorMessage).toContain('4096');
    expect(result.rawOutput).toBe('truncated');
  });
});

describe('callGoogleGenAI', () => {
  it('returns exit 0 on finishReason=STOP', async () => {
    googleGenerate.mockResolvedValue({
      text: 'ok',
      candidates: [{ finishReason: 'STOP' }],
    });
    const result = await callGoogleGenAI(spec({ sdkPackage: '@google/genai' }), 'k');
    expect(result.exitCode).toBe(0);
    expect(result.rawOutput).toBe('ok');
  });

  it('returns exit 1 with truncation error when finishReason is MAX_TOKENS', async () => {
    googleGenerate.mockResolvedValue({
      text: 'partial',
      candidates: [{ finishReason: 'MAX_TOKENS' }],
    });
    const result = await callGoogleGenAI(spec({ sdkPackage: '@google/genai' }), 'k');
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain('MAX_TOKENS');
    expect(result.rawOutput).toBe('partial');
  });
});
