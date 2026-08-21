import { describe, it, expect, vi, beforeEach } from 'vitest';

const loadPreviousStepOutput = vi.fn();
const pathExists = vi.fn();
vi.mock('../onboarding/_helpers.js', () => ({
  loadPreviousStepOutput: (...args: unknown[]) => loadPreviousStepOutput(...args),
  pathExists: (...args: unknown[]) => pathExists(...args),
}));

const configGet = vi.fn();
vi.mock('@haive/shared', () => ({
  CONFIG_KEYS: { SPEC_VIEW_MODE: 'config:output:specViewMode' },
  configService: { get: (...args: unknown[]) => configGet(...args) },
  SPEC_VIEW_MODES: ['toc', 'full'],
}));

const { resolveSpecView, SPEC_ARTIFACT_RELPATH } = await import('./_spec-artifact.js');
type Ctx = Parameters<typeof resolveSpecView>[0];

/** A spec long enough that condensing always drops something. */
const LONG_SPEC = [
  '# Feature',
  ...Array.from({ length: 30 }, (_, i) => `overview line ${i}`),
  '## Data model',
  ...Array.from({ length: 30 }, (_, i) => `model line ${i}`),
].join('\n');

/** Wire the three step lookups resolveSpecView makes: 04 / 05 / 05a for the spec body,
 *  then 01-worktree-setup for the artifact path. */
function wireSteps(spec: string, worktreePath: string | null): void {
  loadPreviousStepOutput.mockImplementation(async (_db: unknown, _task: string, stepId: string) => {
    if (stepId === '05a-resolve-spec-warnings') return { output: { spec } };
    if (stepId === '01-worktree-setup') {
      return worktreePath ? { output: { worktreePath } } : null;
    }
    return null;
  });
}

function ctx(): Ctx {
  return {
    db: {},
    taskId: 'task-1',
    sandboxWorkdir: '/haive/workdir',
    logger: { warn: vi.fn(), info: vi.fn() },
  } as unknown as Ctx;
}

beforeEach(() => {
  loadPreviousStepOutput.mockReset();
  pathExists.mockReset();
  configGet.mockReset();
  pathExists.mockResolvedValue(true);
  configGet.mockResolvedValue('toc');
});

describe('resolveSpecView', () => {
  it('condenses and appends a pointer at the sandbox path', async () => {
    wireSteps(LONG_SPEC, '/repo/.haive/worktrees/feat');
    const view = await resolveSpecView(ctx());

    expect(view.condensed).toBe(true);
    expect(view.spec).toBe(LONG_SPEC);
    expect(view.text).toContain('# Feature');
    expect(view.text).toContain('## Data model');
    expect(view.text).toContain(`/haive/workdir/${SPEC_ARTIFACT_RELPATH}`);
    expect(view.text.length).toBeLessThan(LONG_SPEC.length);
  });

  it('sends the whole spec when the mode is full', async () => {
    configGet.mockResolvedValue('full');
    wireSteps(LONG_SPEC, '/repo/.haive/worktrees/feat');
    const view = await resolveSpecView(ctx());
    expect(view).toEqual({ text: LONG_SPEC, spec: LONG_SPEC, condensed: false });
  });

  it('sends the whole spec when the caller asks for it, without reading config', async () => {
    wireSteps(LONG_SPEC, '/repo/.haive/worktrees/feat');
    const view = await resolveSpecView(ctx(), { full: true });
    expect(view.condensed).toBe(false);
    expect(view.text).toBe(LONG_SPEC);
    expect(configGet).not.toHaveBeenCalled();
  });

  it('never points at an artifact that is not on disk', async () => {
    pathExists.mockResolvedValue(false);
    wireSteps(LONG_SPEC, '/repo/.haive/worktrees/feat');
    const view = await resolveSpecView(ctx());
    expect(view.condensed).toBe(false);
    expect(view.text).toBe(LONG_SPEC);
  });

  it('never points at an artifact when there is no worktree', async () => {
    wireSteps(LONG_SPEC, null);
    const view = await resolveSpecView(ctx());
    expect(view.condensed).toBe(false);
    expect(view.text).toBe(LONG_SPEC);
  });

  it('sends the whole spec when condensing would drop nothing', async () => {
    const short = '# Feature\nonly line\n';
    wireSteps(short, '/repo/.haive/worktrees/feat');
    const view = await resolveSpecView(ctx());
    expect(view.condensed).toBe(false);
    expect(view.text).toBe(short);
  });

  it('degrades to the whole spec when the config read throws', async () => {
    configGet.mockRejectedValue(new Error('config backend down'));
    wireSteps(LONG_SPEC, '/repo/.haive/worktrees/feat');
    const view = await resolveSpecView(ctx());
    expect(view.condensed).toBe(false);
    expect(view.text).toBe(LONG_SPEC);
  });

  it('returns empty for a run with no spec', async () => {
    wireSteps('', '/repo/.haive/worktrees/feat');
    const view = await resolveSpecView(ctx());
    expect(view).toEqual({ text: '', spec: '', condensed: false });
  });

  it('honors the 05a -> 05 -> 04 precedence', async () => {
    loadPreviousStepOutput.mockImplementation(
      async (_db: unknown, _task: string, stepId: string) => {
        if (stepId === '05-phase-0b5-spec-quality') return { output: { spec: 'AMENDED' } };
        if (stepId === '04-phase-0b-pre-planning') return { output: { spec: 'DRAFT' } };
        return null;
      },
    );
    expect((await resolveSpecView(ctx(), { full: true })).spec).toBe('AMENDED');
  });
});
