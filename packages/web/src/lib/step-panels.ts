export type PanelSlot = 'formHeader' | 'formBeforeFields' | 'cardFooter';

export type PanelGate =
  | 'form-open'
  | 'runtime-up'
  | 'not-fixer'
  | 'fixer'
  | 'live-run'
  | 'not-in-form'
  | 'schema-or-closed';

interface PanelBase {
  slot: PanelSlot;
  gates: readonly PanelGate[];
}

export type UiPanelSpec =
  | (PanelBase & { kind: 'liveBrowser'; title?: string; splitTerminal?: boolean })
  | (PanelBase & { kind: 'screenshots'; from: 'output' | 'detect' })
  | (PanelBase & { kind: 'runAppReady' })
  | (PanelBase & { kind: 'artifactDiff'; key: 'diffArtifactPath' })
  | (PanelBase & { kind: 'fixerNotice' });

export interface PanelContext {
  formOpen: boolean;
  runtimeTornDown: boolean;
  status: string;
  activeRole: string | null | undefined;
  hasSchema: boolean;
}

export type StepPanelTable = Readonly<Record<string, readonly UiPanelSpec[]>>;

export const BUILTIN_STEP_PANELS: StepPanelTable = {
  '08a-browser-verify': [
    {
      kind: 'liveBrowser',
      slot: 'formHeader',
      gates: ['form-open', 'runtime-up', 'not-fixer'],
      splitTerminal: true,
    },
    {
      kind: 'screenshots',
      slot: 'formHeader',
      gates: ['form-open', 'runtime-up', 'not-fixer'],
      from: 'output',
    },
    {
      kind: 'liveBrowser',
      slot: 'cardFooter',
      gates: ['runtime-up', 'live-run', 'not-fixer'],
      splitTerminal: true,
    },
    {
      kind: 'screenshots',
      slot: 'cardFooter',
      gates: ['runtime-up', 'not-in-form'],
      from: 'output',
    },
    { kind: 'fixerNotice', slot: 'cardFooter', gates: ['fixer'] },
  ],
  '99-run-app-ready': [
    { kind: 'runAppReady', slot: 'formBeforeFields', gates: ['form-open', 'runtime-up'] },
  ],
  '09-gate-2-verify-approval': [
    {
      kind: 'liveBrowser',
      slot: 'formBeforeFields',
      gates: ['form-open', 'runtime-up'],
      title: 'Browser — test the app here',
    },
    {
      kind: 'screenshots',
      slot: 'formBeforeFields',
      gates: ['form-open', 'runtime-up'],
      from: 'detect',
    },
  ],
  '10-gate-3-commit': [
    // The form is built after the pre-form LLM finishes; hiding the diff until then keeps an
    // already visible viewer from moving when the terminal above it mounts.
    {
      kind: 'artifactDiff',
      slot: 'cardFooter',
      gates: ['schema-or-closed'],
      key: 'diffArtifactPath',
    },
  ],
};

function gateHolds(gate: PanelGate, ctx: PanelContext): boolean {
  switch (gate) {
    case 'form-open':
      return ctx.formOpen;
    case 'runtime-up':
      return !ctx.runtimeTornDown;
    case 'not-fixer':
      return ctx.activeRole !== 'fixer';
    case 'fixer':
      return ctx.activeRole === 'fixer';
    case 'live-run':
      return ctx.status !== 'failed' && ctx.status !== 'done' && ctx.status !== 'waiting_form';
    case 'not-in-form':
      return ctx.status !== 'waiting_form';
    case 'schema-or-closed':
      return ctx.hasSchema || ctx.status === 'done' || ctx.status === 'skipped';
  }
}

export function resolveStepPanels(
  stepId: string,
  slot: PanelSlot,
  ctx: PanelContext,
  table: StepPanelTable = BUILTIN_STEP_PANELS,
): UiPanelSpec[] {
  return (table[stepId] ?? []).filter(
    (spec) => spec.slot === slot && spec.gates.every((gate) => gateHolds(gate, ctx)),
  );
}
