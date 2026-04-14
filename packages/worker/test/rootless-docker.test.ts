import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');

async function readRepoFile(relPath: string): Promise<string> {
  return readFile(path.join(repoRoot, relPath), 'utf8');
}

describe('rootless docker support', () => {
  it('parameterizes the worker docker socket via DOCKER_SOCKET', async () => {
    const compose = await readRepoFile('docker-compose.yml');
    expect(compose).toMatch(
      /\$\{DOCKER_SOCKET:-\/var\/run\/docker\.sock\}:\/var\/run\/docker\.sock/,
    );
  });

  it('sets DOCKER_HOST inside the worker container to the fixed mount path', async () => {
    const compose = await readRepoFile('docker-compose.yml');
    expect(compose).toMatch(/DOCKER_HOST:\s*unix:\/\/\/var\/run\/docker\.sock/);
  });

  it('documents the rootless socket override in .env.example', async () => {
    const env = await readRepoFile('.env.example');
    expect(env).toMatch(/DOCKER_SOCKET=/);
    expect(env).toMatch(/rootless/i);
  });

  it('documents the rootless setup walkthrough in README.md', async () => {
    const readme = await readRepoFile('README.md');
    expect(readme).toMatch(/Rootless Docker/);
    expect(readme).toMatch(/DOCKER_SOCKET=\/run\/user\//);
    expect(readme).toMatch(/dockerd-rootless-setuptool\.sh/);
  });
});
