import { createRedisConnection, logger } from '@haive/shared';
import { MODULE_ACTIVATED_CHANNEL } from '@haive/shared/modularity';

const log = logger.child({ module: 'module-activation-watch' });

export function startModuleActivationWatch(onActivated: (moduleId: string) => void): () => void {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return () => {};
  const sub = createRedisConnection(redisUrl);
  sub.on('message', (_channel: string, message: string) => {
    onActivated(message);
  });
  sub.subscribe(MODULE_ACTIVATED_CHANNEL).catch((err: unknown) => {
    log.warn({ err }, 'module activation watch subscribe failed');
  });
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    void sub.quit().catch(() => {});
  };
}
