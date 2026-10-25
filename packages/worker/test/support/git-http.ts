import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';
import { startGitHttpServer } from './git-http-fixture.js';

export const fixtureBase = await mkdtemp(path.join(tmpdir(), 'haive-git-http-'));
const fixture = await startGitHttpServer(fixtureBase);
export const { httpOrigin, networkGitArgs } = fixture;
afterAll(async () => {
  await fixture.close();
  await rm(fixtureBase, { recursive: true, force: true, maxRetries: 5 });
});
