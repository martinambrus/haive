import { extractFencedJson } from '../_fenced-json.js';

export interface ConfigRecommendation {
  adversarialQaLevel?: string;
  browserMode?: string;
}

/** Parse the gate-1 config-recommendation LLM output (best-effort). Returns {}
 *  when the output is missing or unparseable, so the form falls back to its
 *  static defaults with nothing marked recommended. */
export function parseConfigRecommendation(raw: unknown): ConfigRecommendation {
  let obj: Record<string, unknown> | null = null;
  if (raw && typeof raw === 'object') {
    obj = raw as Record<string, unknown>;
  } else if (typeof raw === 'string') {
    const body = extractFencedJson(raw) ?? raw;
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === 'object') obj = parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  if (!obj) return {};
  const out: ConfigRecommendation = {};
  if (typeof obj.adversarialQaLevel === 'string') out.adversarialQaLevel = obj.adversarialQaLevel;
  if (typeof obj.browserMode === 'string') out.browserMode = obj.browserMode;
  return out;
}

export interface RecOption {
  value: string;
  label: string;
}

/** Tag the recommended option's label with ' (recommended)' and use it as the
 *  default — but ONLY when the recommendation matches an available option (so an
 *  `mcp` recommendation with no DDEV runner is ignored). Otherwise the options
 *  and the fallback default are returned unchanged. */
export function markRecommended(
  options: RecOption[],
  recommended: string | undefined,
  fallbackDefault: string,
): { options: RecOption[]; default: string } {
  if (recommended && options.some((o) => o.value === recommended)) {
    return {
      options: options.map((o) =>
        o.value === recommended ? { ...o, label: `${o.label} (recommended)` } : o,
      ),
      default: recommended,
    };
  }
  return { options, default: fallbackDefault };
}
