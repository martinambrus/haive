'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  promptStepId,
  type ComposableStepEntry,
  type CompositionIssue,
} from '@haive/shared/modularity';
import type { TaskTypeCatalog } from '@/lib/api-client';
import {
  catalogEntries,
  compositionProblems,
  describeDefaultsIssue,
  describeIssue,
  describePromptStepIssue,
  describeStepWithoutEntry,
  issuesByRow,
  stepLabel,
  type CatalogEntries,
  type PromptStepIssue,
  type StepRef,
} from '@/lib/composition-messages';
import {
  dropMove,
  insertStep,
  moveStep,
  pruneLoopLimits,
  removeStep,
} from '@/lib/composition-order';
import {
  isToolIssue,
  newPromptStep,
  promptStepIssues,
  promptStepSlugOf,
  takenPromptSlugs,
  withPromptStepEntries,
  type PromptSteps,
} from '@/lib/prompt-step-editing';
import { slugProblem } from '@/lib/task-type-form';
import { dropIntentFromY } from '@/lib/sidebar-tree';
import { cn } from '@/lib/cn';
import { Badge, Button, Input } from '@/components/ui';
import { InlineMarkdown } from '@/components/markdown/inline-markdown';
import { PromptStepEditor } from '@/components/prompt-step-editor';

interface TaskTypeComposerProps {
  catalog: TaskTypeCatalog;
  stepIds: string[] | null;
  loopLimits: Record<string, number>;
  requiresRepository: boolean;
  readOnly?: boolean;
  disabled?: boolean;
  serverIssues?: CompositionIssue[];
  typeSlug?: string;
  promptSteps?: PromptSteps;
  serverPromptIssues?: PromptStepIssue[];
  onPromptStepsChange?: (promptSteps: PromptSteps) => void;
  onStepIdsChange: (stepIds: string[]) => void;
  onLoopLimitsChange: (limits: Record<string, number>) => void;
}

type FocusKind = 'up' | 'down' | 'remove';

const ICON_BUTTON = 'h-11 min-w-11 px-0';
const NO_PROMPT_STEPS: PromptSteps = {};
const NO_PROMPT_ISSUES: PromptStepIssue[] = [];

const promptIssueKey = (i: PromptStepIssue) =>
  JSON.stringify([i.kind, i.stepId, i.raw ?? '', i.param ?? '']);

function Chips({ label, tokens }: { label: string; tokens: string[] }) {
  if (tokens.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className="text-[11px] uppercase tracking-wide text-neutral-500">{label}</span>
      {tokens.map((t) => (
        <span
          key={t}
          className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[11px] text-neutral-300"
        >
          {t}
        </span>
      ))}
    </span>
  );
}

function StepFacts({ entry }: { entry: ComposableStepEntry }) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
      {entry.dispatchesCli && <Badge variant="info">agent</Badge>}
      <Chips label="needs" tokens={[...new Set(entry.requires.map((r) => r.needs))]} />
      <Chips label="provides" tokens={entry.provides} />
    </div>
  );
}

function StepWithoutEntryNote({
  stepId,
  readOnly,
  catalog,
}: {
  stepId: string;
  readOnly: boolean;
  catalog: TaskTypeCatalog;
}) {
  const note = describeStepWithoutEntry(stepId, { readOnly, catalog });
  return (
    <p className={cn('text-[11px]', note.warning ? 'text-amber-300' : 'text-neutral-500')}>
      {note.text}
    </p>
  );
}

function dedupeIssues(issues: CompositionIssue[]): CompositionIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const key = JSON.stringify(i);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function groupedSteps(catalog: TaskTypeCatalog, query: string) {
  const needle = query.trim().toLowerCase();
  const matches = catalog.steps.filter(
    (s) =>
      needle === '' ||
      s.entry.label.toLowerCase().includes(needle) ||
      s.stepId.toLowerCase().includes(needle),
  );
  const known = new Set(catalog.groups.map((g) => g.id));
  const groups = [
    ...catalog.groups,
    ...[...new Set(matches.map((s) => s.entry.group))]
      .filter((id) => !known.has(id))
      .map((id) => ({ id, label: id })),
  ];
  return groups
    .map((g) => ({ ...g, steps: matches.filter((s) => s.entry.group === g.id) }))
    .filter((g) => g.steps.length > 0);
}

export function TaskTypeComposer({
  catalog,
  stepIds,
  loopLimits,
  requiresRepository,
  readOnly = false,
  disabled = false,
  serverIssues = [],
  typeSlug,
  promptSteps = NO_PROMPT_STEPS,
  serverPromptIssues = NO_PROMPT_ISSUES,
  onPromptStepsChange,
  onStepIdsChange,
  onLoopLimitsChange,
}: TaskTypeComposerProps) {
  const prompt =
    !readOnly && onPromptStepsChange !== undefined && typeSlug !== undefined
      ? { typeSlug, set: onPromptStepsChange }
      : null;
  const entries: CatalogEntries = useMemo(() => {
    const base = catalogEntries(catalog);
    return typeSlug === undefined
      ? base
      : withPromptStepEntries(base, typeSlug, requiresRepository, promptSteps);
  }, [catalog, typeSlug, requiresRepository, promptSteps]);
  const [openPromptSlug, setOpenPromptSlug] = useState<string | null>(null);
  const openStepId =
    prompt && openPromptSlug !== null ? promptStepId(prompt.typeSlug, openPromptSlug) : null;
  const [query, setQuery] = useState('');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [focus, setFocus] = useState<{ index: number; kind: FocusKind } | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropMark, setDropMark] = useState<{ index: number; intent: 'before' | 'after' } | null>(
    null,
  );
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    if (!focus || !listRef.current) return;
    const row = listRef.current.querySelector(`[data-row="${focus.index}"]`);
    const order: FocusKind[] =
      focus.kind === 'up' ? ['up', 'down'] : focus.kind === 'down' ? ['down', 'up'] : ['remove'];
    for (const kind of order) {
      const button = row?.querySelector<HTMLButtonElement>(`[data-act="${kind}"]`);
      if (button && !button.disabled) {
        button.focus();
        break;
      }
    }
    setFocus(null);
  }, [focus]);

  if (stepIds === null) {
    return <p className="text-sm text-neutral-400">Steps chosen at run time.</p>;
  }

  const problems = compositionProblems({
    stepIds,
    loopLimits,
    catalog: entries,
    requiresRepository,
  });
  const composition = readOnly ? [] : dedupeIssues([...problems.composition, ...serverIssues]);
  const defaults = readOnly ? [] : problems.defaults;
  const byRow = issuesByRow(composition);
  const generalIssues = composition.filter((i) => !('index' in i));
  const promptIssues: PromptStepIssue[] = readOnly
    ? []
    : [
        ...new Map(
          [
            ...(typeSlug === undefined
              ? []
              : promptStepIssues({
                  typeSlug,
                  stepIds,
                  requiresRepository,
                  promptSteps,
                  catalog: entries,
                })),
            ...serverPromptIssues,
          ].map((i) => [promptIssueKey(i), i] as const),
        ).values(),
      ];
  const promptByStep = new Map<string, PromptStepIssue[]>();
  for (const issue of promptIssues) {
    if (stepIds.includes(issue.stepId)) {
      promptByStep.set(issue.stepId, [...(promptByStep.get(issue.stepId) ?? []), issue]);
    }
  }
  const generalPromptIssues = promptIssues.filter((i) => !stepIds.includes(i.stepId));
  const problemCount = composition.length + defaults.length + promptIssues.length;
  const summary =
    problemCount === 0 ? 'No problems' : `${problemCount} problem${problemCount === 1 ? '' : 's'}`;

  function commit(next: string[], message: string, focusTo?: { index: number; kind: FocusKind }) {
    if (next === stepIds) return;
    const pruned = pruneLoopLimits(loopLimits, next);
    onStepIdsChange(next);
    if (pruned !== loopLimits) onLoopLimitsChange(pruned);
    const after = compositionProblems({
      stepIds: next,
      loopLimits: pruned,
      catalog: entries,
      requiresRepository,
    });
    const n =
      after.composition.length +
      after.defaults.length +
      (readOnly || typeSlug === undefined
        ? 0
        : promptStepIssues({
            typeSlug,
            stepIds: next,
            requiresRepository,
            promptSteps,
            catalog: entries,
          }).length);
    setAnnouncement(`${message}; ${n === 0 ? 'no problems' : `${n} problem${n === 1 ? '' : 's'}`}`);
    if (focusTo) setFocus(focusTo);
  }

  function move(index: number, to: number) {
    const id = stepIds![index]!;
    commit(moveStep(stepIds!, index, to), `Moved ${stepLabel(id, entries)} to position ${to + 1}`, {
      index: to,
      kind: to < index ? 'up' : 'down',
    });
  }

  function remove(index: number) {
    const id = stepIds![index]!;
    const next = removeStep(stepIds!, index);
    commit(next, `Removed ${stepLabel(id, entries)}`, {
      index: Math.min(index, next.length - 1),
      kind: 'remove',
    });
    const slug = prompt ? promptStepSlugOf(id, prompt.typeSlug) : null;
    if (prompt && slug !== null && !next.includes(id)) {
      const { [slug]: _gone, ...kept } = promptSteps;
      prompt.set(kept);
    }
    if (openStepId === id) setOpenPromptSlug(null);
  }

  function addPromptStep() {
    if (!prompt) return;
    const entry = newPromptStep(takenPromptSlugs(promptSteps, stepIds!, prompt.typeSlug));
    const id = promptStepId(prompt.typeSlug, entry.slug);
    const openIndex = openStepId === null ? -1 : stepIds!.indexOf(openStepId);
    const at = openIndex < 0 ? stepIds!.length : openIndex + 1;
    prompt.set({ ...promptSteps, [entry.slug]: entry });
    commit(insertStep(stepIds!, at, id), `Added prompt step at position ${at + 1}`);
    setOpenPromptSlug(entry.slug);
  }

  function add(stepId: string, at: number = stepIds!.length) {
    if (stepIds!.includes(stepId)) return;
    commit(
      insertStep(stepIds!, at, stepId),
      `Added ${stepLabel(stepId, entries)} at position ${at + 1}`,
    );
  }

  function setLimit(stepId: string, raw: string) {
    const next = { ...loopLimits };
    if (raw === '') delete next[stepId];
    else next[stepId] = Math.min(50, Math.max(1, Math.round(Number(raw)) || 1));
    onLoopLimitsChange(next);
  }

  function addSuggestion(provider: StepRef, rowIndex: number, after: boolean) {
    add(provider.stepId, after ? rowIndex + 1 : rowIndex);
  }

  const rowShadow = (i: number) =>
    dropMark?.index === i && dragFrom !== null
      ? dropMark.intent === 'before'
        ? 'shadow-[inset_0_2px_0_0_var(--color-indigo-400)]'
        : 'shadow-[inset_0_-2px_0_0_var(--color-indigo-400)]'
      : '';

  return (
    <div
      className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]"
      onKeyDown={(e) => {
        // The composer sits inside the editor's form, where Enter in the search or limit box would save it.
        if (e.key === 'Enter' && e.target instanceof HTMLInputElement) e.preventDefault();
      }}
    >
      <section aria-label="Steps" className="min-w-0">
        {!readOnly && (
          <div className="mb-2">
            <p
              className={cn(
                'text-sm font-medium',
                problemCount === 0 ? 'text-emerald-400' : 'text-red-300',
              )}
            >
              {summary}
            </p>
            {generalIssues.map((issue) => (
              <InlineMarkdown
                key={issue.kind}
                className="text-sm text-red-300"
                body={
                  describeIssue(issue, { stepIds, catalog: entries, requiresRepository }).message
                }
              />
            ))}
            {generalPromptIssues.map((issue) => (
              <InlineMarkdown
                key={promptIssueKey(issue)}
                className="text-sm text-red-300"
                body={describePromptStepIssue(issue)}
              />
            ))}
            {defaults.map((issue) => (
              <InlineMarkdown
                key={`${issue.kind}-${issue.stepId}`}
                body={describeDefaultsIssue(issue, entries)}
                className="text-sm text-red-300"
              />
            ))}
          </div>
        )}
        {readOnly && stepIds.length === 0 && <p className="text-sm text-neutral-400">No steps.</p>}
        <ol ref={listRef} className="flex flex-col gap-2">
          {stepIds.map((stepId, index) => {
            const entry = entries.get(stepId);
            const label = stepLabel(stepId, entries);
            const rowIssues = byRow.get(index) ?? [];
            const promptSlug = typeSlug === undefined ? null : promptStepSlugOf(stepId, typeSlug);
            const promptEntry = promptSlug === null ? undefined : promptSteps[promptSlug];
            const rowPromptIssues = promptByStep.get(stepId) ?? [];
            const toolRowIssues =
              prompt && promptEntry && openStepId === stepId
                ? rowPromptIssues.filter((issue) =>
                    promptEntry.tools.some((tool) => isToolIssue(issue, tool)),
                  )
                : [];
            const limitEditable = !readOnly && entry?.loopBudgetEditable === true;
            return (
              <li
                key={`${stepId}-${index}`}
                data-row={index}
                onDragOver={
                  readOnly || dragFrom === null
                    ? undefined
                    : (e) => {
                        e.preventDefault();
                        const rect = e.currentTarget.getBoundingClientRect();
                        const intent = dropIntentFromY(e.clientY - rect.top, rect.height, false);
                        setDropMark({ index, intent: intent === 'after' ? 'after' : 'before' });
                      }
                }
                onDrop={
                  readOnly || dragFrom === null
                    ? undefined
                    : (e) => {
                        e.preventDefault();
                        const intent = dropMark?.index === index ? dropMark.intent : 'before';
                        const next = dropMove(stepIds, dragFrom, index, intent);
                        setDragFrom(null);
                        setDropMark(null);
                        commit(next, `Moved ${stepLabel(stepIds[dragFrom]!, entries)}`);
                      }
                }
                className={cn(
                  'rounded-md border bg-neutral-950/60 px-3 py-2',
                  rowIssues.length > 0 || rowPromptIssues.length > 0 || (!entry && !readOnly)
                    ? 'border-red-800/70'
                    : 'border-neutral-800',
                  rowShadow(index),
                )}
              >
                <div className="flex flex-wrap items-start gap-2 sm:flex-nowrap">
                  {!readOnly && (
                    <span
                      aria-hidden
                      draggable={!disabled}
                      title="Drag to reorder"
                      onDragStart={(e) => {
                        const li = e.currentTarget.closest('li');
                        if (li) e.dataTransfer.setDragImage(li, 0, 0);
                        e.dataTransfer.effectAllowed = 'move';
                        e.dataTransfer.setData('text/plain', stepId);
                        setDragFrom(index);
                      }}
                      onDragEnd={() => {
                        setDragFrom(null);
                        setDropMark(null);
                      }}
                      className="mt-1 hidden cursor-grab select-none text-neutral-600 lg:block"
                    >
                      ⋮⋮
                    </span>
                  )}
                  <span className="mt-0.5 w-6 shrink-0 text-right text-sm tabular-nums text-neutral-500">
                    {index + 1}.
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-neutral-100 [overflow-wrap:anywhere]">
                      {label}
                      {promptEntry && <Badge variant="warning">Prompt step</Badge>}
                    </p>
                    {entry ? (
                      <>
                        <p className="font-mono text-[11px] text-neutral-500 [overflow-wrap:anywhere]">
                          {stepId}
                        </p>
                        <StepFacts entry={entry} />
                      </>
                    ) : (
                      <StepWithoutEntryNote stepId={stepId} readOnly={readOnly} catalog={catalog} />
                    )}
                    {promptEntry && prompt && (
                      <Button
                        type="button"
                        variant="secondary"
                        className="mt-2 h-11"
                        disabled={disabled}
                        aria-expanded={openStepId === stepId}
                        aria-label={`${openStepId === stepId ? 'Close' : 'Edit'} prompt step ${label}`}
                        onClick={() => setOpenPromptSlug(openStepId === stepId ? null : promptSlug)}
                      >
                        {openStepId === stepId ? 'Close editor' : 'Edit'}
                      </Button>
                    )}
                    {entry?.loopTargetStepId !== undefined && (
                      <InlineMarkdown
                        body={`Fix loops return to ${stepLabel(entry.loopTargetStepId, entries)}`}
                        className="mt-1 text-xs text-neutral-400"
                      />
                    )}
                    {limitEditable && (
                      <label className="mt-2 flex items-center gap-2 text-xs text-neutral-400">
                        Loop limit
                        <Input
                          type="number"
                          min={1}
                          max={50}
                          step={1}
                          inputMode="numeric"
                          placeholder="default"
                          value={loopLimits[stepId] ?? ''}
                          onChange={(e) => setLimit(stepId, e.target.value)}
                          disabled={disabled}
                          className="h-11 w-24"
                        />
                      </label>
                    )}
                    {readOnly && loopLimits[stepId] !== undefined && (
                      <p className="mt-1 text-xs text-neutral-400">{`Loop limit ${loopLimits[stepId]}`}</p>
                    )}
                  </div>
                  {!readOnly && (
                    <div className="flex w-full shrink-0 gap-1 pl-8 sm:w-auto sm:pl-0">
                      <Button
                        type="button"
                        variant="ghost"
                        className={ICON_BUTTON}
                        data-act="up"
                        aria-label={`Move ${label} up`}
                        disabled={disabled || index === 0}
                        onClick={() => move(index, index - 1)}
                      >
                        ↑
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        className={ICON_BUTTON}
                        data-act="down"
                        aria-label={`Move ${label} down`}
                        disabled={disabled || index === stepIds.length - 1}
                        onClick={() => move(index, index + 1)}
                      >
                        ↓
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        className={cn(ICON_BUTTON, 'text-red-300')}
                        data-act="remove"
                        aria-label={`Remove ${label}`}
                        disabled={disabled}
                        onClick={() => remove(index)}
                      >
                        ×
                      </Button>
                    </div>
                  )}
                </div>
                {promptEntry && prompt && openStepId === stepId && (
                  <PromptStepEditor
                    entry={promptEntry}
                    issues={toolRowIssues}
                    disabled={disabled}
                    onChange={(next) => prompt.set({ ...promptSteps, [promptEntry.slug]: next })}
                    onRemove={() => remove(index)}
                  />
                )}
                {rowPromptIssues
                  .filter((issue) => !toolRowIssues.includes(issue))
                  .map((issue) => (
                    <InlineMarkdown
                      key={promptIssueKey(issue)}
                      className="mt-2 text-xs text-red-300 [overflow-wrap:anywhere]"
                      body={describePromptStepIssue(issue)}
                    />
                  ))}
                {rowIssues.map((issue) => {
                  const view = describeIssue(issue, {
                    stepIds,
                    catalog: entries,
                    requiresRepository,
                  });
                  const addAfter = issue.kind === 'unfulfilled';
                  const suggestions = view.providedBy.filter((p) => !stepIds.includes(p.stepId));
                  return (
                    <div key={JSON.stringify(issue)} className="mt-2 text-xs text-red-300">
                      <InlineMarkdown className="[overflow-wrap:anywhere]" body={view.message} />
                      {view.providedBy.length > 0 && issue.kind !== 'missing-loop-target' && (
                        <InlineMarkdown
                          className="mt-0.5 text-neutral-400 [overflow-wrap:anywhere]"
                          body={`Provided by: ${view.providedBy.map((p) => p.label).join(', ')}`}
                        />
                      )}
                      {suggestions.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-2">
                          {suggestions.map((p) => (
                            <Button
                              key={p.stepId}
                              type="button"
                              variant="secondary"
                              className="h-11 whitespace-normal py-1 text-xs"
                              disabled={disabled}
                              onClick={() => addSuggestion(p, index, addAfter)}
                            >
                              {`Add ${p.label} ${addAfter ? 'after' : 'before'} this`}
                            </Button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </li>
            );
          })}
        </ol>
        {prompt && (
          <div className="mt-3">
            <Button
              type="button"
              variant="secondary"
              className="h-11"
              disabled={disabled || slugProblem(prompt.typeSlug) !== null}
              onClick={addPromptStep}
            >
              Add prompt step
            </Button>
            {slugProblem(prompt.typeSlug) !== null && (
              <p className="mt-1 text-xs text-neutral-500">
                Enter a valid slug for the task type first; a prompt step&apos;s id contains it.
              </p>
            )}
          </div>
        )}
        <p role="status" aria-live="polite" className="sr-only">
          {announcement}
        </p>
      </section>
      {!readOnly && (
        <section aria-label="Step palette" className="min-w-0">
          <Button
            type="button"
            variant="secondary"
            className="h-11 w-full lg:hidden"
            aria-expanded={paletteOpen}
            disabled={disabled}
            onClick={() => setPaletteOpen((o) => !o)}
          >
            {paletteOpen ? 'Hide step palette' : 'Add steps'}
          </Button>
          <div className={cn('mt-3 lg:mt-0 lg:block', paletteOpen ? 'block' : 'hidden')}>
            <Input
              type="search"
              aria-label="Search steps"
              placeholder="Search steps"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              disabled={disabled}
              className="h-11"
            />
            <div className="mt-3 flex flex-col gap-3 lg:max-h-[70vh] lg:overflow-y-auto">
              {groupedSteps(catalog, query).map((group) => (
                <details key={group.id} open className="rounded-md border border-neutral-800">
                  <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium text-neutral-200">
                    {group.label}
                  </summary>
                  <div className="flex flex-col gap-2 border-t border-neutral-800 p-2">
                    {group.steps.map((s) => {
                      const added = stepIds.includes(s.stepId);
                      return (
                        <div
                          key={s.stepId}
                          className="flex items-start gap-2 rounded bg-neutral-950/60 p-2"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="text-sm text-neutral-100 [overflow-wrap:anywhere]">
                              {s.entry.label}
                            </p>
                            <StepFacts entry={s.entry} />
                          </div>
                          <Button
                            type="button"
                            variant={added ? 'ghost' : 'secondary'}
                            className="h-11 min-w-16 shrink-0"
                            aria-label={`Add ${s.entry.label}`}
                            aria-disabled={added}
                            disabled={disabled}
                            onClick={() => add(s.stepId)}
                          >
                            {added ? 'Added' : 'Add'}
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                </details>
              ))}
              {groupedSteps(catalog, query).length === 0 && (
                <p className="text-sm text-neutral-400">No steps match.</p>
              )}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
