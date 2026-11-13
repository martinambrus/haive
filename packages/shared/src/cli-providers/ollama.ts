import { IN_STACK_OLLAMA_HOSTS, IN_STACK_OLLAMA_URL } from '../constants/index.js';

/** Ollama Cloud models carry a `-cloud` or `:cloud` tag suffix, e.g.
 *  `qwen3-coder:480b-cloud` (tag `480b-cloud`) or `deepseek-v4-pro:cloud`
 *  (tag `cloud`). They run on ollama.com, never the local daemon, so a plain
 *  `endsWith(':cloud')` misses the common `<size>-cloud` form and wrongly routes
 *  them local (the cause of an earlier 401). Shared so the worker (base-URL
 *  routing + boot provisioner) and the API (on-save provision gating) cannot
 *  drift on this subtle suffix check. */
export function isOllamaCloudModel(model: string): boolean {
  return model.endsWith('-cloud') || model.endsWith(':cloud');
}

/** True when a provider's ANTHROPIC_BASE_URL targets the in-stack daemon, so the
 *  worker can provision its model. Cloud (ollama.com) and external remotes are
 *  skipped: the worker neither owns nor should mutate their model store, and
 *  cloud models are not "pulled". */
export function isInStackOllamaBaseUrl(baseUrl: string | undefined): boolean {
  const url = baseUrl ?? IN_STACK_OLLAMA_URL;
  try {
    return IN_STACK_OLLAMA_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}
