import type { PlanNodeTaskRole } from '@haive/shared';
import type { PublicTaskType } from '@haive/shared/modularity';
import { moduleNeedText } from './composition-messages';
import { SUMMARY_CLI_OFF } from './last-cli-choice';

export type NewTaskKind = 'workflow' | 'run_app' | 'custom';

export interface NewTaskTypeOption {
  value: string;
  kind: NewTaskKind;
  label: string;
  description: string | null;
  disabled: boolean;
  reason: string | null;
  requiresRepository: boolean;
  restoresDatabase: boolean;
  dispatchesCli: boolean;
}

const FORM_INFERS_THESE = new Set(['onboarding', 'onboarding_upgrade', 'workflow', 'run_app']);

const TURNED_OFF = 'this task type is turned off';

function missingStepText(missingStepIds: readonly string[]): string {
  if (missingStepIds.length === 0) return 'a step it needs is not installed';
  return missingStepIds.length === 1
    ? `a step it needs is not installed: ${missingStepIds[0]}`
    : `steps it needs are not installed: ${missingStepIds.join(', ')}`;
}

function unavailableText(row: PublicTaskType): string {
  switch (row.reason) {
    case undefined:
      return TURNED_OFF;
    case 'custom-types-off':
      return 'custom task types are turned off by an administrator';
    case 'module-types-off':
      return 'module task types are turned off by an administrator';
    case 'module-missing':
    case 'module-deactivated':
      return moduleNeedText(row.modules ?? [], row.reason);
    case 'missing-step':
      return missingStepText(row.missingStepIds ?? []);
    case 'invalid-composition':
      return 'its steps no longer fit together';
  }
}

const FIXED_OPTIONS: NewTaskTypeOption[] = [
  {
    value: 'workflow',
    kind: 'workflow',
    label: 'Workflow',
    description:
      'Run the autonomous workflow — onboarding for a fresh repo, the implementation workflow once onboarded.',
    disabled: false,
    reason: null,
    requiresRepository: true,
    restoresDatabase: true,
    dispatchesCli: true,
  },
  {
    value: 'run_app',
    kind: 'run_app',
    label: 'Run the app',
    description:
      'Bring the app up (DDEV / container) so you can browse, test, and edit it live. No code changes unless you commit at the end.',
    disabled: false,
    reason: null,
    requiresRepository: true,
    restoresDatabase: true,
    dispatchesCli: true,
  },
];

export function buildNewTaskTypeOptions(rows: readonly PublicTaskType[]): NewTaskTypeOption[] {
  const custom = rows
    .filter((r) => !FORM_INFERS_THESE.has(r.slug))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.slug.localeCompare(b.slug))
    .map((r): NewTaskTypeOption => ({
      value: r.slug,
      kind: 'custom',
      label: r.displayName,
      description: r.description,
      disabled: !r.available,
      reason: r.available ? null : unavailableText(r),
      requiresRepository: r.requiresRepository,
      restoresDatabase: r.restoresDatabase,
      dispatchesCli: r.dispatchesCli,
    }));
  // An empty list is one that has not loaded; a loaded one always carries the locked Workflow row.
  const runAppOff = rows.length > 0 && !rows.some((r) => r.slug === 'run_app');
  const fixed = FIXED_OPTIONS.map((o) =>
    o.kind === 'run_app' && runAppOff ? { ...o, disabled: true, reason: TURNED_OFF } : o,
  );
  return [...fixed, ...custom];
}

export interface NewTaskFields {
  repository: 'required' | 'optional';
  onboardingStatus: boolean;
  onboardingGate: boolean;
  planNodeLink: boolean;
  workflowFields: boolean;
  dumpUpload: boolean;
  cliPickers: boolean;
}

/** `inferred` is what a Workflow choice resolves to once the repository's onboarding status is known. */
export function newTaskFields(option: NewTaskTypeOption, inferred: string | null): NewTaskFields {
  if (option.kind === 'workflow') {
    return {
      repository: 'required',
      onboardingStatus: true,
      onboardingGate: true,
      planNodeLink: true,
      workflowFields: inferred === 'workflow',
      dumpUpload: inferred === 'workflow',
      cliPickers: true,
    };
  }
  if (option.kind === 'run_app') {
    return {
      repository: 'required',
      onboardingStatus: true,
      onboardingGate: false,
      planNodeLink: true,
      workflowFields: false,
      dumpUpload: true,
      cliPickers: true,
    };
  }
  return {
    repository: option.requiresRepository ? 'required' : 'optional',
    onboardingStatus: false,
    onboardingGate: false,
    planNodeLink: false,
    workflowFields: false,
    dumpUpload: option.restoresDatabase,
    cliPickers: option.dispatchesCli,
  };
}

/** `''` asks across every repository, for a type that needs none; null asks nothing. */
export function cliMemoryRepositoryId(fields: NewTaskFields, repositoryId: string): string | null {
  if (!fields.cliPickers) return null;
  return repositoryId || (fields.repository === 'optional' ? '' : null);
}

export interface NewTaskBodyInput {
  type: string;
  fields: NewTaskFields;
  title: string;
  repositoryId: string;
  description: string;
  estimatedTime: number | '';
  cliProviderId: string;
  ignoreSavedStepClis: boolean;
  summaryCliProviderId: string;
  planNodeIds: string[];
  planNodeRole: PlanNodeTaskRole;
  overrideBlocked: boolean;
  fromPlanChat: boolean;
  isBugFix: boolean;
  feature: string;
  affectedClients: string;
  parentTaskId: string;
}

export function buildNewTaskBody(input: NewTaskBodyInput): Record<string, unknown> {
  const { fields } = input;
  const body: Record<string, unknown> = { type: input.type, title: input.title };
  if (input.repositoryId) body.repositoryId = input.repositoryId;
  if (input.description.trim()) body.description = input.description.trim();
  if (
    input.estimatedTime !== '' &&
    Number.isFinite(input.estimatedTime) &&
    input.estimatedTime > 0
  ) {
    body.estimatedTimeHours = input.estimatedTime;
  }
  if (fields.cliPickers) {
    // Always sent, empty included: naming the field is how the server learns the
    // choice was stated rather than defaulted, which is what makes it stick for the
    // next task on this repo (tasks.cli_choice_recorded).
    body.cliProviderId = input.cliProviderId || null;
    if (input.ignoreSavedStepClis) body.ignoreSavedStepClis = true;
    body.summaryLlmEnabled = input.summaryCliProviderId !== SUMMARY_CLI_OFF;
    body.summaryCliProviderId =
      input.summaryCliProviderId && input.summaryCliProviderId !== SUMMARY_CLI_OFF
        ? input.summaryCliProviderId
        : null;
  }
  if (fields.planNodeLink) {
    if (input.planNodeIds.length > 0) {
      body.planNodeIds = input.planNodeIds;
      body.planNodeRole = input.planNodeRole;
      if (input.overrideBlocked) body.overrideBlocked = true;
    }
    if (input.fromPlanChat) body.fromPlanChat = true;
  }
  if (fields.workflowFields) {
    body.isBugFix = input.isBugFix;
    if (input.feature.trim()) body.feature = input.feature.trim();
    const clients = input.affectedClients
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
    if (clients.length > 0) body.affectedClients = clients;
    if (input.isBugFix && input.parentTaskId) body.parentTaskId = input.parentTaskId;
  }
  return body;
}
