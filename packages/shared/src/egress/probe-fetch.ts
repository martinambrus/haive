import { BUILT_IN_PRIVATE_ORIGINS, IN_STACK_OLLAMA_HOSTS } from '../constants/index.js';
import { createGuardedFetch } from './probe-egress.js';

/** Shared probe policy: the admin allowlist plus Haive's built-in Ollama targets. */
export const guardedProbeFetch = createGuardedFetch({
  allowHosts: IN_STACK_OLLAMA_HOSTS,
  allowOrigins: BUILT_IN_PRIVATE_ORIGINS,
}) as typeof fetch;
