import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseInvestigation, writeInvestigation } from './11-phase-8-learning.js';

describe('parseInvestigation', () => {
  it('parses an investigation from a fenced object', () => {
    const raw =
      '```json\n{"entries":[],"investigation":{"title":"Null deref","root_cause":"missing guard","lesson":"guard inputs"}}\n```';
    const inv = parseInvestigation(raw);
    expect(inv).not.toBeNull();
    expect(inv!.title).toBe('Null deref');
    expect(inv!.rootCause).toBe('missing guard');
    expect(inv!.lesson).toBe('guard inputs');
  });

  it('accepts an already-parsed object', () => {
    const inv = parseInvestigation({
      investigation: { title: 'X', root_cause: 'y', lesson: 'z' },
    });
    expect(inv!.title).toBe('X');
  });

  it('returns null when there is no investigation or it lacks a root cause', () => {
    expect(parseInvestigation('```json\n{"entries":[]}\n```')).toBeNull();
    expect(
      parseInvestigation({ investigation: { title: 'X', root_cause: '', lesson: 'z' } }),
    ).toBeNull();
    expect(parseInvestigation('no json')).toBeNull();
    expect(parseInvestigation(null)).toBeNull();
  });

  it('parses symptoms when present and defaults to empty string when absent', () => {
    const withSym = parseInvestigation({
      investigation: {
        title: 'X',
        symptoms: 'TypeError: x is undefined',
        root_cause: 'y',
        lesson: 'z',
      },
    });
    expect(withSym!.symptoms).toBe('TypeError: x is undefined');

    const withoutSym = parseInvestigation({
      investigation: { title: 'X', root_cause: 'y', lesson: 'z' },
    });
    expect(withoutSym).not.toBeNull();
    expect(withoutSym!.symptoms).toBe('');
  });
});

describe('writeInvestigation', () => {
  const baseInv = {
    title: 'Null deref',
    symptoms: 'TypeError: cannot read x',
    rootCause: 'missing guard',
    lesson: 'guard inputs',
    scope: 'local' as const,
  };

  it('writes a Symptoms section + feature/affected_clients frontmatter when present', async () => {
    const ws = await mkdtemp(path.join(tmpdir(), 'inv-'));
    try {
      const rel = await writeInvestigation(
        ws,
        baseInv,
        'Fix null deref',
        '',
        '2026-01-01T00:00:00.000Z',
        'checkout',
        ['acme', 'globex'],
      );
      const text = await readFile(path.join(ws, rel), 'utf8');
      expect(text).toContain('feature: "checkout"');
      expect(text).toContain('affected_clients: ["acme","globex"]');
      expect(text).toContain('## Symptoms');
      expect(text).toContain('TypeError: cannot read x');
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it('omits the Symptoms section + feature/clients frontmatter when absent', async () => {
    const ws = await mkdtemp(path.join(tmpdir(), 'inv-'));
    try {
      const rel = await writeInvestigation(
        ws,
        { ...baseInv, symptoms: '' },
        'Task',
        '',
        '2026-01-01T00:00:00.000Z',
        null,
        [],
      );
      const text = await readFile(path.join(ws, rel), 'utf8');
      expect(text).not.toContain('## Symptoms');
      expect(text).not.toContain('feature:');
      expect(text).not.toContain('affected_clients:');
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });
});
