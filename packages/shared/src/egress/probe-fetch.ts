import { BUILT_IN_PRIVATE_ORIGINS, IN_STACK_OLLAMA_HOSTS } from '../constants/index.js';
import { createGuardedFetch } from './probe-egress.js';

/** Shared probe policy: each dial is denied a private, loopback or link-local address
 *  unless the admin allowlist covers it. The in-stack Ollama names and the shipped
 *  external default origin are exempt. */
export const guardedProbeFetch = createGuardedFetch({
  allowHosts: IN_STACK_OLLAMA_HOSTS,
  allowOrigins: BUILT_IN_PRIVATE_ORIGINS,
}) as typeof fetch;
