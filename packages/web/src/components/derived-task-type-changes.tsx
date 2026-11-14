'use client';
import { useState } from 'react';
import type { CompositionIssue, PromptStepIssue, DerivedChange } from '@haive/shared/modularity';
import { MAX_DERIVED_CHANGES } from '@haive/shared/modularity';
import type { FormSchema } from '@haive/shared';
import type { DerivedTaskTypeDiagnostics } from '@/lib/api-client';
import type { evaluateDerivedEditor } from '@/lib/derived-task-type-form';
import { describeDerivedProblem, describeDerivedWarning } from '@/lib/derived-diagnostics';
import {
  describeIssue,
  describePromptStepIssue,
  type CatalogEntries,
} from '@/lib/composition-messages';
import { FormRenderer } from './form-renderer';
import { InlineMarkdown } from './markdown/inline-markdown';
import { Button } from './ui';

export function DerivedTaskTypeChanges({
  changes,
  evaluation,
  diagnostics,
  serverIssues,
  error,
  disabled,
  editable,
  revision,
  entries,
  requiresRepository,
  onChange,
  maxChanges = MAX_DERIVED_CHANGES,
}: {
  maxChanges?: number;
  changes: DerivedChange[];
  evaluation: ReturnType<typeof evaluateDerivedEditor>;
  diagnostics: DerivedTaskTypeDiagnostics | null;
  serverIssues: { kind: string; [key: string]: unknown }[];
  error: string | null;
  disabled: boolean;
  editable: boolean;
  revision: number;
  entries: CatalogEntries;
  requiresRepository: boolean;
  onChange: (changes: DerivedChange[]) => void;
}) {
  const [orderRevision, setOrderRevision] = useState(0);
  const update = (index: number, change: DerivedChange) => {
    if (JSON.stringify(changes[index]) === JSON.stringify(change)) return;
    onChange(changes.map((old, i) => (i === index ? change : old)));
  };
  const move = (index: number, to: number) => {
    const next = [...changes];
    next.splice(to, 0, next.splice(index, 1)[0]!);
    setOrderRevision((n) => n + 1);
    onChange(next);
  };
  const candidates = diagnostics?.candidates ?? evaluation.candidates;
  const skipped = candidates.flatMap((c) =>
    c.outcomes
      .filter((o) => o.outcome === 'path-absent')
      .map(
        (o) =>
          `Change ${o.operationIndex + 1}: skipped on ${c.executionPath ?? 'pre-triage'}. Target is not on this path.`,
      ),
  );
  const stale = new Map<string, string>();
  for (const warning of evaluation.warnings) {
    if (warning.kind === 'stale-target')
      stale.set(
        `${warning.operationIndex}:${warning.kind}`,
        `Change ${warning.operationIndex + 1}, ${warning.stepId}: Base no longer includes this step; this change will be skipped.`,
      );
  }
  for (const warning of diagnostics?.warnings ?? []) {
    if (warning.kind === 'stale-target')
      stale.set(`${warning.operationIndex}:${warning.kind}`, describeDerivedWarning(warning));
  }
  const describe = (issue: { kind: string; [key: string]: unknown }) => {
    const stepIds = candidates.find((c) => c.executionPath === issue.executionPath)?.stepIds ?? [];
    if (issue.kind === 'invalid-composition')
      return describeIssue(issue.issue as CompositionIssue, {
        stepIds,
        catalog: entries,
        requiresRepository,
      }).message;
    if (issue.kind === 'invalid-prompt-step')
      return describePromptStepIssue(issue.issue as PromptStepIssue);
    return describeDerivedProblem(issue);
  };
  const risky = changes.filter(
    (c) => 'remove' in c && (c.remove === '07-phase-2-implement' || c.remove.includes('gate-')),
  );
  return (
    <section aria-label="Derived changes" className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold text-neutral-100">Changes</h3>
      <InlineMarkdown
        className="text-sm text-neutral-300"
        body="Changes apply in order to each base path. Edit target IDs explicitly; a missing target is never renamed automatically. Replacements require an output contract and are currently unavailable on active targets."
      />
      {changes.map((change, index) => {
        const operation =
          'remove' in change ? 'remove' : 'replace' in change ? 'replace' : 'insertAfter';
        const target =
          'remove' in change
            ? change.remove
            : 'replace' in change
              ? change.replace
              : change.insertAfter;
        const payload =
          'replace' in change ? change.with : 'insertAfter' in change ? change.step : '';
        const schema: FormSchema = {
          title: `Change ${index + 1}`,
          fields: [
            {
              id: `operation-${index}`,
              type: 'select',
              label: 'Operation',
              options: [
                { value: 'remove', label: 'Remove' },
                { value: 'insertAfter', label: 'Insert after' },
                { value: 'replace', label: 'Replace (output contract unavailable)' },
              ],
            },
            { id: `target-${index}`, type: 'text', label: 'Target step', required: true },
            ...(operation === 'remove'
              ? []
              : [
                  {
                    id: `payload-${index}`,
                    type: 'text' as const,
                    label: 'New step',
                    required: true,
                  },
                ]),
          ],
          submitLabel: 'Apply change',
        };
        return (
          <div
            key={`${revision}:${orderRevision}:${index}:${operation}`}
            className="rounded border border-neutral-700 p-3"
            aria-label={`Change ${index + 1}`}
          >
            {editable ? (
              <FormRenderer
                schema={schema}
                initialValues={{
                  [`operation-${index}`]: operation,
                  [`target-${index}`]: target,
                  [`payload-${index}`]: payload,
                }}
                submitting={disabled}
                onSubmit={async () => {}}
                onValuesChange={(v) => {
                  const target = String(v[`target-${index}`] ?? '');
                  const payload = String(v[`payload-${index}`] ?? '');
                  update(
                    index,
                    v[`operation-${index}`] === 'remove'
                      ? { remove: target }
                      : v[`operation-${index}`] === 'replace'
                        ? { replace: target, with: payload }
                        : { insertAfter: target, step: payload },
                  );
                }}
              />
            ) : (
              <InlineMarkdown body={`Change ${index + 1}: ${JSON.stringify(change)}`} />
            )}
            {editable && (
              <div className="mt-2 flex gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={disabled || index === 0}
                  aria-label={`Move change ${index + 1} up`}
                  onClick={() => move(index, index - 1)}
                >
                  ↑
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={disabled || index === changes.length - 1}
                  aria-label={`Move change ${index + 1} down`}
                  onClick={() => move(index, index + 1)}
                >
                  ↓
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={disabled}
                  onClick={() => {
                    setOrderRevision((n) => n + 1);
                    onChange(changes.filter((_, i) => i !== index));
                  }}
                >
                  Delete change {index + 1}
                </Button>
              </div>
            )}
          </div>
        );
      })}
      {editable && (
        <Button
          type="button"
          variant="secondary"
          disabled={disabled || changes.length >= maxChanges}
          onClick={() => onChange([...changes, { remove: '' }])}
        >
          Add change
        </Button>
      )}
      {risky.length > 0 && (
        <InlineMarkdown
          className="text-sm text-amber-300"
          body="Removing a gate or the implementation step changes the workflow's safeguards. Composition validation on the server decides whether the resulting paths can run."
        />
      )}
      <section aria-label="Skipped on path">
        <h4 className="text-sm font-medium text-amber-200">Skipped on path</h4>
        {skipped.map((body, i) => (
          <InlineMarkdown key={i} className="text-sm text-amber-300" body={body} />
        ))}
      </section>
      <section aria-label="Stale targets">
        <h4 className="text-sm font-medium text-amber-200">Stale targets</h4>
        {[...stale].map(([key, body]) => (
          <InlineMarkdown key={key} className="text-sm text-amber-300" body={body} />
        ))}
      </section>
      <section aria-label="Live validation">
        <h4 className="text-sm font-medium text-neutral-200">Live validation</h4>
        {[...evaluation.issues, ...evaluation.defaultIssues].map((issue, i) => (
          <InlineMarkdown key={i} className="text-sm text-red-300" body={describe(issue)} />
        ))}
      </section>
      {serverIssues.length > 0 && (
        <section aria-label="Server save validation">
          <h4 className="text-sm font-medium text-neutral-200">Server save validation</h4>
          {serverIssues.map((issue, i) => (
            <InlineMarkdown key={i} className="text-sm text-red-300" body={describe(issue)} />
          ))}
        </section>
      )}
      {diagnostics && (
        <section aria-label="Server preview">
          <h4 className="text-sm font-medium text-neutral-200">Server preview</h4>
          {[...diagnostics.issues, ...diagnostics.defaultIssues].map((issue, i) => (
            <InlineMarkdown key={i} className="text-sm text-red-300" body={describe(issue)} />
          ))}
          {diagnostics.issues.length === 0 && diagnostics.defaultIssues.length === 0 && (
            <InlineMarkdown body="All paths validated." className="text-sm text-emerald-300" />
          )}
        </section>
      )}
      {error && <InlineMarkdown body={error} className="text-sm text-red-300" />}
    </section>
  );
}
