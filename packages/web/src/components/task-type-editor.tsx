'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  MAX_DERIVED_CHANGES,
  promptStepId,
  type DerivedChange,
  type CompositionIssue,
} from '@haive/shared/modularity';
import {
  changedTaskType,
  createTaskType,
  getAdminTaskType,
  getTaskTypeCatalog,
  updateTaskType,
  type AdminTaskType,
  type ApiError,
  type TaskTypeCatalog,
} from '@/lib/api-client';
import {
  catalogEntries,
  compositionProblems,
  describeAvailability,
  describeDefaultsIssue,
  promptStepIssuesOf,
  splitServerIssues,
  type PromptStepIssue,
} from '@/lib/composition-messages';
import {
  promptStepIssues,
  readPromptSteps,
  renamePromptStepIds,
  renamePromptStepTokens,
  withPromptStepEntries,
  type PromptSteps,
} from '@/lib/prompt-step-editing';
import {
  buildCreateBody,
  buildUpdateBody,
  compositionChanged,
  slugProblem,
  taskTypeFormSchema,
} from '@/lib/task-type-form';
import {
  buildDerivedCreateBody,
  buildDerivedUpdateBody,
  evaluateDerivedEditor,
  renameDerivedPromptIds,
} from '@/lib/derived-task-type-form';
import { useDerivedPreview } from '@/lib/use-derived-preview';
import { TaskTypeDuplicateAction } from './task-type-duplicate-action';
import { DerivedTaskTypeChanges } from './derived-task-type-changes';
import { InlineMarkdown } from './markdown/inline-markdown';
import { editorStateForAgent, loadDraftIntoEditor } from '@/lib/task-type-draft-load';
import { useComposerIntegrations } from '@/lib/use-composer-integrations';
import { usePageTitle } from '@/lib/use-page-title';
import { useUnsavedChangesGuard } from '@/lib/use-unsaved-changes-guard';
import type { TaskTypeAvailability } from '@haive/shared/modularity';
import { FormRenderer, type FormValues } from '@/components/form-renderer';
import { PromptStepEditor } from './prompt-step-editor';
import { TaskTypeComposer } from '@/components/task-type-composer';
import {
  forgetDraftConversation,
  TaskTypeCreatorPanel,
} from '@/components/task-type-creator-panel';
import { TaskTypeDeleteDialog } from '@/components/task-type-delete-dialog';
import { Badge, Button, Card, FormError } from '@/components/ui';

const NEW_TYPE_DEFAULTS: FormValues = {
  slug: '',
  displayName: '',
  description: '',
  requiresRepository: true,
  enabled: true,
  selectable: true,
  sortOrder: 0,
};

const NO_COMPOSITION = { stepIds: [], stepLoopLimitDefaults: {}, promptSteps: {} };

const CREATE_FIELDS = [
  'displayName',
  'description',
  'stepIds',
  'preAnswerDefaults',
  'stepLoopLimitDefaults',
  'promptSteps',
  'requiresRepository',
  'selectable',
  'enabled',
  'sortOrder',
];

function sourceLabel(source: string): string {
  if (source === 'admin') return 'Custom';
  if (source === 'builtin') return 'Built-in';
  return `Module ${source.replace(/^module:/, '')}`;
}

function initialValuesOf(row: AdminTaskType): FormValues {
  return {
    displayName: row.displayName,
    description: row.description ?? '',
    requiresRepository: row.requiresRepository,
    enabled: row.enabled,
    selectable: row.selectable,
    sortOrder: row.sortOrder,
  };
}

export function TaskTypeEditor({
  slug,
  duplicateBaseSlug = null,
}: {
  slug: string | null;
  duplicateBaseSlug?: string | null;
}) {
  const router = useRouter();
  const creating = slug === null;
  usePageTitle(creating ? 'New task type' : `Task type ${slug}`);

  const { info: integrationInfo, refresh: refreshIntegrationInfo } = useComposerIntegrations(slug);
  const integrationCategories = integrationInfo.categories;
  const [catalog, setCatalog] = useState<TaskTypeCatalog | null>(null);
  const [row, setRow] = useState<AdminTaskType | null>(null);
  const [availability, setAvailability] = useState<TaskTypeAvailability | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [baseSlug, setBaseSlug] = useState<string | null>(
    creating ? duplicateBaseSlug || null : null,
  );
  const [changes, setChanges] = useState<DerivedChange[]>([]);
  const [permissionDenied, setPermissionDenied] = useState<string | null>(null);
  const [previewPath, setPreviewPath] = useState<string>('pre-triage');
  const [stepIds, setStepIds] = useState<string[]>([]);
  const [loopLimits, setLoopLimits] = useState<Record<string, number>>({});
  const [promptSteps, setPromptSteps] = useState<PromptSteps>({});
  const [serverPromptIssues, setServerPromptIssues] = useState<PromptStepIssue[]>([]);
  const [values, setValues] = useState<FormValues>(creating ? NEW_TYPE_DEFAULTS : {});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [serverDerivedIssues, setServerDerivedIssues] = useState<
    { kind: string; [key: string]: unknown }[]
  >([]);
  const [serverIssues, setServerIssues] = useState<CompositionIssue[]>([]);
  const [saved, setSaved] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [formRevision, setFormRevision] = useState(0);
  const [loadedValues, setLoadedValues] = useState<FormValues | null>(null);
  const [changedRow, setChangedRow] = useState<AdminTaskType | null>(null);
  const [leaving, setLeaving] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const applyRow = useCallback((taskType: AdminTaskType) => {
    setPermissionDenied(null);
    setRow(taskType);
    setBaseSlug(taskType.runListStrategy === 'derived' ? (taskType.baseSlug ?? '') : null);
    setChanges(taskType.changes ?? []);
    setChangedRow(null);
    setStepIds(taskType.stepIds ?? []);
    setLoopLimits(taskType.stepLoopLimitDefaults);
    setPromptSteps(readPromptSteps(taskType.promptSteps ?? {}));
    setValues(initialValuesOf(taskType));
    setLoadedValues(null);
    setFormRevision((n) => n + 1);
  }, []);

  useEffect(() => {
    let current = true;
    setCatalog(null);
    setRow(null);
    setLoadError(null);
    void Promise.all([
      getTaskTypeCatalog(),
      slug === null
        ? duplicateBaseSlug
          ? getAdminTaskType(duplicateBaseSlug)
          : null
        : getAdminTaskType(slug),
    ])
      .then(([cat, one]) => {
        if (!current) return;
        setCatalog(cat);
        if (one && creating && duplicateBaseSlug) {
          const eligibility = cat.bases?.find((b) => b.slug === duplicateBaseSlug)?.eligibility;
          if (!eligibility?.eligible) {
            setLoadError(
              eligibility?.eligible === false ? eligibility.message : 'This base is unavailable.',
            );
            return;
          }
          const copied = {
            ...NEW_TYPE_DEFAULTS,
            displayName: one.taskType.displayName,
            description: one.taskType.description ?? '',
            requiresRepository: one.taskType.requiresRepository,
            sortOrder: one.taskType.sortOrder,
          };
          setPermissionDenied(null);
          setBaseSlug(duplicateBaseSlug);
          setChanges([]);
          setValues(copied);
          setLoadedValues(copied);
          setFormRevision((n) => n + 1);
        } else if (one) {
          applyRow(one.taskType);
          setAvailability(one.availability);
          setServerPromptIssues(promptStepIssuesOf(one.promptStepIssues));
        } else {
          setAvailability(null);
        }
      })
      .catch((err: ApiError) => {
        if (current) setLoadError(err.message ?? 'Failed to load the task type');
      });
    return () => {
      current = false;
    };
  }, [slug, duplicateBaseSlug, creating, applyRow]);

  const derived = baseSlug !== null;
  const editableFields = creating
    ? derived
      ? [...CREATE_FIELDS.filter((f) => f !== 'stepIds' && f !== 'requiresRepository'), 'changes']
      : CREATE_FIELDS
    : (row?.editableFields ?? []);
  const composable = !derived && editableFields.includes('stepIds');
  const entries = useMemo(() => (catalog ? catalogEntries(catalog) : null), [catalog]);
  const requiresRepository = values.requiresRepository === true;
  const promptEditable = editableFields.includes('promptSteps');
  const typeSlug = creating ? String(values.slug ?? '').trim() : (row?.slug ?? '');
  const withPrompts = useMemo(
    () =>
      entries ? withPromptStepEntries(entries, typeSlug, requiresRepository, promptSteps) : null,
    [entries, typeSlug, requiresRepository, promptSteps],
  );
  const clientProblems = useMemo(
    () =>
      composable && withPrompts
        ? {
            ...compositionProblems({
              stepIds,
              loopLimits,
              catalog: withPrompts,
              requiresRepository,
            }),
            prompt: promptEditable
              ? promptStepIssues({
                  typeSlug,
                  stepIds,
                  requiresRepository,
                  promptSteps,
                  catalog: withPrompts,
                  integrationCategoryIds: new Set(
                    integrationCategories.map((category) => category.id),
                  ),
                })
              : [],
          }
        : { composition: [], defaults: [], prompt: [] },
    [
      composable,
      withPrompts,
      promptEditable,
      typeSlug,
      stepIds,
      loopLimits,
      requiresRepository,
      promptSteps,
      integrationCategories,
    ],
  );
  const derivedEvaluation = useMemo(
    () =>
      derived && catalog
        ? evaluateDerivedEditor({
            catalog,
            baseSlug: baseSlug!,
            changes,
            typeSlug,
            requiresRepository,
            promptSteps,
            loopLimits,
            preAnswerDefaults: row?.preAnswerDefaults ?? {},
            integrationCategoryIds: new Set(integrationCategories.map((c) => c.id)),
          })
        : null,
    [
      derived,
      catalog,
      baseSlug,
      changes,
      typeSlug,
      requiresRepository,
      promptSteps,
      loopLimits,
      row?.preAnswerDefaults,
      integrationCategories,
    ],
  );
  const overlayEdited =
    derived &&
    (JSON.stringify(changes) !== JSON.stringify(row?.changes ?? []) ||
      compositionChanged(
        { stepIds: [], loopLimits, promptSteps },
        {
          stepIds: [],
          stepLoopLimitDefaults: row?.stepLoopLimitDefaults ?? {},
          promptSteps: row?.promptSteps ?? {},
        },
      ));
  const previewBody =
    derived && catalog && slugProblem(typeSlug) === null
      ? buildDerivedCreateBody(
          { ...values, slug: typeSlug },
          {
            baseSlug: baseSlug!,
            changes,
            loopLimits,
            promptSteps,
            preAnswerDefaults: row?.preAnswerDefaults ?? {},
          },
        )
      : null;
  const preview = useDerivedPreview(previewBody);
  const overlayStructureEdited =
    derived &&
    (JSON.stringify(changes) !== JSON.stringify(row?.changes ?? []) ||
      compositionChanged(
        { stepIds: [], loopLimits: {}, promptSteps },
        { stepIds: [], stepLoopLimitDefaults: {}, promptSteps: row?.promptSteps ?? {} },
      ));
  const limitsEdited =
    JSON.stringify(loopLimits) !== JSON.stringify(row?.stepLoopLimitDefaults ?? {});
  const derivedBlocked =
    derived &&
    (((creating || overlayStructureEdited) && (derivedEvaluation?.issues.length ?? 0) > 0) ||
      ((creating || limitsEdited) &&
        (derivedEvaluation?.defaultIssues.some((issue) => issue.field !== 'preAnswerDefaults') ??
          false)));
  const compositionEdited =
    row !== null && compositionChanged({ stepIds, loopLimits, promptSteps }, row);
  // A flat-only edit is not re-checked by the api, so only an edit that touches the composition waits on it.
  const compositionTouched =
    creating || compositionEdited || requiresRepository !== row?.requiresRepository;
  const authoringForbidden = derived && (permissionDenied !== null || preview.forbidden);
  const blocked =
    authoringForbidden ||
    derivedBlocked ||
    (composable &&
      compositionTouched &&
      (clientProblems.composition.length > 0 ||
        clientProblems.defaults.length > 0 ||
        clientProblems.prompt.length > 0 ||
        catalog?.synced === false));
  const schema = useMemo(
    () => taskTypeFormSchema(editableFields, creating ? 'create' : 'edit'),
    [editableFields, creating],
  );
  const initialValues = useMemo(
    () => (creating ? NEW_TYPE_DEFAULTS : row ? initialValuesOf(row) : undefined),
    [creating, row],
  );
  const dirty =
    initialValues !== undefined &&
    (Object.keys(values).some((k) => values[k] !== initialValues[k]) ||
      compositionChanged({ stepIds, loopLimits, promptSteps }, row ?? NO_COMPOSITION) ||
      overlayEdited);
  const leaveDialog = useUnsavedChangesGuard(dirty && !leaving);

  function leaveTo(path: string) {
    setLeaving(true);
    router.push(path);
  }

  function touch() {
    setSaved(false);
    setRefreshError(null);
    setSaveError(null);
    setServerIssues([]);
    setServerDerivedIssues([]);
    setServerPromptIssues([]);
  }

  function loadDraft(draft: Record<string, unknown>) {
    const next = loadDraftIntoEditor({ stepIds, loopLimits, promptSteps, values }, draft, {
      creating,
      slug: typeSlug,
    });
    touch();
    setStepIds(next.stepIds);
    setLoopLimits(next.loopLimits);
    setPromptSteps(next.promptSteps);
    setValues(next.values);
    setLoadedValues(next.values);
    setFormRevision((n) => n + 1);
  }

  async function refreshAvailability(forSlug: string) {
    try {
      const fresh = await getAdminTaskType(forSlug);
      setAvailability(fresh.availability);
      setServerPromptIssues(promptStepIssuesOf(fresh.promptStepIssues));
    } catch (err) {
      setRefreshError((err as ApiError).message ?? 'Failed to refresh availability');
    }
  }

  async function submit(submitted: FormValues) {
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    setRefreshError(null);
    setServerIssues([]);
    setServerDerivedIssues([]);
    setServerPromptIssues([]);
    try {
      if (creating) {
        const problem = slugProblem(String(submitted.slug ?? '').trim());
        if (problem) {
          setSaveError(problem);
          return;
        }
        const body = derived
          ? buildDerivedCreateBody(submitted, {
              baseSlug: baseSlug!,
              changes,
              loopLimits,
              promptSteps,
            })
          : buildCreateBody(submitted, { stepIds, loopLimits, promptSteps });
        await createTaskType(body);
        forgetDraftConversation(null);
        leaveTo(`/admin/task-types/${encodeURIComponent(body.slug)}`);
        return;
      }
      const body = derived
        ? buildDerivedUpdateBody(
            submitted,
            editableFields,
            { changes, loopLimits, promptSteps },
            { ...row! },
          )
        : buildUpdateBody(
            submitted,
            editableFields,
            composable && compositionEdited
              ? { stepIds, loopLimits, promptSteps, typeSlug: row!.slug, saved: row! }
              : null,
            initialValuesOf(row!),
          );
      const res = await updateTaskType(row!.slug, { ...body, expectedUpdatedAt: row!.updatedAt });
      applyRow(res.taskType);
      setSaved(true);
      await refreshAvailability(row!.slug);
    } catch (err) {
      const error = err as ApiError;
      if (derived && error.status === 403) {
        setPermissionDenied(error.message ?? 'Admin access is required. Saving is unavailable.');
        return;
      }
      const changed = changedTaskType(error);
      if (changed) {
        setChangedRow(changed);
        return;
      }
      if (derived) {
        const issues = (error.body as { issues?: unknown } | undefined)?.issues;
        if (Array.isArray(issues))
          setServerDerivedIssues(
            issues.filter(
              (issue): issue is { kind: string; [key: string]: unknown } =>
                typeof issue === 'object' && issue !== null && typeof issue.kind === 'string',
            ),
          );
      }
      const issues = splitServerIssues((error.body as { issues?: unknown } | undefined)?.issues);
      const promptIssues = promptStepIssuesOf(
        (error.body as { issues?: unknown } | undefined)?.issues,
      );
      setServerIssues(issues.composition);
      setServerPromptIssues(promptIssues);
      const lines = [
        ...(issues.composition.length > 0
          ? ['The server rejected this step list; the marked rows say why.']
          : []),
        ...(promptIssues.length > 0
          ? ['The server rejected a prompt step; the marked rows say why.']
          : []),
        ...(entries ? issues.defaults.map((i) => describeDefaultsIssue(i, entries)) : []),
      ];
      setSaveError(lines.length > 0 ? lines.join(' ') : (error.message ?? 'Failed to save'));
    } finally {
      setSaving(false);
    }
  }

  if (loadError) {
    return (
      <div className="flex flex-col gap-3">
        <FormError message={loadError} />
        <Link href="/admin/task-types" className="text-sm text-indigo-300 hover:underline">
          Back to task types
        </Link>
      </div>
    );
  }
  if (!catalog || !entries || (!creating && !row)) {
    return <p className="text-sm text-neutral-400">Loading…</p>;
  }

  const candidates = preview.diagnostics?.candidates ?? derivedEvaluation?.candidates ?? [];
  const selectedCandidate =
    candidates.find((c) => (c.executionPath ?? 'pre-triage') === previewPath) ?? candidates[0];
  const lastField = schema.fields.at(-1)?.id;
  const composer = (readOnly: boolean) => (
    <>
      <TaskTypeComposer
        catalog={catalog}
        integrationCategories={integrationCategories}
        integrationInfo={integrationInfo}
        onRefreshIntegrationInfo={() => {
          void refreshIntegrationInfo();
        }}
        typeSlug={typeSlug}
        promptSteps={promptSteps}
        stepIds={
          derived
            ? [...(selectedCandidate?.stepIds ?? [])]
            : readOnly
              ? (row?.stepIds ?? null)
              : stepIds
        }
        loopLimits={loopLimits}
        requiresRepository={requiresRepository}
        readOnly={readOnly}
        disabled={saving || authoringForbidden}
        {...(derived
          ? {
              overlay: {
                onInsert:
                  editableFields.includes('changes') && changes.length < MAX_DERIVED_CHANGES
                    ? (target: string, step: string) => {
                        touch();
                        setChanges((prev) => [...prev, { insertAfter: target, step }]);
                      }
                    : undefined,
                onRemove:
                  editableFields.includes('changes') && changes.length < MAX_DERIVED_CHANGES
                    ? (step: string) => {
                        touch();
                        setChanges((prev) => [...prev, { remove: step }]);
                      }
                    : undefined,
                limitsEditable: editableFields.includes('stepLoopLimitDefaults'),
              },
            }
          : {})}
        serverIssues={serverIssues}
        {...(promptEditable && (!readOnly || derived)
          ? {
              serverPromptIssues,
              onPromptStepsChange: (next: PromptSteps) => {
                touch();
                setPromptSteps(next);
              },
            }
          : {})}
        onStepIdsChange={(next) => {
          touch();
          setStepIds(next);
        }}
        onLoopLimitsChange={(next) => {
          touch();
          setLoopLimits(next);
        }}
      />
    </>
  );

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Link href="/admin/task-types" className="text-sm text-indigo-300 hover:underline">
          ← Task types
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="text-xl font-semibold text-neutral-50 [overflow-wrap:anywhere]"
          >
            {creating ? 'New task type' : row!.displayName}
          </h2>
          {row && <Badge>{sourceLabel(row.source)}</Badge>}
        </div>
        {row && (
          <p className="mt-1 font-mono text-xs text-neutral-500 [overflow-wrap:anywhere]">
            {row.slug}
          </p>
        )}
        {availability && !availability.available && (
          <p className="mt-2 text-sm text-amber-300">{describeAvailability(availability)}</p>
        )}
        {row && !composable && !derived && (
          <p className="mt-2 text-sm text-neutral-400">
            Only some fields of this task type can be changed. Its steps are fixed.
          </p>
        )}
        {catalog.synced === false && composable && (
          <p className="mt-2 text-sm text-amber-300">
            The step catalog has not been synced yet, so a step list cannot be saved.
          </p>
        )}
      </div>
      {row?.source === 'builtin' && (
        <TaskTypeDuplicateAction slug={row.slug} bases={catalog.bases} />
      )}
      {!derived && (creating || row?.source === 'admin') && (
        <TaskTypeCreatorPanel
          slug={creating ? null : row!.slug}
          editorState={editorStateForAgent({
            stepIds,
            loopLimits,
            promptSteps,
            values: { ...values, slug: typeSlug },
          })}
          onLoad={loadDraft}
        />
      )}
      {derived && derivedEvaluation && (
        <Card>
          <InlineMarkdown
            className="mb-3 text-sm text-neutral-300"
            body={`Base: ${baseSlug}. The base and strategy cannot be changed after creation.`}
          />
          <DerivedTaskTypeChanges
            changes={changes}
            evaluation={derivedEvaluation}
            diagnostics={preview.diagnostics}
            serverIssues={serverDerivedIssues}
            error={preview.error}
            disabled={saving || authoringForbidden}
            editable={editableFields.includes('changes')}
            revision={formRevision}
            entries={withPrompts!}
            requiresRepository={requiresRepository}
            onChange={(next) => {
              touch();
              setChanges(next);
            }}
          />
          <label className="mt-4 flex flex-col gap-2 text-sm text-neutral-200">
            Path preview
            <select
              className="h-11 rounded border border-neutral-600 bg-neutral-950 px-3"
              value={selectedCandidate?.executionPath ?? 'pre-triage'}
              onChange={(e) => setPreviewPath(e.target.value)}
            >
              {candidates.map((c) => (
                <option
                  key={c.executionPath ?? 'pre-triage'}
                  value={c.executionPath ?? 'pre-triage'}
                >
                  {c.executionPath ?? 'pre-triage'}
                </option>
              ))}
            </select>
          </label>
          <InlineMarkdown
            className="my-3 text-sm text-neutral-300"
            body="The path order is read-only. Use changes to insert, remove or replace steps. Presets and loop limits belong to this type."
          />
          {composer(true)}
          {Object.keys(loopLimits)
            .filter((id) => !derivedEvaluation.stepIds.includes(id))
            .map((id) => (
              <div key={id} className="mt-3">
                <InlineMarkdown
                  className="text-sm text-amber-300"
                  body={`Saved loop limit for ${id} is outside the resulting paths. It will be omitted from new tasks.`}
                />
                {editableFields.includes('stepLoopLimitDefaults') && (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={saving || authoringForbidden}
                    aria-label={`Clear obsolete loop limit for ${id}`}
                    onClick={() => {
                      touch();
                      setLoopLimits((prev) => {
                        const next = { ...prev };
                        delete next[id];
                        return next;
                      });
                    }}
                  >
                    Clear loop limit
                  </Button>
                )}
              </div>
            ))}
          {promptEditable &&
            Object.values(promptSteps)
              .filter(
                (entry) => !derivedEvaluation.stepIds.includes(promptStepId(typeSlug, entry.slug)),
              )
              .map((entry) => (
                <div key={entry.slug} className="mt-3">
                  <InlineMarkdown
                    className="text-sm text-amber-300"
                    body={`Prompt ${entry.slug} is not on a resulting path. Restore its insertion or remove the definition.`}
                  />
                  <PromptStepEditor
                    entry={entry}
                    integrationCategories={integrationCategories}
                    disabled={saving || authoringForbidden}
                    onChange={(next) => {
                      touch();
                      setPromptSteps((prev) => ({ ...prev, [entry.slug]: next }));
                    }}
                    onRemove={() => {
                      touch();
                      setPromptSteps((prev) => {
                        const next = { ...prev };
                        delete next[entry.slug];
                        return next;
                      });
                    }}
                  />
                </div>
              ))}
        </Card>
      )}
      <Card>
        <FormRenderer
          key={`${row?.slug ?? 'new'}:${formRevision}`}
          schema={schema}
          hideTitle
          initialValues={loadedValues ?? initialValues}
          submitting={saving}
          submitDisabled={blocked || changedRow !== null}
          errorMessage={derived ? (permissionDenied ?? saveError) : saveError}
          onSubmit={submit}
          onValuesChange={(next) => {
            if (creating && typeof next.slug === 'string' && next.slug.trim() !== typeSlug) {
              const toSlug = next.slug.trim();
              setStepIds((prev) => renamePromptStepIds(prev, typeSlug, toSlug));
              if (derived) setChanges((prev) => renameDerivedPromptIds(prev, typeSlug, toSlug));
              setPromptSteps((prev) => renamePromptStepTokens(prev, typeSlug, toSlug));
            }
            setValues((prev) => ({ ...prev, ...next }));
            const current = row ? initialValuesOf(row) : {};
            if (Object.keys(next).some((k) => next[k] !== current[k])) setSaved(false);
          }}
          renderAfterField={(fieldId) =>
            fieldId === lastField && composable ? (
              <div className="mt-6">
                <h3 className="mb-2 text-sm font-semibold text-neutral-200">Steps</h3>
                {composer(false)}
              </div>
            ) : null
          }
        />
        {changedRow && (
          <div
            role="alert"
            className="mt-3 flex flex-wrap items-center gap-3 rounded-md border border-amber-900 bg-amber-950/30 px-3 py-2 text-sm text-amber-200"
          >
            <p className="min-w-0 flex-1 [overflow-wrap:anywhere]">
              This task type was changed elsewhere. Reload to see the current version; your unsaved
              changes here are discarded.
            </p>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => {
                applyRow(changedRow);
                void refreshAvailability(changedRow.slug);
                headingRef.current?.focus();
              }}
            >
              Reload
            </Button>
          </div>
        )}
        {saved && <p className="mt-3 text-xs text-emerald-400">Saved.</p>}
        {refreshError && (
          <p className="mt-1 text-xs text-amber-300">
            {`Availability could not be refreshed: ${refreshError}`}
          </p>
        )}
      </Card>
      {!composable && !derived && row && (
        <Card>
          <h3 className="mb-2 text-sm font-semibold text-neutral-200">Steps</h3>
          {composer(true)}
        </Card>
      )}
      {row?.source === 'admin' && (
        <div>
          <Button
            type="button"
            variant="destructive"
            className="h-11"
            onClick={() => setDeleteOpen(true)}
          >
            Delete task type
          </Button>
        </div>
      )}
      <TaskTypeDeleteDialog
        slug={deleteOpen && row ? row.slug : null}
        displayName={row?.displayName ?? ''}
        onClose={() => setDeleteOpen(false)}
        onDeleted={() => leaveTo('/admin/task-types')}
      />
      {leaveDialog}
    </div>
  );
}
