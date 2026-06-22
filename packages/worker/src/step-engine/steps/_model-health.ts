import { configService, CONFIG_KEYS } from '@haive/shared';
import type { StepContext, StepDefinition } from '../step-definition.js';
import { extractFencedJson } from './_fenced-json.js';

// Model-health canary (00-model-health). A tiny first step that makes ONE cheap CLI
// call and verifies the configured model can do the bare minimum every later step
// relies on: emit valid JSON inside a ```json fence and follow a trivial instruction.
// A dead/chat-only model (e.g. answers "How can I help you today?") or a non-
// instruction-following one fails here LOUDLY — with its raw output shown — instead
// of every downstream step silently degrading to a deterministic stub. Runs for all
// providers; disabled globally via CONFIG_KEYS.MODEL_HEALTH_CHECK_ENABLED.

/** Stable token the model must echo back. No randomness needed: the probe is
 *  strictly easier than any real step (the answer is shown in the prompt), so a
 *  usable model always passes and a model that fails cannot run the workflow. */
const CANARY_TOKEN = 'HAIVE_CANARY_OK';

const PROMPT = [
  'You are a connectivity and capability probe for an automated workflow. Do NOT greet,',
  'explain, apologise, or ask questions.',
  'Reply with EXACTLY one JSON object inside a ```json fenced code block, and nothing else:',
  '```json',
  `{"status":"ok","echo":"${CANARY_TOKEN}"}`,
  '```',
].join('\n');

/** The output a healthy model returns; reused as the test-bypass stub so
 *  HAIVE_TEST_BYPASS_LLM smoke runs exercise the full step without a real CLI. */
const HEALTHY_OUTPUT = `\`\`\`json\n{"status":"ok","echo":"${CANARY_TOKEN}"}\n\`\`\``;

/** Trim to the last 800 chars so the failure message shows what the model actually
 *  said without dumping a huge transcript. */
function tail(raw: string): string {
  const t = raw.trim();
  return t.length > 800 ? `…${t.slice(-800)}` : t;
}

/**
 * Throw when the raw model output is not the expected health-check sentinel.
 * Distinguishes the failure modes (empty / no fenced JSON / unparseable JSON /
 * instruction ignored) and embeds the raw output so the user can see the problem
 * (e.g. a chat greeting). Lenient on cosmetics — case-insensitive status, echo as
 * a substring, surrounding prose tolerated — so a capable model never false-fails.
 * Deliberately NOT jsonrepair-tolerant: emitting clean JSON for this trivial case
 * is the minimum bar, so a malformed payload is a real failure.
 */
export function validateCanary(raw: unknown): void {
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
    throw new Error(
      'Model health check failed: the model returned an empty response. It cannot run this ' +
        'workflow — pick a more capable model or provider.',
    );
  }

  let parsed: unknown;
  if (typeof raw === 'string') {
    const body = extractFencedJson(raw);
    if (!body) {
      throw new Error(
        'Model health check failed: the model did not return a JSON object in a ```json fenced ' +
          'block — it likely ignored the instructions (e.g. replied conversationally). It cannot ' +
          `run this workflow.\n\nModel output:\n${tail(raw)}`,
      );
    }
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      throw new Error(
        'Model health check failed: the model emitted a fenced block but its JSON did not parse ' +
          `(${(err as Error).message}). It cannot reliably run this workflow.\n\nModel output:\n${tail(raw)}`,
      );
    }
  } else {
    parsed = raw;
  }

  const obj = parsed as Record<string, unknown> | null;
  const statusOk = typeof obj?.status === 'string' && obj.status.trim().toLowerCase() === 'ok';
  const echoOk = typeof obj?.echo === 'string' && obj.echo.includes(CANARY_TOKEN);
  if (!statusOk || !echoOk) {
    const shown = typeof raw === 'string' ? raw : JSON.stringify(raw);
    throw new Error(
      'Model health check failed: the model returned JSON but did not follow the instruction to ' +
        'echo the health-check token, so it is not reliably instruction-following. It may not ' +
        `complete this workflow correctly.\n\nModel output:\n${tail(shown)}`,
    );
  }
}

/** Build the canary step for a given pipeline (`workflowType`). One definition is
 *  registered per pipeline (onboarding + workflow) because StepDefinition carries a
 *  single workflowType. */
export function makeModelHealthStep(workflowType: string): StepDefinition<null, { ok: true }> {
  return {
    metadata: {
      // Globally-unique per pipeline: the registry keys steps by id alone and one
      // shared singleton holds both pipelines, so onboarding and workflow each need
      // their own id (they are otherwise identical).
      id: `00-model-health-${workflowType}`,
      workflowType,
      index: 0,
      title: 'Model health check',
      description:
        'Verifies the selected AI model can return valid JSON and follow instructions before the ' +
        'workflow relies on it. Fails fast with the model output when the model is unusable.',
      requiresCli: true,
      requiredCapabilities: [],
    },

    async shouldRun(ctx: StepContext): Promise<boolean> {
      // No model configured for the task → nothing to health-check; skip and let any
      // downstream step that genuinely needs a CLI fail on its own terms.
      if (!ctx.cliProviderId) return false;
      try {
        return await configService.getBoolean(CONFIG_KEYS.MODEL_HEALTH_CHECK_ENABLED, true);
      } catch {
        // Config store unavailable → run the safety check by default.
        return true;
      }
    },

    llm: {
      requiredCapabilities: [],
      timeoutMs: 2 * 60 * 1000,
      buildPrompt: () => PROMPT,
      bypassStub: () => HEALTHY_OUTPUT,
    },

    async apply(_ctx, args): Promise<{ ok: true }> {
      validateCanary(args.llmOutput ?? null);
      return { ok: true };
    },
  };
}
