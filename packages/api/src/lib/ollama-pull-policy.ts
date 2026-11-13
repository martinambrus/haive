import {
  CONFIG_KEYS,
  configService,
  isOllamaModelAllowed,
  normalizeOllamaModel,
} from '@haive/shared';

export {
  normalizeOllamaModel,
  ollamaModelAllowlistSchema,
  OLLAMA_ALLOWLIST_LIMITS,
} from '@haive/shared';

export async function mayPullOllamaModel(role: string, model: string): Promise<boolean> {
  if (role === 'admin') return true;
  if (!normalizeOllamaModel(model)) return false;
  const policy = {
    embedModel: await configService.get(CONFIG_KEYS.GLOBAL_KB_EMBED_MODEL),
    allowlist: null as string | null,
  };
  if (isOllamaModelAllowed(role, model, policy)) return true;
  policy.allowlist = await configService.get(CONFIG_KEYS.OLLAMA_MODEL_ALLOWLIST);
  return isOllamaModelAllowed(role, model, policy);
}
