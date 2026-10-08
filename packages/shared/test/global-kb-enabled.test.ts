import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONFIG_KEYS, ConfigService, configService } from '../src/config/config.service.js';
import { secretsService } from '../src/config/secrets.service.js';
import {
  resolveGlobalKbEnabled,
  resolveGlobalKbSettings,
  resolveHouseRulesEnabled,
} from '../src/global-kb/connection.js';

const configWith = (stored: Record<string, string>): ConfigService => {
  const svc = new ConfigService();
  vi.spyOn(svc, 'get').mockImplementation(async (key) => stored[key] ?? null);
  return svc;
};

afterEach(() => vi.restoreAllMocks());

describe('resolveGlobalKbEnabled', () => {
  it('reads the feature on while its key is absent, as the seed has it', async () => {
    expect(await resolveGlobalKbEnabled(configWith({}))).toBe(true);
  });

  it.each([
    ['true', true],
    ['false', false],
  ])("follows a stored '%s'", async (stored, expected) => {
    const config = configWith({ [CONFIG_KEYS.GLOBAL_KB_ENABLED]: stored });
    expect(await resolveGlobalKbEnabled(config)).toBe(expected);
  });

  it('is not moved by the house-rules switch', async () => {
    const config = configWith({ [CONFIG_KEYS.GLOBAL_KB_HOUSE_RULES_ENABLED]: 'false' });
    expect(await resolveGlobalKbEnabled(config)).toBe(true);
  });
});

describe('resolveHouseRulesEnabled', () => {
  it('reads the switch on while its key is absent', async () => {
    expect(await resolveHouseRulesEnabled(configWith({}))).toBe(true);
  });

  it.each([
    ['true', true],
    ['false', false],
  ])("follows a stored '%s'", async (stored, expected) => {
    const config = configWith({ [CONFIG_KEYS.GLOBAL_KB_HOUSE_RULES_ENABLED]: stored });
    expect(await resolveHouseRulesEnabled(config)).toBe(expected);
  });

  it('is not moved by the global KB switch', async () => {
    const config = configWith({ [CONFIG_KEYS.GLOBAL_KB_ENABLED]: 'false' });
    expect(await resolveHouseRulesEnabled(config)).toBe(true);
  });
});

describe('the house-rules key', () => {
  it('sits beside the digest key and is seeded on', async () => {
    expect(CONFIG_KEYS.GLOBAL_KB_HOUSE_RULES_ENABLED).toBe('config:globalKb:houseRulesEnabled');
    const seeded = new Map<string, string>();
    const svc = new ConfigService() as unknown as { redis: unknown; seedDefaults(): Promise<void> };
    svc.redis = {
      pipeline: () => ({
        setnx: (key: string, value: string) => void seeded.set(key, value),
        exec: async () => [],
      }),
    };
    await svc.seedDefaults();

    expect(seeded.get(CONFIG_KEYS.GLOBAL_KB_HOUSE_RULES_ENABLED)).toBe('true');
    expect(seeded.get(CONFIG_KEYS.GLOBAL_KB_ENABLED)).toBe('true');
  });
});

describe('resolveGlobalKbSettings', () => {
  it.each([
    [null, true],
    ['true', true],
    ['false', false],
  ])('reads a stored %s as enabled: %s', async (stored, expected) => {
    vi.spyOn(configService, 'get').mockImplementation(async (key) =>
      key === CONFIG_KEYS.GLOBAL_KB_ENABLED ? stored : null,
    );
    vi.spyOn(secretsService, 'get').mockResolvedValue(null);

    expect((await resolveGlobalKbSettings()).enabled).toBe(expected);
  });
});

// The readers disagreed on the default of an absent key; one resolver decides it now.
describe('the global KB switch', () => {
  const PACKAGES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const READS_THE_SWITCH = /\.(?:get|getBoolean|getNumber)\(\s*CONFIG_KEYS\.GLOBAL_KB_ENABLED\b/;

  it('is read by exactly one function, which every other reader calls', () => {
    const readers: string[] = [];
    for (const pkg of ['api', 'database', 'shared', 'web', 'worker']) {
      const src = path.join(PACKAGES, pkg, 'src');
      let files: string[];
      try {
        files = readdirSync(src, { recursive: true, encoding: 'utf8' });
      } catch {
        continue;
      }
      for (const file of files) {
        if (!/\.tsx?$/.test(file) || /\.test\.tsx?$/.test(file)) continue;
        if (READS_THE_SWITCH.test(readFileSync(path.join(src, file), 'utf8'))) {
          readers.push(`${pkg}/src/${file}`);
        }
      }
    }

    expect(readers).toEqual(['shared/src/global-kb/connection.ts']);
  });
});
