import { join } from 'node:path';
import type { TestInfo } from '@playwright/test';

/** The setup and teardown projects share the default output directory, emptied once per run. */
export function warmupRecordPath(info: TestInfo): string {
  return join(info.project.outputDir, 'sandbox-warmup.json');
}
