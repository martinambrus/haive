import { describe, it, expect } from 'vitest';
import {
  BUILTIN_STEP_PANELS,
  resolveStepPanels,
  type PanelContext,
  type PanelSlot,
  type StepPanelTable,
  type UiPanelSpec,
} from './step-panels';

const VERIFY = '08a-browser-verify';
const RUN_APP = '99-run-app-ready';
const GATE2 = '09-gate-2-verify-approval';
const GATE3 = '10-gate-3-commit';

const ctx = (over: Partial<PanelContext> = {}): PanelContext => ({
  formOpen: false,
  runtimeTornDown: false,
  status: 'done',
  activeRole: null,
  hasSchema: false,
  ...over,
});

const form = (over: Partial<PanelContext> = {}): PanelContext =>
  ctx({ formOpen: true, status: 'waiting_form', hasSchema: true, ...over });

const kinds = (stepId: string, slot: PanelSlot, c: PanelContext): string[] =>
  resolveStepPanels(stepId, slot, c).map((s: UiPanelSpec) => s.kind);

describe('resolveStepPanels: 08a-browser-verify', () => {
  it('form open: live browser then screenshots in the header, nothing else', () => {
    const c = form();
    expect(kinds(VERIFY, 'formHeader', c)).toEqual(['liveBrowser', 'screenshots']);
    expect(kinds(VERIFY, 'formBeforeFields', c)).toEqual([]);
    expect(kinds(VERIFY, 'cardFooter', c)).toEqual([]);
  });

  it('form open under the fixer: header empty, fixer notice in the footer', () => {
    const c = form({ activeRole: 'fixer' });
    expect(kinds(VERIFY, 'formHeader', c)).toEqual([]);
    expect(kinds(VERIFY, 'cardFooter', c)).toEqual(['fixerNotice']);
  });

  it('running: browser and screenshots in the footer', () => {
    const c = ctx({ status: 'running' });
    expect(kinds(VERIFY, 'cardFooter', c)).toEqual(['liveBrowser', 'screenshots']);
    expect(kinds(VERIFY, 'formHeader', c)).toEqual([]);
  });

  it('waiting_cli under the fixer: notice and screenshots, no live browser', () => {
    const c = ctx({ status: 'waiting_cli', activeRole: 'fixer' });
    expect(kinds(VERIFY, 'cardFooter', c)).toEqual(['screenshots', 'fixerNotice']);
  });

  it('done and failed: screenshots only', () => {
    expect(kinds(VERIFY, 'cardFooter', ctx({ status: 'done' }))).toEqual(['screenshots']);
    expect(kinds(VERIFY, 'cardFooter', ctx({ status: 'failed' }))).toEqual(['screenshots']);
  });

  it('waiting_form status without an open form (no schema): footer shows nothing', () => {
    const c = ctx({ status: 'waiting_form', hasSchema: false });
    expect(kinds(VERIFY, 'cardFooter', c)).toEqual([]);
  });

  it('runtime torn down: only the fixer notice survives, and only for the fixer', () => {
    expect(kinds(VERIFY, 'cardFooter', ctx({ runtimeTornDown: true }))).toEqual([]);
    expect(
      kinds(VERIFY, 'cardFooter', ctx({ runtimeTornDown: true, activeRole: 'fixer' })),
    ).toEqual(['fixerNotice']);
    expect(kinds(VERIFY, 'formHeader', form({ runtimeTornDown: true }))).toEqual([]);
  });
});

describe('resolveStepPanels: 99-run-app-ready', () => {
  it('form open: the run-app viewer before the fields', () => {
    expect(kinds(RUN_APP, 'formBeforeFields', form())).toEqual(['runAppReady']);
    expect(kinds(RUN_APP, 'formHeader', form())).toEqual([]);
    expect(kinds(RUN_APP, 'cardFooter', form())).toEqual([]);
  });

  it('runtime torn down: nothing', () => {
    expect(kinds(RUN_APP, 'formBeforeFields', form({ runtimeTornDown: true }))).toEqual([]);
  });

  it('no open form: nothing', () => {
    expect(kinds(RUN_APP, 'formBeforeFields', ctx())).toEqual([]);
  });
});

describe('resolveStepPanels: 09-gate-2-verify-approval', () => {
  it('form open: live browser with its title, then detect screenshots', () => {
    const specs = resolveStepPanels(GATE2, 'formBeforeFields', form());
    expect(specs.map((s) => s.kind)).toEqual(['liveBrowser', 'screenshots']);
    expect(specs[0]).toMatchObject({ title: 'Browser — test the app here' });
    expect(specs[1]).toMatchObject({ from: 'detect' });
  });

  it('done: nothing', () => {
    expect(kinds(GATE2, 'formBeforeFields', ctx())).toEqual([]);
    expect(kinds(GATE2, 'cardFooter', ctx())).toEqual([]);
  });

  it('runtime torn down with the form open: nothing, so a knowledge diff may render', () => {
    expect(kinds(GATE2, 'formBeforeFields', form({ runtimeTornDown: true }))).toEqual([]);
  });

  it('declares a before-fields panel whenever the runtime is up, which suppresses the knowledge diff', () => {
    expect(resolveStepPanels(GATE2, 'formBeforeFields', form()).length).toBeGreaterThan(0);
  });
});

describe('resolveStepPanels: 10-gate-3-commit', () => {
  it('waiting_form without a schema: hidden', () => {
    expect(kinds(GATE3, 'cardFooter', ctx({ status: 'waiting_form' }))).toEqual([]);
  });

  it('with a schema: the diff', () => {
    expect(kinds(GATE3, 'cardFooter', form())).toEqual(['artifactDiff']);
  });

  it('done and skipped: the diff', () => {
    expect(kinds(GATE3, 'cardFooter', ctx({ status: 'done' }))).toEqual(['artifactDiff']);
    expect(kinds(GATE3, 'cardFooter', ctx({ status: 'skipped' }))).toEqual(['artifactDiff']);
  });

  it('does not depend on the runtime', () => {
    expect(kinds(GATE3, 'cardFooter', ctx({ status: 'done', runtimeTornDown: true }))).toEqual([
      'artifactDiff',
    ]);
  });

  it('reads detect.diffArtifactPath', () => {
    expect(resolveStepPanels(GATE3, 'cardFooter', ctx())[0]).toMatchObject({
      key: 'diffArtifactPath',
    });
  });
});

describe('resolveStepPanels: steps without panels', () => {
  it.each(['11b-kb-commit', '03c-business-requirements-review', 'module.x.y', 'custom.a.b'])(
    '%s resolves to nothing in every slot',
    (stepId) => {
      for (const slot of ['formHeader', 'formBeforeFields', 'cardFooter'] as const) {
        expect(kinds(stepId, slot, form())).toEqual([]);
        expect(kinds(stepId, slot, ctx())).toEqual([]);
      }
    },
  );

  it('takes a caller-supplied table, so a later step declares data rather than a branch', () => {
    const table: StepPanelTable = {
      'module.x.y': [{ kind: 'runAppReady', slot: 'formBeforeFields', gates: ['form-open'] }],
    };
    expect(
      resolveStepPanels('module.x.y', 'formBeforeFields', form(), table).map((s) => s.kind),
    ).toEqual(['runAppReady']);
  });

  it('the built-in table covers exactly the four panel-bearing core steps', () => {
    expect(Object.keys(BUILTIN_STEP_PANELS).sort()).toEqual([VERIFY, RUN_APP, GATE2, GATE3].sort());
  });
});
