import { describe, expect, it, vi } from 'vitest';
import {
  answerAndConfirm,
  answerConfirmation,
  conflictKeyLabel,
  conflictSideMarkdown,
  isRtkConflict,
  landedAnswer,
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

describe('the RTK question', () => {
  const UNIT = 'settings/rtk-enabled.json';

  it('is labelled by its unit, since its key is null like the whole file', () => {
    expect(conflictKeyLabel(null, UNIT)).toBe('RTK command compression');
    expect(conflictKeyLabel(null)).toBe('The whole project record file');
    expect(isRtkConflict({ unit: UNIT })).toBe(true);
    expect(isRtkConflict({ unit: 'project/render.json' })).toBe(false);
  });

  it('keep mine says RTK stays on here and no file is written', () => {
    const c = answerConfirmation('keep_mine', null, UNIT);
    expect(c.confirmLabel).toBe('Keep mine');
    expect(c.body).toBe(
      'RTK command compression stays on in this install. No repository file is written.',
    );
    expect(c.body).not.toContain('Commit and push');
  });

  it('take theirs says RTK is switched off here as the other install has it', () => {
    const c = answerConfirmation('take_theirs', null, UNIT);
    expect(c.confirmLabel).toBe('Take theirs');
    expect(c.body).toContain('switched off in this install, as the other install has it');
    expect(c.body).toContain('No repository file is written');
  });

  it('reports each answer as what happened to RTK, never as a record file written', () => {
    expect(resolutionNotice([], ['keep_mine'])).toBe(
      'RTK command compression stays on in this install.',
    );
    expect(resolutionNotice([], ['take_theirs'])).toBe(
      'RTK command compression is switched off in this install.',
    );
    expect(resolutionNotice([], ['keep_mine'])).not.toContain('Commit and push');
  });

  it('adds the record file notice only for a render answer beside it', () => {
    const both = resolutionNotice(['keep_mine'], ['take_theirs'])!;
    expect(both).toContain('Commit and push');
    expect(both).toContain('switched off in this install');
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

  it('shows the RTK switch as On or Off', () => {
    const unit = 'settings/rtk-enabled.json';
    expect(conflictSideMarkdown({ present: true, value: true }, unit)).toBe('On');
    expect(conflictSideMarkdown({ present: true, value: false }, unit)).toBe('Off');
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
    const refusal = Object.assign(new Error('An onboarding is using this repository.'), {
      status: 409,
    });
    const post = vi.fn().mockRejectedValue(refusal);
    expect(await submitConflictAnswer(post, REPO, ROW, 'keep_mine')).toEqual({
      kind: 'error',
      message: 'An onboarding is using this repository.',
      ambiguous: false,
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

describe('landedAnswer', () => {
  it('counts only an answer the row was actually closed with', () => {
    expect(landedAnswer('keep_mine')).toBe('keep_mine');
    expect(landedAnswer('take_theirs')).toBe('take_theirs');
    expect(landedAnswer('converged')).toBeNull();
    expect(landedAnswer(null)).toBeNull();
  });
});

describe('answerAndConfirm', () => {
  const failing = (status?: number) => async () => {
    throw Object.assign(new Error('failed'), status === undefined ? {} : { status });
  };
  const rowWith = (resolution: string | null) => async () =>
    ({ conflict: { resolution } }) as never;
  const lookupFails = async () => {
    throw new Error('Network error');
  };

  it('counts an answer the row was closed with although its response was lost', async () => {
    expect(await answerAndConfirm(failing(), rowWith('keep_mine'), REPO, ROW, 'keep_mine')).toEqual(
      { kind: 'resolved' },
    );
  });

  it('keeps polling a row still open after a lost response', async () => {
    const out = await answerAndConfirm(failing(502), rowWith(null), REPO, ROW, 'keep_mine');
    expect(out.kind).toBe('pending');
  });

  it('keeps polling when the lookup fails too', async () => {
    const out = await answerAndConfirm(failing(), lookupFails, REPO, ROW, 'take_theirs');
    expect(out.kind).toBe('pending');
  });

  it('shows the error when the row was closed another way', async () => {
    const out = await answerAndConfirm(failing(), rowWith('converged'), REPO, ROW, 'keep_mine');
    expect(out.kind).toBe('error');
  });

  it('carries the answer that landed when another request already settled the row', async () => {
    const settled = async () => {
      throw Object.assign(new Error('This question was already answered the other way.'), {
        status: 409,
        code: 'project_state_conflict_settled',
      });
    };
    const out = await answerAndConfirm(settled, rowWith('keep_mine'), REPO, ROW, 'take_theirs');
    expect(out).toMatchObject({ kind: 'error', landed: 'keep_mine' });
  });

  it('carries the other answer when a lost request lost to a concurrent one', async () => {
    const out = await answerAndConfirm(failing(), rowWith('keep_mine'), REPO, ROW, 'take_theirs');
    expect(out).toMatchObject({ kind: 'error', landed: 'keep_mine' });
  });

  it('keeps a settled refusal pending when the row cannot be read', async () => {
    const settled = async () => {
      throw Object.assign(new Error('already answered'), {
        status: 409,
        code: 'project_state_conflict_settled',
      });
    };
    const out = await answerAndConfirm(settled, lookupFails, REPO, ROW, 'take_theirs');
    expect(out.kind).toBe('pending');
  });

  it('lets a refusal stand without asking the row', async () => {
    const get = vi.fn();
    const out = await answerAndConfirm(failing(409), get, REPO, ROW, 'keep_mine');
    expect(out).toMatchObject({ kind: 'error', ambiguous: false });
    expect(get).not.toHaveBeenCalled();
  });

  it('does not look the row up after an answer that came back', async () => {
    const get = vi.fn();
    const post = async () => ({ pending: true, message: 'later' }) as never;
    const out = await answerAndConfirm(post, get, REPO, ROW, 'keep_mine');
    expect(out.kind).toBe('pending');
    expect(get).not.toHaveBeenCalled();
  });
});
