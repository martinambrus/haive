import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../src/cli-adapters/claude-code.js';
import { CodexAdapter, codexExecFallbackSpec } from '../src/cli-adapters/codex.js';
import { PROMPT_ARGV_LIMIT_BYTES } from '../src/cli-adapters/prompt-delivery.js';
import type { CliProviderRecord } from '../src/cli-adapters/types.js';

const PLAN = 'docs/plans/message-threads-bandwidth.md';
const provider = (over: Partial<CliProviderRecord> = {}): CliProviderRecord =>
  ({
    wrapperPath: null,
    executablePath: null,
    cliArgs: null,
    envVars: null,
    effortLevel: null,
    model: null,
    ...over,
  }) as CliProviderRecord;

// Check the public builders' output, including split and joined flag values, rather than
// reaching into execBaseArgs or copying its implementation. Other config overrides (effort,
// bundled skills and multi-agent) remain valid; transport selection belongs to the binary.
function expectBinaryOwnedTransport(args: string[]): void {
  expect(args.join('\n'), `${PLAN}: Codex must not override its incremental transport`).not.toMatch(
    /responses_websockets|wire_api|transport|(?:supports|prefer)_websockets/i,
  );
}

describe('Claude Code binary-owned message threads', () => {
  for (const steeringMode of [false, true]) {
    describe(steeringMode ? 'steering delivery' : 'ordinary delivery', () => {
      it.each([null, {}])('adds no transport environment overrides with envVars=%j', (envVars) => {
        const { env } = new ClaudeCodeAdapter().buildCliInvocation(provider({ envVars }), 'do x', {
          steeringMode,
        });
        expect(env, `${PLAN}: a base URL override can disable message threads`).not.toHaveProperty(
          'ANTHROPIC_BASE_URL',
        );
        expect(env, `${PLAN}: experimental betas must remain binary-owned`).not.toHaveProperty(
          'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
        );
        expect(
          Object.keys(env).filter((key) => key.startsWith('CLAUDE_CODE_TETHER_')),
          `${PLAN}: volatile CLAUDE_CODE_TETHER_* settings belong only in provider envVars`,
        ).toEqual([]);
      });

      it.each(['0', '1'])('preserves operator envVars, including TETHER_LIVE=%s', (live) => {
        const envVars = {
          ANTHROPIC_BASE_URL: 'https://operator.example',
          CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
          CLAUDE_CODE_TETHER_LIVE: live,
          OPERATOR_SETTING: 'kept',
        };
        const { env } = new ClaudeCodeAdapter().buildCliInvocation(provider({ envVars }), 'do x', {
          steeringMode,
        });
        expect(env, `${PLAN}: explicit provider envVars must still pass through`).toMatchObject(
          envVars,
        );
      });
    });
  }

  it('keeps the measured egress allowlist unchanged', () => {
    expect(
      new ClaudeCodeAdapter().defaultEgressDomains,
      `${PLAN}: no extra egress host is needed`,
    ).toEqual(['api.anthropic.com']);
  });
});

describe('Codex binary-owned Responses WebSockets', () => {
  it.each([
    ['argv', 'do x'],
    ['stdin', 'x'.repeat(PROMPT_ARGV_LIMIT_BYTES + 1)],
  ])('keeps exec transport defaults with %s prompt delivery', (delivery, prompt) => {
    const spec = new CodexAdapter().buildCliInvocation(provider(), prompt!, {});
    expect(spec.outputFormat, PLAN).toBe('codex-jsonl');
    expect(spec.args[0], PLAN).toBe('exec');
    expect(spec.stdinPrompt, PLAN).toBe(delivery === 'stdin' ? prompt : undefined);
    expectBinaryOwnedTransport(spec.args);
  });

  it('keeps app-server transport defaults', () => {
    const spec = new CodexAdapter().buildCliInvocation(provider(), 'do x', { steeringMode: true });
    expect(spec.outputFormat, PLAN).toBe('codex-app-server');
    expect(spec.args[0], PLAN).toBe('app-server');
    expectBinaryOwnedTransport(spec.args);
  });

  it('keeps transport defaults in the app-server exec fallback', () => {
    const spec = new CodexAdapter().buildCliInvocation(provider(), 'do x', { steeringMode: true });
    const fallback = codexExecFallbackSpec(spec);
    expect(fallback, PLAN).not.toBeNull();
    expect(fallback!.args[0], PLAN).toBe('exec');
    expectBinaryOwnedTransport(fallback!.args);
  });

  it('keeps the measured egress allowlist unchanged', () => {
    expect(
      new CodexAdapter().defaultEgressDomains,
      `${PLAN}: no extra egress host is needed`,
    ).toEqual(['api.openai.com', 'chatgpt.com']);
  });
});
