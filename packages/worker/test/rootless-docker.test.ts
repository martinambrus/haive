import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

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

describe('sandbox models network', () => {
  it('exposes only the filtering gate under the daemon names', async () => {
    const { services, networks } = parse(await readRepoFile('docker-compose.yml'));
    expect(Object.keys(services.ollama.networks)).toEqual(['haive-network']);
    const daemonAliases: string[] = services.ollama.networks['haive-network'].aliases;
    const gateAliases: string[] = services['ollama-gate'].networks['haive-models'].aliases;
    // The gate must dial a name that is the daemon's alone: `ollama` is the gate on haive-models.
    const upstream = services['ollama-gate'].environment.UPSTREAM_HOST;
    expect(daemonAliases).toContain(upstream);
    expect(gateAliases).not.toContain(upstream);
    expect(upstream).not.toBe('ollama');
    expect(services['ollama-gate'].networks).toEqual({
      'haive-network': null,
      'haive-models': { aliases: ['ollama', '${HAIVE_INSTALL_ID:-haive}-ollama'] },
    });
    expect(networks['haive-models'].internal).toBe(true);
  });

  it('ships the gate as a release image without a source build', async () => {
    const compose = parse(await readRepoFile('docker-compose.run.yml'), {
      customTags: [{ tag: '!reset', resolve: () => null }],
    });
    expect(compose.services['ollama-gate']).toEqual({
      build: null,
      image:
        '${HAIVE_REGISTRY:-ghcr.io/martinambrus}/haive-ollama-gate:${HAIVE_VERSION:?set HAIVE_VERSION to the release you want, e.g. 0.2.0}',
    });
  });

  it.each(['dev', 'gpu', 'vulkan'])(
    '%s overlay keeps Ollama off the models network',
    async (overlay) => {
      const compose = parse(await readRepoFile(`docker-compose.${overlay}.yml`));
      expect(compose.services.ollama.networks).toBeUndefined();
    },
  );
});

describe('published sidecars', () => {
  it('publishes every runtime build in both release matrices and tracks its Docker base', async () => {
    const base = parse(await readRepoFile('docker-compose.yml'));
    const overlay = parse(await readRepoFile('docker-compose.run.yml'), {
      customTags: [{ tag: '!reset', resolve: () => null }],
    });
    const release = parse(await readRepoFile('.github/workflows/release.yml'));
    const dependabot = parse(await readRepoFile('.github/dependabot.yml'));
    const directories = dependabot.updates
      .filter((entry: { 'package-ecosystem': string }) => entry['package-ecosystem'] === 'docker')
      .flatMap((entry: { directories: string[] }) => entry.directories);
    for (const [name, service] of Object.entries(base.services) as [
      string,
      { build?: { context: string }; profiles?: string[] },
    ][]) {
      if (!service.build || service.profiles?.length) continue;
      for (const job of ['build', 'merge'])
        expect(release.jobs[job].strategy.matrix.service).toContain(name);
      expect(overlay.services[name].build).toBeNull();
      if (service.build.context.startsWith('./docker/')) {
        expect(overlay.services[name].image).toContain(`/haive-${name}:`);
        expect(directories).toContain(service.build.context.slice(1));
      }
    }
  });
});
