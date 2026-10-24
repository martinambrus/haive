import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startGitHttpServer } from './git-http-fixture.js';

export const fixtureBase = mkdtempSync(path.join(tmpdir(), 'haive-smoke-http-'));
const fixture = await startGitHttpServer(fixtureBase);
export const { httpOrigin, networkGitArgs } = fixture;
process.once('exit', () => {
  void fixture.close();
  rmSync(fixtureBase, { recursive: true, force: true });
});
