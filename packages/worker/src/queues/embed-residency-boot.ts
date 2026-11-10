import { logger } from '@haive/shared';
import { listResidentOllamaModels } from '@haive/shared/rag';

// Reconciliation can be invoked again during boot recovery. Warn once per stored URL this boot.
const warnedUrls = new Set<string>();

export async function listResidentModelsOnBoot(url: string): Promise<string[] | null> {
  return listResidentOllamaModels(url, undefined, undefined, () => {
    if (warnedUrls.has(url)) return;
    warnedUrls.add(url);
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return;
    }
    logger.warn(
      { host },
      'boot embed-model residency check refused a private or unresolvable target',
    );
  });
}
