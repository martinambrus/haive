import {
  CUSTOM_TOOL_DESCRIPTION_MAX_LENGTH,
  CUSTOM_TOOL_NAME_MAX_LENGTH,
  CUSTOM_TOOL_PARAM_DESCRIPTION_MAX_LENGTH,
  CUSTOM_TOOL_PARAMS_MAX,
  CUSTOM_TOOL_RESERVED_NAMES,
  CUSTOM_TOOL_RESPONSE_MAX_BYTES,
  CUSTOM_TOOL_RESPONSE_MIN_BYTES,
  CUSTOM_TOOL_TIMEOUT_MAX_MS,
  CUSTOM_TOOL_TIMEOUT_MIN_MS,
  CUSTOM_TOOL_URL_MAX_LENGTH,
  CUSTOM_TOOLS_MAX_PER_STEP,
  INTEGRATION_ID_MAX_LENGTH,
  INTEGRATIONS_MAX_PER_STEP,
  PROMPT_STEP_PROBLEM_KINDS,
  PROMPT_STEP_TEMPLATE_MAX_BYTES,
  PROMPT_STEP_TIMEOUT_MAX_MS,
  PROMPT_STEP_TIMEOUT_MIN_MS,
  RAG_QUERY_TOP_K_MAX,
  RAG_QUERY_TOP_K_MIN,
  REPOSITORY_TOKEN,
  STEP_ID_MAX_LENGTH,
  parseStepId,
  validateComposition,
  validateTaskTypeDefaults,
  type ComposableStepEntry,
  type CompositionIssue,
  type PromptStepIssue as CheckedPromptStepIssue,
  type PromptStepIssueKind as CheckedPromptStepIssueKind,
  type TaskTypeAvailability,
  type TaskTypeDefaultsIssue,
  type TaskTypeModuleRef,
} from '@haive/shared/modularity';
import type { TaskTypeCatalog } from './api-client';
import { inlineCode } from './project-state-conflicts';

export type CatalogEntries = ReadonlyMap<string, ComposableStepEntry>;

export interface StepRef {
  stepId: string;
  label: string;
}

export interface IssueView {
  message: string;
  providedBy: StepRef[];
}

export interface IssueContext {
  stepIds: readonly string[];
  catalog: CatalogEntries;
  requiresRepository: boolean;
}

export function catalogEntries(
  catalog: Pick<TaskTypeCatalog, 'steps'>,
): Map<string, ComposableStepEntry> {
  return new Map(catalog.steps.map((s) => [s.stepId, s.entry]));
}

export function stepLabel(stepId: string, catalog: CatalogEntries): string {
  return catalog.get(stepId)?.label ?? stepId;
}

export function providersOf(
  token: string,
  catalog: CatalogEntries,
  exceptStepId?: string,
): StepRef[] {
  const out: StepRef[] = [];
  for (const [stepId, entry] of catalog) {
    if (stepId !== exceptStepId && entry.provides.includes(token)) {
      out.push({ stepId, label: entry.label });
    }
  }
  return out;
}

const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

function joinOr(labels: string[]): string {
  return labels.length <= 1
    ? (labels[0] ?? '')
    : `${labels.slice(0, -1).join(', ')} or ${labels.at(-1)}`;
}

export function describeIssue(issue: CompositionIssue, ctx: IssueContext): IssueView {
  const { catalog } = ctx;
  const label = (id: string) => stepLabel(id, catalog);
  switch (issue.kind) {
    case 'empty':
      return { message: 'Add at least one step.', providedBy: [] };
    case 'unknown-step':
      return {
        message: `${issue.stepId} is not in the step catalog (removed or its module is off).`,
        providedBy: [],
      };
    case 'duplicate-step': {
      const first = ctx.stepIds.indexOf(issue.stepId);
      return { message: `${label(issue.stepId)} is already step ${first + 1}.`, providedBy: [] };
    }
    case 'unmet-need':
      if (issue.needs === REPOSITORY_TOKEN && !ctx.requiresRepository) {
        return {
          message: "Requires a repository: turn on 'Requires a repository' or remove this step.",
          providedBy: [],
        };
      }
      return {
        message: `Needs ${issue.needs} first: ${sentence(issue.reason)}`,
        providedBy: providersOf(issue.needs, catalog, issue.stepId),
      };
    case 'too-late': {
      const earlier = ctx.stepIds
        .slice(0, issue.index)
        .find((id) => catalog.get(id)?.provides.includes(issue.token));
      const tail = earlier ? `; currently after ${label(earlier)}.` : '.';
      return {
        message: `Must run before any step that provides ${issue.token}${tail}`,
        providedBy: [],
      };
    }
    case 'unfulfilled': {
      const providers = providersOf(issue.token, catalog, issue.stepId);
      const what =
        providers.length > 0
          ? joinOr(providers.map((p) => p.label))
          : `a step that provides ${issue.token}`;
      return {
        message: `Starts something that ${issue.token} must finish later: add ${what} after it.`,
        providedBy: providers,
      };
    }
    case 'missing-loop-target':
      return {
        message: `Loops back to ${label(issue.target)}, which must come earlier.`,
        providedBy: [{ stepId: issue.target, label: label(issue.target) }],
      };
    case 'loop-after-closing':
      return {
        message: `Its fix loop would return past ${label(issue.closingStepId)}, which closes the run; move it before that step.`,
        providedBy: [],
      };
  }
}

export function describeDefaultsIssue(
  issue: TaskTypeDefaultsIssue,
  catalog: CatalogEntries,
): string {
  if (issue.kind === 'loop-limit-not-editable') {
    return `${stepLabel(issue.stepId, catalog)} has no loop limit to set.`;
  }
  const what = issue.field === 'stepLoopLimitDefaults' ? 'A loop limit' : 'A preset answer';
  return `${what} is set for ${issue.stepId}, which is not in the list.`;
}

export function issuesByRow(issues: readonly CompositionIssue[]): Map<number, CompositionIssue[]> {
  const rows = new Map<number, CompositionIssue[]>();
  for (const issue of issues) {
    if (!('index' in issue)) continue;
    rows.set(issue.index, [...(rows.get(issue.index) ?? []), issue]);
  }
  return rows;
}

export function compositionProblems(input: {
  stepIds: readonly string[];
  loopLimits: Record<string, number>;
  catalog: CatalogEntries;
  requiresRepository: boolean;
}): { composition: CompositionIssue[]; defaults: TaskTypeDefaultsIssue[] } {
  return {
    composition: validateComposition(input.stepIds, input.catalog, {
      requiresRepository: input.requiresRepository,
    }),
    defaults: validateTaskTypeDefaults(
      { stepIds: input.stepIds, stepLoopLimitDefaults: input.loopLimits },
      input.catalog,
    ),
  };
}

const COMPOSITION_KINDS: ReadonlySet<string> = new Set<CompositionIssue['kind']>([
  'empty',
  'unknown-step',
  'unmet-need',
  'too-late',
  'unfulfilled',
  'missing-loop-target',
  'duplicate-step',
  'loop-after-closing',
]);
const DEFAULTS_KINDS: ReadonlySet<string> = new Set<TaskTypeDefaultsIssue['kind']>([
  'default-key-not-in-steps',
  'loop-limit-not-editable',
]);

/** Sorts an error body's `issues` by shape: composition and defaults issues carry `kind`, validation issues `path` and `message`. */
export function splitServerIssues(issues: unknown): {
  composition: CompositionIssue[];
  defaults: TaskTypeDefaultsIssue[];
  fields: { path: string; message: string }[];
} {
  const out = {
    composition: [] as CompositionIssue[],
    defaults: [] as TaskTypeDefaultsIssue[],
    fields: [] as { path: string; message: string }[],
  };
  if (!Array.isArray(issues)) return out;
  for (const item of issues as Record<string, unknown>[]) {
    if (typeof item?.kind === 'string') {
      if (COMPOSITION_KINDS.has(item.kind))
        out.composition.push(item as unknown as CompositionIssue);
      else if (DEFAULTS_KINDS.has(item.kind))
        out.defaults.push(item as unknown as TaskTypeDefaultsIssue);
    } else if (typeof item?.message === 'string') {
      out.fields.push({
        path: typeof item.path === 'string' ? item.path : '',
        message: item.message,
      });
    }
  }
  return out;
}

export function moduleNeedText(
  modules: readonly TaskTypeModuleRef[],
  reason: 'module-missing' | 'module-deactivated',
): string {
  const names = modules.map((m) => m.name ?? m.id);
  const several = names.length > 1;
  const list = several ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? '');
  const subject = names.length === 0 ? 'a module' : `the module${several ? 's' : ''} ${list}`;
  const state =
    reason === 'module-missing'
      ? `${several ? 'are' : 'is'} not installed`
      : 'an administrator turned off';
  return `needs ${subject}, which ${state}`;
}

export interface StepNote {
  text: string;
  warning: boolean;
}

export function describeStepWithoutEntry(
  stepId: string,
  ctx: { readOnly: boolean; catalog: Pick<TaskTypeCatalog, 'modules' | 'registeredStepIds'> },
): StepNote {
  const { readOnly, catalog } = ctx;
  const parsed = parseStepId(stepId);
  const owner =
    parsed?.kind === 'module' ? catalog.modules.find((m) => m.id === parsed.moduleId) : undefined;
  if (parsed?.kind === 'module') {
    const name = owner?.name ?? parsed.moduleId;
    if (owner === undefined || owner.state === 'missing') {
      return { text: `Provided by module ${name}, which is not installed`, warning: true };
    }
    if (owner.state === 'deactivated') {
      return {
        text: `Provided by module ${name}, which an administrator turned off`,
        warning: true,
      };
    }
  }
  const registryOwned = parsed?.kind === 'core' || parsed?.kind === 'module';
  if (registryOwned && !catalog.registeredStepIds.includes(stepId)) {
    return { text: 'Not registered on this install', warning: true };
  }
  if (owner !== undefined) {
    const text = readOnly ? `Module ${owner.name} step, not composable` : 'Not in the step catalog';
    return { text, warning: false };
  }
  return {
    text: readOnly ? 'Built-in step, not composable' : 'Not in the step catalog',
    warning: false,
  };
}

export function describeAvailability(availability: TaskTypeAvailability): string {
  if (availability.available) return 'Available';
  switch (availability.reason) {
    case 'disabled':
      return 'Unavailable: disabled';
    case 'not-selectable':
      return 'Unavailable: not selectable on the New Task page';
    case 'custom-types-off':
      return 'Unavailable: custom task types are switched off';
    case 'module-types-off':
      return 'Unavailable: module task types are switched off';
    case 'module-missing':
    case 'module-deactivated':
      return `Unavailable: ${moduleNeedText(availability.modules ?? [], availability.reason)}`;
    case 'missing-step':
      return `Unavailable: missing steps ${(availability.stepIds ?? []).join(', ')}`;
    case 'invalid-composition': {
      const n = availability.issues?.length ?? 0;
      return `Unavailable: the step list has ${n} problem${n === 1 ? '' : 's'}`;
    }
  }
}

export type PromptStepIssueKind = CheckedPromptStepIssueKind | 'template-empty' | 'title-empty';

export interface PromptStepIssue extends Omit<CheckedPromptStepIssue, 'kind' | 'message'> {
  kind: PromptStepIssueKind;
  message?: string;
}

const PROMPT_STEP_ISSUE_KINDS: ReadonlySet<string> = new Set<string>([
  ...PROMPT_STEP_PROBLEM_KINDS,
  'prompt-step-orphan',
  'prompt-step-missing',
]);

/** Picks the prompt-step issues out of an error body's `issues`, which `splitServerIssues` leaves alone. */
export function promptStepIssuesOf(issues: unknown): PromptStepIssue[] {
  if (!Array.isArray(issues)) return [];
  return (issues as Record<string, unknown>[]).filter(
    (item) =>
      typeof item?.kind === 'string' &&
      PROMPT_STEP_ISSUE_KINDS.has(item.kind) &&
      typeof item.stepId === 'string',
  ) as unknown as PromptStepIssue[];
}

export function describePromptStepIssue(issue: PromptStepIssue): string {
  const token = issue.raw ? inlineCode(issue.raw) : 'A token';
  const tool = issue.raw ? `The tool ${inlineCode(issue.raw)}` : 'A tool';
  const param = issue.param ? inlineCode(issue.param) : null;
  const integration = issue.raw ? `The integration ${inlineCode(issue.raw)}` : 'An integration';
  switch (issue.kind) {
    case 'title-empty':
      return 'Give the step a title.';
    case 'template-empty':
      return 'Write the prompt: the template is empty.';
    case 'unknown-token':
      return `${token} is not a template token. The tokens are \`task.title\`, \`task.description\`, \`field:<id>\`, \`step:<id>\` and \`agent:<id>\`.`;
    case 'field-not-declared':
      return `${token} names a field this step's form does not declare.`;
    case 'persona-id-invalid':
      return `${token} is not an agent id: use lowercase letters, digits and hyphens.`;
    case 'reserved-marker-in-template':
      return `The template may not contain ${inlineCode('[[HAIVE_')} or start with ${inlineCode('<haive_')}; both are reserved.`;
    case 'integration-token':
      return `${token} is not supported yet.`;
    case 'template-too-large':
      return `The template is over ${PROMPT_STEP_TEMPLATE_MAX_BYTES / 1024} KiB; shorten it.`;
    case 'timeout-out-of-range':
      return `The timeout must be between ${PROMPT_STEP_TIMEOUT_MIN_MS / 60_000} and ${PROMPT_STEP_TIMEOUT_MAX_MS / 60_000} minutes.`;
    case 'capability-not-allowed':
      return 'A capability on this step is not one a prompt step may have.';
    case 'persona-without-repository':
      return `${token} needs a repository to read the agent from: turn on 'Requires a repository' or remove the token.`;
    case 'file-write-without-repository':
      return "Writing files needs a repository: turn on 'Requires a repository' or untick 'Can write files'.";
    case 'step-id-too-long':
      return `The step id is longer than ${STEP_ID_MAX_LENGTH} characters; use a shorter task type slug.`;
    case 'step-token-not-earlier':
      return `${token} names a step that does not run before this one.`;
    case 'step-token-not-quotable':
      return `${token} names a step whose output can carry a person's words; only a step whose output an agent wrote can be quoted.`;
    case 'step-token-not-own-line':
      return `${token} must be alone on its line.`;
    case 'tool-no-longer-valid':
      return issue.raw
        ? `${tool} no longer passes its checks; fix it or remove it.`
        : 'More tools on this step no longer pass their checks; fix or remove them.';
    case 'too-many-tools':
      return `A step can have at most ${CUSTOM_TOOLS_MAX_PER_STEP} tools; remove some.`;
    case 'tool-name-invalid':
      return `${tool} needs a name that starts with a lowercase letter and uses only lowercase letters, digits and underscores, up to ${CUSTOM_TOOL_NAME_MAX_LENGTH} characters.`;
    case 'tool-name-reserved':
      return `${tool} has a name Haive keeps for its own tools (${CUSTOM_TOOL_RESERVED_NAMES.join(', ')}); pick another name.`;
    case 'tool-name-duplicate':
      return `${issue.raw ? `Two tools are named ${inlineCode(issue.raw)}` : 'Two tools have the same name'}; give each tool in a step its own name.`;
    case 'tool-description-invalid':
      return `${tool} needs a description of 1 to ${CUSTOM_TOOL_DESCRIPTION_MAX_LENGTH} characters with no control or invisible characters, so the agent knows when to call it.`;
    case 'tool-url-invalid':
      return `${tool} has a URL that is not valid: it must be one https:// address of at most ${CUSTOM_TOOL_URL_MAX_LENGTH} characters, with no spaces, control characters, backslashes or stray braces.`;
    case 'tool-url-not-https':
      return `${tool} must call an address that starts with https://.`;
    case 'tool-url-userinfo':
      return `${tool} has a user name or password in its URL; remove it, a tool never sends credentials.`;
    case 'tool-url-fragment':
      return `${tool} has a # fragment in its URL; remove it.`;
    case 'tool-host-ip-literal':
      return `${tool} calls an IP address; use the DNS name of the host instead.`;
    case 'tool-host-not-public':
      return `${tool} calls a host that is not a public DNS name: not localhost, not a name without a dot, and not one that ends in .local, .internal or .localhost.`;
    case 'tool-placeholder-outside-path':
      return `${tool} has a {placeholder} outside the path of its URL; a placeholder may only stand in the path, after the host.`;
    case 'tool-param-undeclared':
      return param
        ? `${tool} uses ${param} in its URL or query list but does not declare it as a parameter.`
        : `${tool} uses a name in its URL or query list that it does not declare as a parameter.`;
    case 'tool-param-unused':
      return param
        ? `${tool} declares the parameter ${param}, but its URL path and query list never use it.`
        : `${tool} declares a parameter that its URL path and query list never use.`;
    case 'tool-param-reused':
      return `${tool} uses ${param ? `the parameter ${param}` : 'a parameter'} more than once; each parameter goes once in the URL path or the query list.`;
    case 'tool-param-duplicate':
      return `${tool} declares two parameters ${param ? `named ${param}` : 'with the same name'}.`;
    case 'tool-param-invalid':
      return `${param ? `The parameter ${param}` : 'A parameter'} of ${issue.raw ? `the tool ${inlineCode(issue.raw)}` : 'a tool'} is not valid: its name follows the tool name rules, its description is 1 to ${CUSTOM_TOOL_PARAM_DESCRIPTION_MAX_LENGTH} characters, and its limits fit its type.`;
    case 'tool-too-many-params':
      return `${tool} has more than ${CUSTOM_TOOL_PARAMS_MAX} parameters; remove some.`;
    case 'tool-timeout-out-of-range':
      return `${tool} needs a timeout between ${CUSTOM_TOOL_TIMEOUT_MIN_MS / 1000} and ${CUSTOM_TOOL_TIMEOUT_MAX_MS / 1000} seconds.`;
    case 'tool-response-cap-out-of-range':
      return `${tool} needs a response size cap between ${CUSTOM_TOOL_RESPONSE_MIN_BYTES / 1024} and ${CUSTOM_TOOL_RESPONSE_MAX_BYTES / 1024} KiB.`;
    case 'tool-top-k-out-of-range':
      return `${tool} must return between ${RAG_QUERY_TOP_K_MIN} and ${RAG_QUERY_TOP_K_MAX} results.`;
    case 'tool-scope-needs-repository':
      return `${tool} searches the project, which needs a repository: turn on 'Requires a repository' or search the global knowledge base only.`;
    case 'too-many-integrations':
      return `A step can declare at most ${INTEGRATIONS_MAX_PER_STEP} integrations; remove some.`;
    case 'integration-provider-pinned':
      return `${integration} pins a provider; a prompt step names a category, and Haive resolves the account.`;
    case 'integration-category-duplicate':
      return `${integration} asks for a category that another integration of this step already asks for; a step gets one account per category.`;
    case 'integration-id-duplicate':
      return `${issue.raw ? `Two integrations are named ${inlineCode(issue.raw)}` : 'Two integrations have the same id'}; give each integration of a step its own id.`;
    case 'integration-id-invalid':
      return `${integration} needs an id that starts with a lowercase letter and uses only lowercase letters, digits and hyphens, up to ${INTEGRATION_ID_MAX_LENGTH} characters.`;
    case 'integration-category-unknown':
      return `${integration} asks for a category this install does not have.`;
    case 'integration-without-repository':
      return `${integration} works on a repository: turn on 'Requires a repository' or remove it.`;
    case 'integration-no-longer-valid':
      return issue.raw
        ? `${integration} no longer passes its checks; fix it or remove it.`
        : 'More integrations on this step no longer pass their checks; fix or remove them.';
    case 'prompt-step-orphan':
      return `${issue.stepId} is defined but is not in the step list.`;
    case 'prompt-step-missing':
      return `${issue.stepId} is in the step list but has no prompt step defined.`;
  }
}
