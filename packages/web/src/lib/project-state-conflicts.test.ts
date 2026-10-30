import { describe, expect, it, vi } from 'vitest';
import { scanFences } from '@haive/shared/markdown-fences';
import { claimFileName, settingFileName } from '@haive/shared/project-state';
import { fencedCode } from '../components/markdown/fenced-code';
import {
  answerAndConfirm,
  answerConfirmation,
  conflictClaimPath,
  conflictKeyLabel,
  conflictSideMarkdown,
  isPlanConflict,
  isRtkConflict,
  planConflictHeading,
  isSettingConflict,
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
  });

  it('keep mine says RTK stays on here and the choice is recorded in its record file', () => {
    const c = answerConfirmation('keep_mine', null, UNIT, null, true);
    expect(c.confirmLabel).toBe('Keep mine');
    expect(c.body).toBe(
      "RTK command compression stays on in this install. This install's choice is recorded in the project's record file, .haive-data/state/settings/rtk-enabled.json. Commit and push that file if it changed, so your teammate gets it.",
    );
  });

  it('take theirs says RTK is switched off here as the other install has it', () => {
    const c = answerConfirmation('take_theirs', null, UNIT, null, true);
    expect(c.confirmLabel).toBe('Take theirs');
    expect(c.body).toContain('switched off in this install, as the other install has it');
    expect(c.body).toContain('.haive-data/state/settings/rtk-enabled.json');
    expect(c.body).not.toContain('No repository file is written');
  });

  it('reports each answer as what happened to RTK and where the choice is recorded', () => {
    const recorded =
      "This install's choice is recorded in `.haive-data/state/settings/rtk-enabled.json`. Commit and push that file if it changed, so your teammate gets it.";
    expect(resolutionNotice([], ['keep_mine'])).toBe(
      `RTK command compression stays on in this install. ${recorded}`,
    );
    expect(resolutionNotice([], ['take_theirs'])).toBe(
      `RTK command compression is switched off in this install. ${recorded}`,
    );
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

describe('a claim question', () => {
  const PATH = '.claude/agents/code-reviewer.md';
  const UNIT = claimFileName(PATH);
  const CLAIM = {
    path: PATH,
    templateId: 'agent.code-reviewer',
    kind: 'agent',
    schemaVersion: 2,
    templateHash: 'a'.repeat(64),
    writtenHash: 'b0c1d2e3f4a5'.padEnd(64, '0'),
    haiveVersion: '1.2.3',
  };
  const present = (value: unknown) => ({ present: true as const, value });
  const absent = { present: false as const };

  it('is labelled by the file its claim names, from whichever side holds one', () => {
    const sides = { unit: UNIT, base: absent, local: absent, incoming: present(CLAIM) };
    expect(conflictClaimPath(sides)).toBe(PATH);
    expect(conflictKeyLabel(null, UNIT, conflictClaimPath(sides))).toBe(`the claim for ${PATH}`);
    expect(conflictClaimPath({ ...sides, incoming: absent })).toBeNull();
    expect(
      conflictClaimPath({ ...sides, unit: 'project/render.json', local: present(CLAIM) }),
    ).toBe(null);
  });

  it('shows a side as its template, kind, Haive version and written hash in a wrapping list', () => {
    expect(conflictSideMarkdown(present(CLAIM), UNIT)).toBe(
      [
        '- Template: `agent.code-reviewer`',
        '- Kind: `agent`',
        '- Haive version: `1.2.3`',
        '- Written hash: `b0c1d2e3f4a5`',
      ].join('\n'),
    );
    expect(conflictSideMarkdown(present({ ...CLAIM, haiveVersion: '' }), UNIT)).toContain(
      'Haive version: not recorded',
    );
    expect(conflictSideMarkdown(present({ ...CLAIM, templateId: 'a`b' }), UNIT)).toContain(
      '- Template: `` a`b ``',
    );
    expect(conflictSideMarkdown(absent, UNIT)).toBe('Not set.');
  });

  it('keeps a value that is no claim as plain json', () => {
    expect(conflictSideMarkdown(present(['a']), UNIT)).toBe('```json\n[\n  "a"\n]\n```');
  });

  it('keeps a template id from leaving its block', () => {
    const md = conflictSideMarkdown(present({ ...CLAIM, templateId: '```\n# heading' }), UNIT);
    expect(md.split('\n')).toHaveLength(4);
    expect(md.split('\n')[0]).toBe('- Template: ```` ``` # heading ````');
  });

  it('keep mine names the claim file it writes, take theirs writes none', () => {
    const keep = answerConfirmation('keep_mine', null, UNIT, PATH);
    expect(keep.body).toContain(`the claim for ${PATH}`);
    expect(keep.body).toContain(`.haive-data/state/${UNIT}`);
    expect(keep.body).not.toContain('render.json');
    expect(keep.body).toContain('Commit and push');
    const take = answerConfirmation('take_theirs', null, UNIT, PATH);
    expect(take.body).toContain(`the claim for ${PATH}`);
    expect(take.body).toContain('No repository file is written');
  });

  it('reports each answer as what happened to the claim, not to render.json', () => {
    expect(resolutionNotice([], [], ['keep_mine'])).toContain('Commit and push');
    expect(resolutionNotice([], [], ['keep_mine'])).not.toContain('render.json');
    expect(resolutionNotice([], [], ['take_theirs'])).toContain('now records the file');
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

  it('keeps record recovery busy refusals retryable without reporting an applied answer', async () => {
    const message =
      'This repository is busy with onboarding, an upgrade, or project settings recovery. Try again once it is ready.';
    const post = vi.fn().mockRejectedValue(
      Object.assign(new Error(message), {
        status: 409,
        code: 'project_state_conflict_busy',
      }),
    );
    expect(await submitConflictAnswer(post, REPO, ROW, 'keep_mine')).toEqual({
      kind: 'error',
      message,
      code: 'project_state_conflict_busy',
      ambiguous: false,
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

describe('a setting or environment question', () => {
  const LSP = 'settings/lsp-servers.json';
  const present = (value: unknown) => ({ present: true as const, value });

  it('is labelled by its unit and named by its own record file', () => {
    expect(conflictKeyLabel(null, LSP)).toBe('Language servers');
    expect(conflictKeyLabel('confirmedValues', 'project/environment.json#confirmedValues')).toBe(
      'Confirmed environment values',
    );
    expect(answerConfirmation('keep_mine', null, LSP).body).toContain(
      '.haive-data/state/settings/lsp-servers.json',
    );
    expect(
      answerConfirmation('keep_mine', 'confirmedValues', 'project/environment.json#confirmedValues')
        .body,
    ).toContain('.haive-data/state/project/environment.json');
    expect(
      answerConfirmation('keep_mine', 'framework', 'project/render.json#framework').body,
    ).toContain('.haive-data/state/project/render.json');
  });

  it('shows a list, a version map, a text and a switch readably, not as JSON', () => {
    expect(conflictSideMarkdown(present(['vtsls', 'pyright']), LSP)).toBe('- `vtsls`\n- `pyright`');
    expect(conflictSideMarkdown(present([]), LSP)).toBe('Empty.');
    expect(
      conflictSideMarkdown(present({ vtsls: '1.0.0' }), 'settings/lsp-server-versions.json'),
    ).toBe('- `vtsls`: `1.0.0`');
    expect(conflictSideMarkdown(present('0.42.4'), 'settings/rtk-version.json')).toBe('`0.42.4`');
    expect(conflictSideMarkdown(present(false), 'settings/rtk-enabled.json')).toBe('Off');
  });

  it('keeps a value that is no list in the json fence, and the environment too', () => {
    expect(conflictSideMarkdown(present({ a: 1 }), LSP)).toBe('```json\n{\n  "a": 1\n}\n```');
    expect(
      conflictSideMarkdown(present({ web: 'nginx' }), 'project/environment.json#confirmedValues'),
    ).toBe('```json\n{\n  "web": "nginx"\n}\n```');
  });

  it('is told apart from the RTK question and the render keys when an answer lands', () => {
    expect(isSettingConflict(bare(LSP))).toBe(true);
    expect(isSettingConflict(bare('project/environment.json'))).toBe(true);
    expect(isSettingConflict(bare('project/render.json#framework'))).toBe(false);
    expect(resolutionNotice([], [], [], ['keep_mine'])).toContain(
      'Commit and push the changed file',
    );
    expect(resolutionNotice([], [], [], ['take_theirs'])).toBe(
      "This install now uses your teammate's value.",
    );
  });
});

describe('the AGENTS.md rules question', () => {
  const UNIT = 'settings/agent-rules.md';
  const present = (value: unknown) => ({ present: true as const, value });
  const TEXT = '# Rules\n\nKeep it small.\n\n```ts\nconst x = 1;\n```\n\n- Last rule\n';

  it('is the unit the record names for the setting, labelled AGENTS.md rules', () => {
    expect(UNIT).toBe(settingFileName('agent-rules'));
    expect(conflictKeyLabel(null, UNIT)).toBe('AGENTS.md rules');
    expect(isSettingConflict(bare(UNIT))).toBe(true);
  });

  it('shows a text as one fenced markdown block that its own backtick run cannot leave', () => {
    const md = conflictSideMarkdown(present(TEXT), UNIT);
    expect(md).toBe(fencedCode(TEXT, 'markdown'));
    const lines = md.split('\n');
    const fences = scanFences(lines);
    expect(fences).toHaveLength(1);
    expect(fences[0]).toMatchObject({ lang: 'markdown', open: 0, close: lines.length - 1 });
    expect(fences[0]!.content.join('\n')).toBe(TEXT);
  });

  it('keeps the line breaks of the text, which inline code would collapse', () => {
    expect(conflictSideMarkdown(present('Line one\nLine two'), UNIT)).toBe(
      '```markdown\nLine one\nLine two\n```',
    );
  });

  it('says an empty override in words, apart from a side that holds nothing', () => {
    expect(conflictSideMarkdown(present(''), UNIT)).toBe(
      'An empty override: no rules block is written.',
    );
    expect(conflictSideMarkdown({ present: false }, UNIT)).toBe('Not set.');
  });

  it('keeps a value that is no text in the json fence', () => {
    expect(conflictSideMarkdown(present(['a']), UNIT)).toBe('```json\n[\n  "a"\n]\n```');
  });

  it('is confirmed by its label and its own record file', () => {
    const keep = answerConfirmation('keep_mine', null, UNIT);
    expect(keep.body).toContain('AGENTS.md rules');
    expect(keep.body).toContain('.haive-data/state/settings/agent-rules.md');
    expect(keep.body).toContain('Commit and push');
    const take = answerConfirmation('take_theirs', null, UNIT);
    expect(take.body).toContain('AGENTS.md rules');
    expect(take.body).toContain('No repository file is written');
  });
});

describe('a plan question', () => {
  const NODE = '11111111-1111-4111-8111-111111111111';
  const unit = (field: string) => `plan/${NODE}#${field}`;

  it('is told apart from a project record question', () => {
    expect(isPlanConflict({ unit: unit('title') })).toBe(true);
    expect(isPlanConflict({ unit: unit('ordinal') })).toBe(false);
    expect(isPlanConflict({ unit: 'project/render.json#framework' })).toBe(false);
  });

  it('is headed by the node and the field', () => {
    expect(planConflictHeading({ unit: unit('title'), nodeTitle: 'Billing' })).toBe(
      '`Billing`: Title',
    );
    expect(planConflictHeading({ unit: unit('title'), nodeTitle: '**x**' })).toBe('`**x**`: Title');
    expect(planConflictHeading({ unit: unit('taskable'), nodeTitle: null })).toBe(
      'A node that was deleted here: Can start tasks',
    );
  });

  it('shows prose as it is and the short fields as code or words', () => {
    expect(conflictSideMarkdown({ present: true, value: 'Some **text**' }, unit('body'))).toBe(
      'Some **text**',
    );
    expect(conflictSideMarkdown({ present: true, value: null }, unit('body'))).toBe('No text.');
    expect(conflictSideMarkdown({ present: true, value: 'done' }, unit('status'))).toBe('`done`');
    expect(conflictSideMarkdown({ present: true, value: true }, unit('taskable'))).toBe('Yes');
  });

  it('is confirmed in terms of the plan file, and noticed after the answer', () => {
    const keep = answerConfirmation('keep_mine', 'title', unit('title'));
    expect(keep.body).toContain('.haive-data/plan.json');
    expect(answerConfirmation('take_theirs', 'title', unit('title')).confirmLabel).toBe(
      'Take theirs',
    );
    expect(resolutionNotice([], [], [], [], ['keep_mine'])).toContain('.haive-data/plan.json');
    expect(resolutionNotice([], [], [], [], ['take_theirs'])).toContain('teammate');
  });
});

const bare = (unit: string) => ({
  unit,
  base: { present: false as const },
  local: { present: false as const },
});

describe('the RTK question versus an ordinary rtk-enabled conflict', () => {
  const side = (value: unknown) => ({ present: true, value });
  const unit = 'settings/rtk-enabled.json';

  it('shows an ordinary conflict the setting copy, not the question copy', () => {
    const c = answerConfirmation('keep_mine', null, unit, null, false);
    expect(c.body).not.toContain('stays on in this install');
  });

  it('is the question only where base equals local', () => {
    const question = { unit, base: side(true), local: side(true), incoming: side(false) };
    const ordinary = { unit, base: side(true), local: side(false), incoming: side(true) };
    expect(isRtkConflict(question)).toBe(true);
    expect(isRtkConflict(ordinary)).toBe(false);
    expect(isSettingConflict(question)).toBe(false);
    expect(isSettingConflict(ordinary)).toBe(true);
  });
});
