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
