import {
  COMPOSABLE_STEP_GROUPS,
  PROMPT_STEP_CAPABILITIES,
  PROMPT_STEP_DRAFTABLE_KEYS,
  PROMPT_STEP_TEMPLATE_MAX_BYTES,
  PROMPT_STEP_TIMEOUT_MAX_MS,
  PROMPT_STEP_TIMEOUT_MIN_MS,
  PROMPT_STEP_TITLE_MAX_LENGTH,
  STEP_ID_MAX_LENGTH,
  TYPE_DRAFT_MESSAGE_EVENT,
  TYPE_DRAFT_STATE_MAX_BYTES,
  pickTaskTypeDraft,
  validateTaskTypeDraft,
  type ComposableStepEntry,
  type TaskTypeDraftIssue,
  type TaskTypeDraftWarning,
} from '@haive/shared/modularity';
import { recentTurns } from '../../../plan/transcript.js';
import {
  REPO_IS_DATA_AUTHORING_LINES,
  UNTRUSTED_FENCE_LEGEND,
  fencedAgentBlock,
  safeNote,
} from '../_untrusted-repo.js';
import { parseAgentJson } from '../workflow/_agent-json.js';

export const TYPE_DRAFT_REPAIR_EVENT = 'type_draft.repair';
const HISTORY_MAX_CHARS = 24_000;
const ISSUE_LINES_MAX = 40;
const NO_WORDS = 'Here is a draft.';

type DraftRecord = Record<string, unknown>;

export interface DraftCatalogStep {
  entry: ComposableStepEntry;
  description: string;
}

export interface DraftPersona {
  id: string;
  title: string;
  description: string;
  framework: string | null;
}

export interface DraftVerdict {
  reply: string;
  draft: DraftRecord | null;
  issues: TaskTypeDraftIssue[];
  warnings: TaskTypeDraftWarning[];
  dropped: string[];
}

export interface TypeDraftDetect {
  steps: DraftCatalogStep[];
  personas: DraftPersona[];
  transcript: { role: 'user' | 'assistant'; body: string }[];
  /** The newest user message with no agent turn after it; null once the conversation is up to date. */
  pendingQuestion: string | null;
  currentDraft: { from: 'editor' | 'assistant'; draft: DraftRecord } | null;
  /** The first attempt of this turn, when it failed the checks and its one repair is still to run. */
  repairPending: (DraftVerdict & { draft: DraftRecord }) | null;
}

const isRecord = (value: unknown): value is DraftRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function pickedState(state: DraftRecord): DraftRecord | null {
  const { draft } = pickTaskTypeDraft(state);
  return Object.keys(draft).length > 0 ? draft : null;
}

function readRepair(p: DraftRecord): TypeDraftDetect['repairPending'] {
  if (!isRecord(p.draft)) return null;
  return {
    reply: typeof p.reply === 'string' ? p.reply : '',
    draft: p.draft,
    issues: Array.isArray(p.issues) ? (p.issues as TaskTypeDraftIssue[]) : [],
    warnings: Array.isArray(p.warnings) ? (p.warnings as TaskTypeDraftWarning[]) : [],
    dropped: Array.isArray(p.dropped)
      ? p.dropped.filter((d): d is string => typeof d === 'string')
      : [],
  };
}

export function deriveConversation(
  rows: readonly { eventType: string; payload: unknown }[],
): Pick<TypeDraftDetect, 'transcript' | 'pendingQuestion' | 'currentDraft' | 'repairPending'> {
  const transcript: TypeDraftDetect['transcript'] = [];
  let editor: DraftRecord | null = null;
  let agent: DraftRecord | null = null;
  let repair: TypeDraftDetect['repairPending'] = null;
  for (const { eventType, payload } of rows) {
    if (!isRecord(payload)) continue;
    if (eventType === TYPE_DRAFT_REPAIR_EVENT) {
      repair = readRepair(payload);
    } else if (
      eventType === TYPE_DRAFT_MESSAGE_EVENT &&
      (payload.role === 'user' || payload.role === 'assistant')
    ) {
      transcript.push({
        role: payload.role,
        body: typeof payload.body === 'string' ? payload.body : '',
      });
      repair = null;
      if (payload.role === 'user') {
        editor =
          isRecord(payload.draft) &&
          Buffer.byteLength(JSON.stringify(payload.draft), 'utf8') <= TYPE_DRAFT_STATE_MAX_BYTES
            ? pickedState(payload.draft)
            : null;
      } else if (isRecord(payload.draft)) {
        agent = payload.draft;
      }
    }
  }
  const last = transcript.at(-1);
  if (last?.role !== 'user') {
    return { transcript, pendingQuestion: null, currentDraft: null, repairPending: null };
  }
  const currentDraft = editor
    ? { from: 'editor' as const, draft: editor }
    : agent
      ? { from: 'assistant' as const, draft: agent }
      : null;
  return { transcript, pendingQuestion: last.body, currentDraft, repairPending: repair };
}

export function parseDraftReply(raw: unknown): { reply: string; draft: DraftRecord | null } | null {
  return parseAgentJson(raw, (candidate) => {
    if (!isRecord(candidate)) return null;
    const { reply, draft } = candidate;
    if (draft !== undefined && draft !== null && !isRecord(draft)) return null;
    const words = typeof reply === 'string' ? reply.trim() : '';
    if (!isRecord(draft)) return words ? { reply: words, draft: null } : null;
    return { reply: words || NO_WORDS, draft };
  });
}

export function readEditorState(raw: unknown): {
  draft: DraftRecord | null;
  ignored?: 'not-json' | 'too-large';
} {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return { draft: null };
  if (Buffer.byteLength(text, 'utf8') > TYPE_DRAFT_STATE_MAX_BYTES) {
    return { draft: null, ignored: 'too-large' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { draft: null, ignored: 'not-json' };
  }
  if (!isRecord(parsed)) return { draft: null, ignored: 'not-json' };
  return { draft: pickedState(parsed) };
}

export function catalogSets(steps: readonly DraftCatalogStep[]) {
  return {
    stepIds: new Set(steps.map((s) => s.entry.stepId)),
    dispatchesCli: new Set(steps.filter((s) => s.entry.dispatchesCli).map((s) => s.entry.stepId)),
    composable: new Map(steps.map((s) => [s.entry.stepId, s.entry] as const)),
  };
}

export function judgeDraftReply(
  parsed: { reply: string; draft: unknown },
  d: Pick<TypeDraftDetect, 'steps' | 'personas'>,
): DraftVerdict {
  if (parsed.draft === null) {
    return { reply: parsed.reply, draft: null, issues: [], warnings: [], dropped: [] };
  }
  const { draft, dropped } = pickTaskTypeDraft(parsed.draft);
  const { issues, warnings } = validateTaskTypeDraft(
    draft,
    catalogSets(d.steps),
    d.personas.map((p) => p.id),
  );
  return { reply: parsed.reply, draft, issues, warnings, dropped };
}

const at = (index: number | undefined): string =>
  index === undefined ? '' : ` (stepIds[${index}])`;

function issueText(issue: TaskTypeDraftIssue): string {
  if ('path' in issue) return `${issue.path || 'the draft'}: ${issue.message}`;
  if ('message' in issue) return `${issue.stepId}${at(issue.index)}: ${issue.message}`;
  switch (issue.kind) {
    case 'unknown-step':
      return `\`${issue.stepId}\`${at(issue.index)} is neither a catalog step nor a prompt step of this type.`;
    case 'unmet-need':
      return `\`${issue.stepId}\`${at(issue.index)} needs \`${issue.needs}\`, which no earlier step provides: ${issue.reason}`;
    case 'too-late':
      return `\`${issue.stepId}\`${at(issue.index)} must come BEFORE any step that provides \`${issue.token}\`, and one already did.`;
    case 'unfulfilled':
      return `\`${issue.stepId}\`${at(issue.index)} needs a LATER step that provides \`${issue.token}\`, and none follows.`;
    case 'missing-loop-target':
      return `\`${issue.stepId}\`${at(issue.index)} loops back to \`${issue.target}\`, which must be listed EARLIER.`;
    case 'duplicate-step':
      return `\`${issue.stepId}\`${at(issue.index)} is listed more than once.`;
    case 'loop-after-closing':
      return `\`${issue.stepId}\`${at(issue.index)} loops back to a step before \`${issue.closingStepId}\`, which closes the type.`;
    case 'empty':
      return 'stepIds is empty: list at least one step.';
    case 'default-key-not-in-steps':
      return `${issue.field} names \`${issue.stepId}\`, which is not in stepIds.`;
    case 'loop-limit-not-editable':
      return `stepLoopLimitDefaults names \`${issue.stepId}\`, whose loop budget cannot be set: remove it.`;
  }
}

export function describeDraftIssue(issue: TaskTypeDraftIssue): string {
  return safeNote(issueText(issue));
}

export const DRAFT_EXAMPLE = {
  reply:
    'I drafted a read-only type with one step that finds TODO and FIXME comments and rates how urgent each is. Tell me if you want a second step that proposes fixes.',
  draft: {
    slug: 'todo-audit',
    displayName: 'TODO audit',
    description: 'Finds TODO and FIXME comments in the repository and rates how urgent each is.',
    requiresRepository: true,
    stepIds: ['custom.todo-audit.rate-todos'],
    promptSteps: {
      'rate-todos': {
        slug: 'rate-todos',
        title: 'Find and rate TODO comments',
        template:
          'Find every TODO and FIXME comment in this repository, for the task "{{task.title}}".\n\nFor each one give the file and line, quote the comment, and rate how urgent it is as high, medium or low with one sentence of reasoning. Report only; change nothing.',
        capabilities: ['tool_use'],
        timeoutMs: 600_000,
      },
    },
  },
};

const quoted = (tokens: readonly string[]): string => tokens.map((t) => `\`${t}\``).join(', ');

function stepLines({ entry: e, description }: DraftCatalogStep): string[] {
  const facts = (label: string, tokens: readonly string[] | undefined) =>
    tokens && tokens.length > 0 ? [`    ${label}: ${quoted(tokens)}`] : [];
  return [
    `- \`${e.stepId}\` — ${safeNote(e.label)}${e.dispatchesCli ? ' (runs an agent)' : ''}${e.agentAuthoredOutput ? ' (quotable)' : ''}`,
    ...(description ? [`    ${safeNote(description)}`] : []),
    ...e.requires.map((r) => `    needs \`${r.needs}\` (${safeNote(r.reason)})`),
    ...facts('provides', e.provides),
    ...facts('removes', e.removes),
    ...facts('must come before any step that provides', e.precedes),
    ...facts('a later step must provide', e.entails),
    ...(e.entailsWhen ?? []).map(
      (r) =>
        `    once \`${r.provided}\` is provided, a later step must provide: ${quoted(r.entails)}`,
    ),
    ...(e.loopTargetStepId
      ? [`    loops back to \`${e.loopTargetStepId}\`, which must be listed earlier`]
      : []),
    ...(e.closes ? ['    closes the type: nothing may loop back past it'] : []),
    ...(e.loopBudgetEditable ? ['    loop budget editable in stepLoopLimitDefaults'] : []),
  ];
}

function catalogLines(steps: readonly DraftCatalogStep[]): string[] {
  const named = [...COMPOSABLE_STEP_GROUPS].sort((a, b) => a.order - b.order);
  const known = new Set<string>(named.map((g) => g.id));
  const other = [...new Set(steps.map((s) => s.entry.group))].filter((g) => !known.has(g)).sort();
  return [...named, ...other.map((id) => ({ id, label: id }))].flatMap(({ id, label }) => {
    const inGroup = steps.filter((s) => s.entry.group === id);
    return inGroup.length > 0 ? [`### ${label}`, ...inGroup.flatMap(stepLines), ''] : [];
  });
}

function personaLines(personas: readonly DraftPersona[]): string[] {
  return personas.map(
    (p) =>
      `- \`${p.id}\` — ${safeNote(p.title)}: ${safeNote(p.description)}${p.framework ? ` (repositories of the ${p.framework} framework only)` : ''}`,
  );
}

function currentDraftLines(current: TypeDraftDetect['currentDraft']): string[] {
  if (!current) return ['There is no draft yet.'];
  return [
    current.from === 'editor'
      ? "This is the task type as it stands in the administrator's editor right now. They may have edited it by hand since your last reply: keep their changes unless they ask you to undo them."
      : 'This is your draft from your previous reply. The administrator may have changed it in their editor since; if so, that state was not sent.',
    '',
    fencedAgentBlock(JSON.stringify(current.draft, null, 2)),
    '',
    'Keep the slug of the current draft exactly as it is. Propose a slug only when there is no draft or its slug is empty.',
  ];
}

function repairLines(repair: NonNullable<TypeDraftDetect['repairPending']>): string[] {
  const shown = repair.issues.slice(0, ISSUE_LINES_MAX);
  const more = repair.issues.length - shown.length;
  return [
    "## The draft you just sent FAILED Haive's checks",
    'The administrator has not seen it. It is below, then what Haive found wrong with it.',
    '',
    fencedAgentBlock(JSON.stringify(repair.draft, null, 2)),
    '',
    "What Haive found. The wording is Haive's own; a name in backticks or braces is quoted from your draft:",
    ...shown.map((issue) => `- ${describeDraftIssue(issue)}`),
    ...(more > 0 ? [`- and ${more} more of the same kinds`] : []),
    '',
    'Send the corrected COMPLETE draft in the same JSON shape. Write "reply" as your answer to the',
    "administrator's latest message: it is shown in place of your earlier reply, so do not mention",
    'the correction.',
    '',
  ];
}

const PROMPT_STEP_KEYS = quoted(PROMPT_STEP_DRAFTABLE_KEYS);
const TIMEOUT_RANGE = `${PROMPT_STEP_TIMEOUT_MIN_MS} to ${PROMPT_STEP_TIMEOUT_MAX_MS}`;

export function buildDraftPrompt(d: TypeDraftDetect): string {
  const history = recentTurns(d.transcript, HISTORY_MAX_CHARS, { keepNewest: true });
  return [
    'You are helping an administrator of Haive design a TASK TYPE, in conversation. A task type is a',
    'named, ordered list of steps that Haive runs one after another on a task. A step is either a',
    'catalog step, built into Haive and listed below, or a PROMPT STEP: a prompt written for this',
    'type that Haive hands to an AI agent when the step runs.',
    '',
    'You have no repository, no tools and no network in this conversation, and nothing you write here',
    'is saved or run. The administrator reviews your draft in the task type editor and saves it',
    'themselves. Everything you need is in this prompt.',
    '',
    REPO_IS_DATA_AUTHORING_LINES.join('\n'),
    '',
    UNTRUSTED_FENCE_LEGEND.join('\n'),
    '',
    '## How you answer',
    'Reply with ONE JSON object and nothing outside it, in the language the administrator writes in:',
    '{"reply": "<markdown for the administrator>", "draft": <a complete draft, or null>}',
    '- "reply" is what the administrator reads. Say what the draft is or what you changed, or ask your',
    '  question. Never claim a change the "draft" does not contain.',
    '- "draft" is the COMPLETE task type every time, never a patch: it replaces your previous draft.',
    '  Send null when you need to ask the administrator something first, or when their message asks',
    '  for no change.',
    '',
    '## The draft',
    '- `slug`: lowercase letters, digits and hyphens, at most 64 characters, starting with a letter or',
    '  a digit. `new` and `catalog` are reserved, and the name of an existing task type is taken.',
    '- `displayName`: the name people see; not empty.',
    '- `description`: optional; one or two sentences.',
    '- `requiresRepository`: true when the type runs on a repository, which its steps may then read;',
    '  false when it runs without one. Without a repository no step may need one, no template may use',
    '  an `{{agent:...}}` token, and no prompt step may have the `file_write` capability.',
    '- `stepIds`: the steps in run order; at least one, none twice. A catalog step is named by its id',
    '  below. A prompt step of this type is named `custom.<type slug>.<step slug>`, and the whole id',
    `  is at most ${STEP_ID_MAX_LENGTH} characters.`,
    '- `promptSteps`: an object with one entry, keyed by its step slug, for EVERY `custom.` id in',
    '  `stepIds` and for no other. It may be left out when `stepIds` names no prompt step.',
    `- each prompt step has exactly these keys: ${PROMPT_STEP_KEYS}.`,
    '  - `slug`: the key it sits under; lowercase letters, digits and hyphens, starting with a letter',
    '    or a digit.',
    `  - \`title\`: 1 to ${PROMPT_STEP_TITLE_MAX_LENGTH} characters.`,
    `  - \`template\`: the prompt, at most ${PROMPT_STEP_TEMPLATE_MAX_BYTES / 1024} KiB; its rules are below.`,
    `  - \`capabilities\`: a list of ${quoted(PROMPT_STEP_CAPABILITIES)}. \`tool_use\` lets the agent use`,
    '    its tools, for example to read the repository. `file_write` lets it edit files. `vision` lets',
    '    it read images. Use [] for a step that answers from its prompt alone.',
    `  - \`timeoutMs\`: a whole number of milliseconds, ${TIMEOUT_RANGE}; 600000 suits most steps.`,
    '- `stepLoopLimitDefaults`: optional; maps a step id in `stepIds` to a whole number from 1 to 50,',
    '  only for a step marked "loop budget editable" below.',
    'Nothing else is read. In particular never send `tools`, `agentPool`, `paramFormSchema`, a prompt',
    'step `description`, `enabled`, `selectable`, `sortOrder` or `preAnswerDefaults`: the editor cannot',
    'show them and they are dropped. Custom tools are written by the administrator by hand; never',
    'propose one.',
    '',
    '## Prompt step templates',
    'A template is plain text for an agent. These tokens, each in double braces, are filled in when the',
    'step runs; any other double-brace text is refused:',
    "- `{{task.title}}` and `{{task.description}}`: the task's title and description.",
    '- `{{step:<step id>}}`: the recorded output of an EARLIER step of this type, on a line of its own.',
    '  It may name a prompt step of this type that comes earlier, or an earlier catalog step marked',
    '  "quotable" below.',
    '- `{{agent:<persona id>}}`: gives the agent that persona. Only in a type with requiresRepository',
    '  true, and only ids from the persona list below.',
    'This version has no form fields: `{{field:...}}` and `{{integration:...}}` are refused.',
    'Write each template as a complete assignment for an agent that sees nothing else: what to do, what',
    'to look at, what to produce and in what format. If a later step quotes this step, say exactly what',
    'format its output must have.',
    '',
    '## How steps fit together',
    'A FACT is a named thing that is true of a run so far, such as `worktree` or `commit`. Haive',
    'walks `stepIds` in order and checks each catalog step against the facts at that point:',
    '- `needs X`: X must be provided by an EARLIER step. `repository` is provided from the start when',
    '  requiresRepository is true, and never otherwise.',
    '- `provides`: those facts are true from this step on. `removes`: they stop being true after it.',
    '- `must come before any step that provides X`: this step may not follow a step that provides X.',
    '- `a later step must provide X`: some step after this one has to provide X.',
    '- `loops back to S`: S must be listed EARLIER. `closes the type`: no step after it may loop back',
    '  to a step before it.',
    '- A prompt step provides nothing. Without `file_write` it needs `repository` when',
    '  requiresRepository is true and nothing otherwise. With `file_write` it needs `worktree` and',
    '  removes `clean-tree`.',
    'Keep the list as short as the request needs. A type may be a single prompt step.',
    '',
    '## Catalog steps you may use',
    ...catalogLines(d.steps),
    '## Personas for `{{agent:<id>}}`',
    ...personaLines(d.personas),
    '',
    '## An example reply (the shape only: do not reuse its content)',
    JSON.stringify(DRAFT_EXAMPLE),
    '',
    '## The conversation so far',
    history || '(this is the first message)',
    '',
    '## The current draft',
    ...currentDraftLines(d.currentDraft),
    '',
    ...(d.repairPending ? repairLines(d.repairPending) : []),
    '## What to do',
    "Answer the administrator's latest message. If it asks for a task type or a change to the current",
    'draft, send the complete draft: start from the current draft when there is one and change only',
    'what the message asks for. If you need to know something before drafting, ask ONE short question',
    'and send "draft": null.',
    '',
    'Your whole reply is the one JSON object.',
  ].join('\n');
}
