import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SMOKE_STORAGE_ROOT = mkdtempSync(path.join(os.tmpdir(), 'haive-smoke-storage-'));

process.env.REPO_STORAGE_ROOT = SMOKE_STORAGE_ROOT;
