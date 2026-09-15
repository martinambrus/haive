import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { listFilesMatching } from '../src/step-engine/steps/onboarding/_helpers.js';
import {
  collectRepoBasenames,
  collectRepoSymbols,
} from '../src/step-engine/steps/onboarding/08-knowledge-acquisition.js';

vi.mock('../src/step-engine/steps/onboarding/_helpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/step-engine/steps/onboarding/_helpers.js')>()),
  listFilesMatching: vi.fn(),
}));

// The walker returns `readdir` order, which the FILESYSTEM decides: ext4 lists a large directory
// in hash order, so two checkouts of one tree can list it differently. Once a repo passes the
// file cap, what the scrub's collectors keep must not depend on that order. MEASURED on a real
// 18,008-file WordPress repo: its walker order and its sorted order kept different subsets.
//
// More paths than the symbol file cap (4000), bracketed by two real files so the cap has to drop
// one of them.
const FIRST = 'a/alpha_helpers.php';
const LAST = 'z/omega_helpers.php';
const FILLER = Array.from({ length: 4500 }, (_, i) => `m/filler-${String(i).padStart(4, '0')}.php`);
const LISTED = [FIRST, ...FILLER, LAST];

describe('the scrub collectors under the file cap', () => {
  it('keep the same basenames whatever order the walker lists files in', async () => {
    // No file is read for basenames, so only the 40,000-NAME cap bounds them: exceed that.
    const many = Array.from(
      { length: 40_001 },
      (_, i) => `m/filler-${String(i).padStart(5, '0')}.php`,
    );
    const listed = [FIRST, ...many, LAST];
    vi.mocked(listFilesMatching).mockResolvedValueOnce([...listed]);
    const forward = await collectRepoBasenames('/repo');
    vi.mocked(listFilesMatching).mockResolvedValueOnce([...listed].reverse());
    const reversed = await collectRepoBasenames('/repo');

    expect([...reversed].sort()).toEqual([...forward].sort());
    // The cap must actually bind, or equal sets prove nothing.
    expect(forward.has('alpha_helpers.php') && forward.has('omega_helpers.php')).toBe(false);
  });

  it('keep the same symbols whatever order the walker lists files in', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'scan-order-'));
    await mkdir(path.join(dir, 'a'));
    await mkdir(path.join(dir, 'z'));
    await writeFile(path.join(dir, FIRST), '<?php\nfunction alpha_invoice_builder() {}\n', 'utf8');
    await writeFile(path.join(dir, LAST), '<?php\nfunction omega_invoice_builder() {}\n', 'utf8');

    vi.mocked(listFilesMatching).mockResolvedValueOnce([...LISTED]);
    const forward = await collectRepoSymbols(dir, null);
    vi.mocked(listFilesMatching).mockResolvedValueOnce([...LISTED].reverse());
    const reversed = await collectRepoSymbols(dir, null);

    expect([...reversed].sort()).toEqual([...forward].sort());
    expect(forward.has('alpha_invoice_builder') || forward.has('omega_invoice_builder')).toBe(true);
    expect(forward.has('alpha_invoice_builder') && forward.has('omega_invoice_builder')).toBe(
      false,
    );
  });
});
