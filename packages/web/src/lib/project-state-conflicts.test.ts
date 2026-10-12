import { describe, expect, it, vi } from 'vitest';
import {
  answerConfirmation,
  conflictKeyLabel,
  conflictSideMarkdown,
  resolutionNotice,
  stillListed,
  submitConflictAnswer,
  type ProjectStateConflictBody,
} from './project-state-conflicts';

const REPO = '11111111-1111-4111-8111-111111111111';
const ROW = '22222222-2222-4222-8222-222222222222';

describe('conflictKeyLabel', () => {
  it('names each render key a person can recognise', () => {
    expect(conflictKeyLabel('projectInfo')).toBe('Project details');
    expect(conflictKeyLabel('framework')).toBe('Framework');
    expect(conflictKeyLabel('acceptedAgentIds')).toBe('Accepted agents');
    expect(conflictKeyLabel('customAgentSpecs')).toBe('Custom agents');
  });

  it('names the whole file for the null key and falls back to the key itself', () => {
    expect(conflictKeyLabel(null)).toBe('The whole project record file');
    expect(conflictKeyLabel('somethingNew')).toBe('somethingNew');
  });
});

describe('conflictSideMarkdown', () => {
  it('fences a present value as json', () => {
    expect(conflictSideMarkdown({ present: true, value: ['a', 'b'] })).toBe(
      '```json\n[\n  "a",\n  "b"\n]\n```',
    );
  });

  it('keeps a JSON null as a value', () => {
    expect(conflictSideMarkdown({ present: true, value: null })).toBe('```json\nnull\n```');
  });

  it('says so when the side holds nothing', () => {
    expect(conflictSideMarkdown({ present: false })).toBe('Not set.');
  });

  it('outruns a backtick run inside a string so the value cannot leave its block', () => {
    const md = conflictSideMarkdown({ present: true, value: '```\n# heading' });
    expect(md.startsWith('````json\n')).toBe(true);
    expect(md.endsWith('\n````')).toBe(true);
  });
});

describe('answerConfirmation', () => {
  it('keep mine says the value goes to the record file and needs committing and pushing', () => {
    const c = answerConfirmation('keep_mine', 'acceptedAgentIds');
    expect(c.confirmLabel).toBe('Keep mine');
    expect(c.body).toContain('.haive-data/state/project/render.json');
    expect(c.body).toContain('Commit and push');
    expect(c.body).toContain('Accepted agents');
  });

  it('take theirs says this install switches to the teammate value', () => {
    const c = answerConfirmation('take_theirs', 'framework');
    expect(c.confirmLabel).toBe('Take theirs');
    expect(c.body).toContain("teammate's value");
    expect(c.body).toContain('Framework');
  });
});

describe('submitConflictAnswer', () => {
  it('posts the answer to the conflict and reports a resolved answer', async () => {
    const post = vi.fn().mockResolvedValue({ conflict: { id: ROW }, written: ['x'] });
    const out = await submitConflictAnswer(post, REPO, ROW, 'keep_mine');
    expect(post).toHaveBeenCalledWith(`/repos/${REPO}/project-state/conflicts/${ROW}`, {
      answer: 'keep_mine',
    });
    expect(out).toEqual({ kind: 'resolved' });
  });

  it('reports a 202 as pending with the api message', async () => {
    const post = vi.fn().mockResolvedValue({ pending: true, message: 'Still applying.' });
    expect(await submitConflictAnswer(post, REPO, ROW, 'take_theirs')).toEqual({
      kind: 'pending',
      message: 'Still applying.',
    });
  });

  it('carries a refusal text through as an error', async () => {
    const post = vi.fn().mockRejectedValue(new Error('An onboarding is using this repository.'));
    expect(await submitConflictAnswer(post, REPO, ROW, 'keep_mine')).toEqual({
      kind: 'error',
      message: 'An onboarding is using this repository.',
    });
  });
});

describe('stillListed', () => {
  const listed = (id: string) => ({ id }) as ProjectStateConflictBody;

  it('keeps an answered conflict pending while the list still holds it', () => {
    expect(stillListed([ROW], [listed(ROW)])).toEqual([ROW]);
  });

  it('drops a pending conflict once the list no longer holds it', () => {
    expect(stillListed([ROW], [listed(REPO)])).toEqual([]);
  });
});

describe('resolutionNotice', () => {
  it('says nothing before any answer lands', () => {
    expect(resolutionNotice([])).toBeNull();
  });

  it('asks for a commit once any kept value was written, whatever came after', () => {
    expect(resolutionNotice(['keep_mine', 'take_theirs'])).toContain('Commit and push');
    expect(resolutionNotice(['take_theirs', 'keep_mine'])).toContain('Commit and push');
  });

  it('names the record file as code', () => {
    expect(resolutionNotice(['keep_mine'])).toContain('`.haive-data/state/project/render.json`');
  });

  it("reports the teammate's value when nothing was kept", () => {
    expect(resolutionNotice(['take_theirs'])).toBe("This install now uses your teammate's value.");
  });
});
