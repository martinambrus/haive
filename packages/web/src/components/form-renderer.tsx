'use client';

import { useEffect, useMemo, useState } from 'react';
import { diffLines } from 'diff';
import ReactMarkdown from 'react-markdown';
import type { DiffDetails, FormField, FormSchema, LeafFormField } from '@haive/shared';
import { Button, FormError, Input, Label } from '@/components/ui';
import { DirectoryTreeSelect } from '@/components/directory-tree-select';
import { BundleComposer, type BundleComposerEntry } from '@/components/bundle-composer';
import { cn } from '@/lib/cn';
import { validateRequired, type FormValues } from '@/components/form-validation';

/** Heuristic markdown detection — true when the body contains at least one
 *  heading line or a fenced code block. Avoids false positives on plain "- "
 *  lists or "**" emphasis which appear in regular text outputs. */
function looksLikeMarkdown(text: string): boolean {
  return /^\s*#{1,6}\s+\S/m.test(text) || /^\s*```/m.test(text);
}

export type { FormValues };

interface FormRendererProps {
  schema: FormSchema;
  onSubmit: (values: FormValues) => void | Promise<void>;
  disabled?: boolean;
  submitting?: boolean;
  initialValues?: FormValues;
  errorMessage?: string | null;
  onValuesChange?: (values: FormValues) => void;
  /** Render extra content (e.g. test buttons) after a specific field. */
  renderAfterField?: (fieldId: string, values: FormValues) => React.ReactNode;
  /** Repository the form is being filled for. Required when the schema
   *  contains a `bundle-composer` field — the composer talks to /api/bundles
   *  on behalf of this repo. */
  repositoryId?: string | null;
}

function defaultValueFor(field: FormField): unknown {
  switch (field.type) {
    case 'text':
    case 'textarea':
    case 'select-with-text':
      return field.default ?? '';
    case 'select':
    case 'radio':
      return field.default ?? field.options[0]?.value ?? '';
    case 'multi-select':
      return field.defaults ?? [];
    case 'directory-tree':
      return field.defaults ?? [];
    case 'checkbox':
      return field.default ?? false;
    case 'number':
      return field.default ?? field.min ?? 0;
    case 'directory-picker':
    case 'file-upload':
      return '';
    case 'accordion':
      return undefined;
    case 'bundle-composer':
      return field.initialBundles.map((b) => ({
        id: b.id,
        name: b.name,
        sourceType: b.sourceType,
        status: b.status,
        itemCount: b.itemCount,
      }));
  }
}

function addFieldDefaults(field: FormField, base: FormValues, overrides?: FormValues): void {
  if (field.type === 'accordion') {
    for (const item of field.items) {
      for (const leaf of item.fields) {
        addFieldDefaults(leaf, base, overrides);
      }
    }
    return;
  }
  base[field.id] = overrides?.[field.id] ?? defaultValueFor(field);
}

function buildInitial(schema: FormSchema, overrides?: FormValues): FormValues {
  const base: FormValues = {};
  for (const field of schema.fields) {
    addFieldDefaults(field, base, overrides);
  }
  return base;
}

export function FormRenderer({
  schema,
  onSubmit,
  disabled = false,
  submitting = false,
  initialValues,
  errorMessage,
  onValuesChange,
  renderAfterField,
  repositoryId,
}: FormRendererProps) {
  const initial = useMemo(() => buildInitial(schema, initialValues), [schema, initialValues]);
  const [values, setValues] = useState<FormValues>(initial);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    onValuesChange?.(values);
  }, [values]); // eslint-disable-line react-hooks/exhaustive-deps

  function update(id: string, value: unknown) {
    setValues((prev) => ({ ...prev, [id]: value }));
    if (localError) setLocalError(null);
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (disabled || submitting) return;
    const required = validateRequired(schema, values);
    if (required) {
      setLocalError(required);
      return;
    }
    setLocalError(null);
    await onSubmit(values);
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      <div>
        <h3 className="text-lg font-semibold text-neutral-50">{schema.title}</h3>
        {schema.description && (
          <p className="mt-1 whitespace-pre-line text-sm text-neutral-400">{schema.description}</p>
        )}
      </div>
      {schema.infoSections && schema.infoSections.length > 0 && (
        <div className="flex flex-col gap-2">
          {schema.infoSections.map((section, i) => {
            const isMd = looksLikeMarkdown(section.body);
            return (
              <details
                key={`${section.title}-${i}`}
                className="rounded-md border border-neutral-800 bg-neutral-950/60"
              >
                <summary className="cursor-pointer select-none px-3 py-2 text-sm text-neutral-200 marker:text-neutral-500 hover:bg-neutral-900">
                  <span className="font-medium">{section.title}</span>
                  {section.preview && (
                    <span className="ml-2 text-xs text-neutral-400">{section.preview}</span>
                  )}
                </summary>
                {isMd ? (
                  <div className="haive-md max-h-96 overflow-auto border-t border-neutral-800 px-3 py-2">
                    <ReactMarkdown>{section.body}</ReactMarkdown>
                  </div>
                ) : (
                  <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words border-t border-neutral-800 px-3 py-2 text-xs text-neutral-300">
                    {section.body}
                  </pre>
                )}
              </details>
            );
          })}
        </div>
      )}
      <div className="flex flex-col gap-4">
        {schema.fields.map((field) => (
          <div key={field.id}>
            {field.type === 'accordion' ? (
              <AccordionField
                field={field}
                values={values}
                onChange={update}
                disabled={disabled || submitting}
              />
            ) : (
              <FieldRow
                field={field}
                value={values[field.id]}
                onChange={(value) => update(field.id, value)}
                disabled={disabled || submitting}
                repositoryId={repositoryId ?? null}
              />
            )}
            {renderAfterField?.(field.id, values)}
          </div>
        ))}
      </div>
      <FormError message={localError ?? errorMessage ?? null} />
      <div>
        <Button type="submit" disabled={disabled || submitting}>
          {submitting ? 'Submitting...' : (schema.submitLabel ?? 'Submit')}
        </Button>
      </div>
    </form>
  );
}

const BADGE_COLORS: Record<string, string> = {
  default: 'bg-neutral-800 text-neutral-300',
  amber: 'bg-amber-900/60 text-amber-300',
  indigo: 'bg-indigo-900/60 text-indigo-300',
  green: 'bg-green-900/60 text-green-300',
};

interface DiffDisclosureProps {
  details: DiffDetails;
}

/** Expandable per-line diff. baseline=null is treated as an empty file
 *  (renders the full `current` body as additions). The `editable` flag is
 *  carried through the schema for forward compatibility but ignored here —
 *  the upgrade form ships read-only diffs today. Workflow tasks will later
 *  honor `editable: true` to allow inline corrections before apply. */
function DiffDisclosure({ details }: DiffDisclosureProps) {
  const { baseline, current } = details;
  const { lines, added, removed } = useMemo(() => {
    const parts = diffLines(baseline ?? '', current);
    let addedCount = 0;
    let removedCount = 0;
    const out: Array<{ kind: 'add' | 'remove' | 'context'; text: string }> = [];
    for (const part of parts) {
      const partLines = part.value.split('\n');
      // diffLines emits a trailing '' when the segment ends with \n; drop it
      // so we don't render a blank diff row.
      if (partLines.length > 0 && partLines[partLines.length - 1] === '') partLines.pop();
      const kind: 'add' | 'remove' | 'context' = part.added
        ? 'add'
        : part.removed
          ? 'remove'
          : 'context';
      for (const line of partLines) {
        out.push({ kind, text: line });
        if (kind === 'add') addedCount += 1;
        else if (kind === 'remove') removedCount += 1;
      }
    }
    return { lines: out, added: addedCount, removed: removedCount };
  }, [baseline, current]);

  const summary =
    baseline === null
      ? `View new content (${added} line${added === 1 ? '' : 's'})`
      : `View diff (+${added} / -${removed})`;

  return (
    <details className="ml-6 mt-1 rounded border border-neutral-800 bg-neutral-950 text-xs">
      <summary className="cursor-pointer select-none px-2 py-1 text-neutral-400 hover:text-neutral-200">
        {summary}
      </summary>
      <div className="max-h-96 overflow-auto border-t border-neutral-800 font-mono text-[11px] leading-tight">
        {lines.length === 0 ? (
          <div className="px-2 py-1 text-neutral-500">No content changes.</div>
        ) : (
          lines.map((line, i) => {
            const cls =
              line.kind === 'add'
                ? 'bg-green-950/60 text-green-200'
                : line.kind === 'remove'
                  ? 'bg-red-950/60 text-red-200'
                  : 'text-neutral-500';
            const prefix = line.kind === 'add' ? '+ ' : line.kind === 'remove' ? '- ' : '  ';
            return (
              <div key={i} className={cn('whitespace-pre px-2', cls)}>
                {prefix}
                {line.text}
              </div>
            );
          })
        )}
      </div>
    </details>
  );
}

function OptionBadge({ text, color }: { text: string; color?: string }) {
  const cls = BADGE_COLORS[color ?? 'default'] ?? BADGE_COLORS.default;
  return (
    <span
      className={cn(
        'ml-1 inline-block rounded px-1.5 py-0.5 text-[10px] font-medium leading-none',
        cls,
      )}
    >
      {text}
    </span>
  );
}

type AccordionFormField = Extract<FormField, { type: 'accordion' }>;

interface AccordionFieldProps {
  field: AccordionFormField;
  values: FormValues;
  onChange: (id: string, value: unknown) => void;
  disabled: boolean;
}

function AccordionField({ field, values, onChange, disabled }: AccordionFieldProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={field.id}>{field.label}</Label>
      {field.description && <p className="text-xs text-neutral-200">{field.description}</p>}
      <div className="flex flex-col overflow-hidden rounded-md border border-neutral-800 bg-neutral-950">
        {field.items.map((item, idx) => (
          <details
            key={`${field.id}-item-${idx}`}
            className="border-b border-neutral-800 last:border-b-0"
          >
            <summary className="cursor-pointer select-none px-3 py-2 text-sm text-neutral-100 hover:bg-neutral-900">
              {item.title}
            </summary>
            <div className="flex flex-col gap-3 border-t border-neutral-800 bg-neutral-950 px-3 py-3">
              {item.description && (
                <p className="whitespace-pre-line text-xs text-neutral-200">{item.description}</p>
              )}
              {item.fields.map((leaf) => (
                <FieldRow
                  key={leaf.id}
                  field={leaf}
                  value={values[leaf.id]}
                  onChange={(value) => onChange(leaf.id, value)}
                  disabled={disabled}
                />
              ))}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}

interface FieldRowProps {
  field: LeafFormField;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled: boolean;
  repositoryId?: string | null;
}

function FieldRow({ field, value, onChange, disabled, repositoryId }: FieldRowProps) {
  if (field.type === 'checkbox') {
    return (
      <div className="flex flex-col gap-1">
        <label className="flex items-center gap-2 text-sm text-neutral-200">
          <input
            id={field.id}
            type="checkbox"
            checked={Boolean(value)}
            disabled={disabled}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span>
            {field.label}
            {field.required && <span className="ml-1 text-red-400">*</span>}
          </span>
        </label>
        {field.description && (
          <p className="whitespace-pre-line pl-6 text-xs text-neutral-200">{field.description}</p>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={field.id}>
        {field.label}
        {field.required && <span className="ml-1 text-red-400">*</span>}
      </Label>
      {field.description && <p className="text-xs text-neutral-200">{field.description}</p>}
      {field.type !== 'multi-select' && field.details?.kind === 'diff' && (
        <DiffDisclosure details={field.details} />
      )}
      <FieldControl
        field={field}
        value={value}
        onChange={onChange}
        disabled={disabled}
        repositoryId={repositoryId ?? null}
      />
    </div>
  );
}

function FieldControl({ field, value, onChange, disabled, repositoryId }: FieldRowProps) {
  const selectClass = cn(
    'h-10 w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 text-sm text-neutral-100 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500',
  );
  const textareaClass = cn(
    'w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500',
  );

  switch (field.type) {
    case 'text':
      return (
        <Input
          id={field.id}
          type="text"
          value={(value as string) ?? ''}
          placeholder={field.placeholder}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'textarea':
      return (
        <textarea
          id={field.id}
          rows={field.rows ?? 4}
          value={(value as string) ?? ''}
          placeholder={field.placeholder}
          disabled={disabled}
          className={textareaClass}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'number':
      return (
        <Input
          id={field.id}
          type="number"
          value={value === undefined || value === null || value === '' ? '' : String(value)}
          min={field.min}
          max={field.max}
          step={field.step}
          disabled={disabled}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === '') return onChange('');
            const parsed = Number(raw);
            onChange(Number.isNaN(parsed) ? raw : parsed);
          }}
        />
      );
    case 'select':
      return (
        <select
          id={field.id}
          value={(value as string) ?? ''}
          disabled={disabled}
          className={selectClass}
          onChange={(e) => onChange(e.target.value)}
        >
          {field.options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      );
    case 'multi-select': {
      const current = Array.isArray(value) ? (value as string[]) : [];
      const options = field.options;
      const hasGroups = options.some((o) => typeof o.group === 'string' && o.group.length > 0);
      const quickBtn =
        'rounded border border-neutral-800 bg-neutral-900 px-2 py-0.5 text-[11px] text-neutral-300 hover:border-indigo-700 hover:bg-indigo-950 disabled:opacity-50';

      const renderCheckbox = (opt: (typeof options)[number]) => {
        const checked = current.includes(opt.value);
        return (
          <div key={opt.value} className="flex flex-col">
            <label className="flex items-center gap-2 text-sm text-neutral-200">
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={(e) => {
                  if (e.target.checked) {
                    onChange([...current, opt.value]);
                  } else {
                    onChange(current.filter((v) => v !== opt.value));
                  }
                }}
              />
              <span>{opt.label}</span>
              {opt.badge && <OptionBadge text={opt.badge} color={opt.badgeColor} />}
            </label>
            {opt.details?.kind === 'diff' && <DiffDisclosure details={opt.details} />}
          </div>
        );
      };

      const distinctGroups: string[] = [];
      const grouped = new Map<string, typeof options>();
      if (hasGroups) {
        for (const opt of options) {
          const g = opt.group ?? '';
          let bucket = grouped.get(g);
          if (!bucket) {
            bucket = [];
            grouped.set(g, bucket);
            distinctGroups.push(g);
          }
          bucket.push(opt);
        }
      }

      const toggleGroup = (groupValues: string[]) => {
        const allSelected = groupValues.every((v) => current.includes(v));
        if (allSelected) {
          onChange(current.filter((v) => !groupValues.includes(v)));
        } else {
          onChange(Array.from(new Set([...current, ...groupValues])));
        }
      };

      return (
        <div className="flex flex-col gap-2">
          {options.length > 1 && (
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChange(options.map((o) => o.value))}
                className={quickBtn}
              >
                Select all ({options.length})
              </button>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChange([])}
                className={quickBtn}
              >
                Deselect all
              </button>
            </div>
          )}
          {hasGroups ? (
            <div className="flex flex-col gap-2.5">
              {distinctGroups.map((g) => {
                const groupOpts = grouped.get(g) ?? [];
                const groupValues = groupOpts.map((o) => o.value);
                const allInGroup = groupValues.every((v) => current.includes(v));
                return (
                  <div key={g || '__ungrouped__'} className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-neutral-300">{g || 'Other'}</span>
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => toggleGroup(groupValues)}
                        className={quickBtn}
                      >
                        {allInGroup ? `Deselect ${groupOpts.length}` : `Select ${groupOpts.length}`}
                      </button>
                    </div>
                    <div className="flex flex-col gap-1 pl-3">{groupOpts.map(renderCheckbox)}</div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">{options.map(renderCheckbox)}</div>
          )}
        </div>
      );
    }
    case 'radio':
      return (
        <div className="flex flex-col gap-1.5">
          {field.options.map((opt) => (
            <label key={opt.value} className="flex items-center gap-2 text-sm text-neutral-200">
              <input
                type="radio"
                name={field.id}
                value={opt.value}
                checked={value === opt.value}
                disabled={disabled}
                onChange={(e) => onChange(e.target.value)}
              />
              {opt.label}
            </label>
          ))}
        </div>
      );
    case 'checkbox':
      return (
        <label className="flex items-center gap-2 text-sm text-neutral-200">
          <input
            id={field.id}
            type="checkbox"
            checked={Boolean(value)}
            disabled={disabled}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span>{field.label}</span>
        </label>
      );
    case 'select-with-text': {
      const current = typeof value === 'string' ? value : '';
      const matchesPredefined = field.predefined.some((opt) => opt.value === current);
      const mode = matchesPredefined ? 'predefined' : 'custom';
      return (
        <div className="flex flex-col gap-2">
          <select
            value={mode === 'predefined' ? current : '__custom__'}
            disabled={disabled}
            className={selectClass}
            onChange={(e) => {
              if (e.target.value === '__custom__') {
                onChange('');
              } else {
                onChange(e.target.value);
              }
            }}
          >
            {field.predefined.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
            <option value="__custom__">Custom...</option>
          </select>
          {mode === 'custom' && (
            <Input
              type="text"
              value={current}
              placeholder={field.placeholder}
              disabled={disabled}
              onChange={(e) => onChange(e.target.value)}
            />
          )}
        </div>
      );
    }
    case 'directory-picker':
      return (
        <Input
          id={field.id}
          type="text"
          value={(value as string) ?? ''}
          placeholder={field.rootPath ?? '/path/to/dir'}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'file-upload':
      return (
        <p className="text-sm text-neutral-500">File upload not wired to this renderer yet.</p>
      );
    case 'directory-tree': {
      const current = Array.isArray(value) ? (value as string[]) : [];
      return (
        <DirectoryTreeSelect
          tree={field.tree}
          value={current}
          onChange={(paths) => onChange(paths)}
          disabled={disabled}
        />
      );
    }
    case 'bundle-composer': {
      const current = Array.isArray(value) ? (value as BundleComposerEntry[]) : [];
      if (!repositoryId) {
        return (
          <p className="text-sm text-amber-300">
            Bundle composer requires a repository — none associated with this task.
          </p>
        );
      }
      return (
        <BundleComposer
          initialBundles={field.initialBundles}
          allowAddZip={field.allowAddZip}
          allowAddGit={field.allowAddGit}
          credentialOptions={field.credentialOptions}
          repositoryId={repositoryId}
          value={current}
          onChange={(next) => onChange(next)}
          disabled={disabled}
        />
      );
    }
  }
}
