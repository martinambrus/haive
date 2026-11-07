import type { Context } from 'hono';
import { BUILT_IN_PRIVATE_ORIGINS, IN_STACK_OLLAMA_HOSTS } from '@haive/shared';
import type { AppEnv } from '../context.js';
import { egressFor } from './probe-egress.js';

export async function probeEgressFor(c: Context<AppEnv>): Promise<ReturnType<typeof egressFor>> {
  return egressFor(c.get('userRole'), IN_STACK_OLLAMA_HOSTS, BUILT_IN_PRIVATE_ORIGINS);
}
