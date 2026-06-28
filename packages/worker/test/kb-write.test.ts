import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyKbWrites, sanitizeKbRelPath } from '../src/step-engine/steps/onboarding/_kb-write.js';

/* ------------------------------------------------------------------ */
/* sanitizeKbRelPath                                                   */
/* ------------------------------------------------------------------ */

describe('sanitizeKbRelPath', () => {
  it('accepts a normal path and adds .md if missing', () => {
    const out = sanitizeKbRelPath('BUSINESS_LOGIC');
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.normalized).toBe('BUSINESS_LOGIC.md');
  });
  it('preserves an existing .md extension', () => {
    const out = sanitizeKbRelPath('QA/foo.md');
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.normalized).toBe('QA/foo.md');
  });
  it('strips a leading .claude/knowledge_base/ prefix', () => {
    const out = sanitizeKbRelPath('.claude/knowledge_base/BUSINESS_LOGIC.md');
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.normalized).toBe('BUSINESS_LOGIC.md');
  });
  it('rejects absolute paths', () => {
    expect(sanitizeKbRelPath('/etc/passwd').ok).toBe(false);
  });
  it('rejects ".." segments', () => {
    expect(sanitizeKbRelPath('../escape.md').ok).toBe(false);
    expect(sanitizeKbRelPath('a/../b.md').ok).toBe(false);
  });
  it('rejects empty paths', () => {
    expect(sanitizeKbRelPath('').ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* applyKbWrites                                                       */
/* ------------------------------------------------------------------ */

describe('applyKbWrites', () => {
  let tmpRoot: string;
  let kbDir: string;
  const nowIso = '2026-06-28T00:00:00.000Z';

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'kb-write-'));
    kbDir = path.join(tmpRoot, '.claude', 'knowledge_base');
    await mkdir(kbDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('appends a section to an existing KB file', async () => {
    const target = path.join(kbDir, 'BUSINESS_LOGIC.md');
    await writeFile(target, '# Business Logic\n\n## Existing\n\nold.\n', 'utf8');
    const { written } = await applyKbWrites(
      tmpRoot,
      [{ relPath: 'BUSINESS_LOGIC.md', section: 'Order delivery', content: 'New body.' }],
      nowIso,
    );
    const final = await readFile(target, 'utf8');
    expect(final).toContain('## Existing');
    expect(final).toContain('## Order delivery');
    expect(final).toContain('New body.');
    expect(written).toHaveLength(1);
    expect(written[0]!.relPath).toBe('.claude/knowledge_base/BUSINESS_LOGIC.md');
  });

  it('creates a new KB file (and parent dir) when the path does not exist', async () => {
    await applyKbWrites(
      tmpRoot,
      [{ relPath: 'QA/order-delivery.md', section: 'Partial delivery', content: 'Body.' }],
      nowIso,
    );
    const created = await readFile(path.join(kbDir, 'QA', 'order-delivery.md'), 'utf8');
    expect(created).toContain('# QA / order-delivery');
    expect(created).toContain('## Partial delivery');
    expect(created).toContain('Body.');
  });

  it('records skipped writes for unsafe paths instead of writing', async () => {
    const { written, skipped } = await applyKbWrites(
      tmpRoot,
      [
        { relPath: '../escape.md', section: 'X', content: 'Y' },
        { relPath: 'OK.md', section: 'OK section', content: 'OK body' },
      ],
      nowIso,
    );
    expect(written).toHaveLength(1);
    expect(written[0]!.relPath).toBe('.claude/knowledge_base/OK.md');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.relPath).toBe('../escape.md');
  });
});
