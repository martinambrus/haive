import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REGISTERED_USERS_FILE_ENV } from './helpers/auth.js';

/** Starts this run's record of registered accounts; the workers inherit the variable. */
export default function globalSetup(): void {
  const file = path.join(os.tmpdir(), `haive-e2e-users-${process.pid}-${Date.now()}.jsonl`);
  writeFileSync(file, '');
  process.env[REGISTERED_USERS_FILE_ENV] = file;
}
