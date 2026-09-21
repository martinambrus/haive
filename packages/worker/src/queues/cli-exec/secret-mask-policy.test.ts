import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { glob } from 'tinyglobby';
import { secretMaskDeniesPath, secretMaskPolicy } from './secret-mask-policy.js';

/**
 * Paths chosen for the SHAPES they exercise, not for coverage: leading-dot basenames, a dotted
 * directory a `**` has to descend into, a dotted basename a `*.ext` has to match, the brace
 * expansion, a trailing-star glob, a tilde suffix, the settings.php pair, and the structural
 * ignore dirs. node:path's own matchesGlob was MEASURED failing 5 of these.
 */
const FIXTURE_FILES = [
  '.env',
  '.env.local',
  '.env.example',
  'sub/.env',
  '.config/.env',
  'a.pem',
  '.hidden.pem',
  'certs/deep/b.key',
  'id_rsa',
  'my_rsa',
  '.ssh/config',
  '.ssh/nested/thing',
  'known_hosts',
  'k.pub',
  'secrets.yml',
  'x-secret-store.yaml',
  'nope-secret.txt',
  '.cargo/credentials',
  '.cargo/credentials.toml',
  'notes.txt~',
  'db_backup_2026.tar',
  'web/sites/default/settings.php',
  'web/sites/default/default.settings.php',
  'node_modules/pkg/.env',
  '.git/config',
  'dist/.env',
];

async function buildFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'secret-mask-policy-'));
  for (const rel of FIXTURE_FILES) {
    const abs = join(root, rel);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, 'x');
  }
  return root;
}

describe('secretMaskDeniesPath', () => {
  it('returns the same verdict as the tinyglobby scan computeSecretMasks runs', async () => {
    const root = await buildFixture();
    try {
      const policy = secretMaskPolicy({});
      // Exactly the call computeSecretMasks makes.
      const scanned = new Set(
        await glob(policy.globs.deny, {
          cwd: root,
          dot: true,
          ignore: policy.globs.ignore,
          onlyFiles: true,
          expandDirectories: false,
          followSymbolicLinks: false,
        }),
      );

      // Compared as whole sets so a disagreement names the path rather than failing on a count.
      const scannerSays = FIXTURE_FILES.filter((rel) => scanned.has(rel)).sort();
      const predicateSays = FIXTURE_FILES.filter((rel) => secretMaskDeniesPath(policy, rel)).sort();
      expect(predicateSays).toEqual(scannerSays);

      // The fixture is only evidence if the scan actually matched things and spared others.
      expect(scannerSays.length).toBeGreaterThan(10);
      expect(scannerSays.length).toBeLessThan(FIXTURE_FILES.length);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('spares a carve-out and a structural ignore dir, and catches the dotted cases', () => {
    const policy = secretMaskPolicy({});
    expect(secretMaskDeniesPath(policy, '.env')).toBe(true);
    // Both are why node:path's matcher could not be used.
    expect(secretMaskDeniesPath(policy, '.config/.env')).toBe(true);
    expect(secretMaskDeniesPath(policy, '.hidden.pem')).toBe(true);
    expect(secretMaskDeniesPath(policy, '.env.example')).toBe(false);
    expect(secretMaskDeniesPath(policy, 'node_modules/pkg/.env')).toBe(false);
  });

  it('honours per-repo allow and denyExtend', () => {
    const policy = secretMaskPolicy({ allow: ['**/.env'], denyExtend: ['**/*.sql'] });
    expect(secretMaskDeniesPath(policy, '.env')).toBe(false);
    expect(secretMaskDeniesPath(policy, 'db/schema.sql')).toBe(true);
  });

  it('treats a tracked path as readable and an absent tracked set as all-untracked', () => {
    const tracked = secretMaskPolicy({ tracked: new Set(['.env']) });
    expect(secretMaskDeniesPath(tracked, '.env')).toBe(false);
    expect(secretMaskDeniesPath(tracked, '.env.local')).toBe(true);

    // null means git could not answer — mask more, never less, as filterUntracked does.
    const unknown = secretMaskPolicy({ tracked: null });
    expect(secretMaskDeniesPath(unknown, '.env')).toBe(true);
  });

  it('normalises a relative path rather than answering false for it', () => {
    const policy = secretMaskPolicy({});
    expect(secretMaskDeniesPath(policy, './.env')).toBe(true);
    expect(secretMaskDeniesPath(policy, 'sub\\.env')).toBe(true);
    // An absolute path is not repository-relative and cannot be judged.
    expect(secretMaskDeniesPath(policy, '/etc/.env')).toBe(false);
    expect(secretMaskDeniesPath(policy, '')).toBe(false);
  });
});
