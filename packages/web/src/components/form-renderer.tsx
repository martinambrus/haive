'use client';

import { useMemo, useState } from 'react';
import type { FormField, FormSchema } from '@haive/shared';
import { Button, FormError, Input, Label } from '@/components/ui';
import { cn } from '@/lib/cn';

export type FormValues = Record<string, unknown>;

interface FormRendererProps {
  schema: FormSchema;
  onSubmit: (values: FormValues) => void | Promise<void>;
  disabled?: boolean;
  submitting?: boolean;
  initialValues?: FormValues;
  errorMessage?: string | null;
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
    case 'checkbox':
      return field.default ?? false;
    case 'number':
      return field.default ?? field.min ?? 0;
    case 'directory-picker':
    case 'file-upload':
      return '';
  }
}

function buildInitial(schema: FormSchema, overrides?: FormValues): FormValues {
  const base: FormValues = {};
  for (const field of schema.fields) {
    base[field.id] = overrides?.[field.id] ?? defaultValueFor(field);
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
}: FormRendererProps) {
  const initial = useMemo(() => buildInitial(schema, initialValues), [schema, initialValues]);
  const [values, setValues] = useState<FormValues>(initial);

  function update(id: string, value: unknown) {
    setValues((prev) => ({ ...prev, [id]: value }));
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (disabled || submitting) return;
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
      <div className="flex flex-col gap-4">
        {schema.fields.map((field) => (
          <FieldRow
            key={field.id}
            field={field}
            value={values[field.id]}
            onChange={(value) => update(field.id, value)}
            disabled={disabled || submitting}
          />
        ))}
      </div>
      <FormError message={errorMessage ?? null} />
      <div>
        <Button type="submit" disabled={disabled || submitting}>
          {submitting ? 'Submitting...' : (schema.submitLabel ?? 'Submit')}
        </Button>
      </div>
    </form>
  );
}

interface FieldRowProps {
  field: FormField;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled: boolean;
}

function FieldRow({ field, value, onChange, disabled }: FieldRowProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={field.id}>
        {field.label}
        {field.required && <span className="ml-1 text-red-400">*</span>}
      </Label>
      {field.description && <p className="text-xs text-neutral-500">{field.description}</p>}
      <FieldControl field={field} value={value} onChange={onChange} disabled={disabled} />
    </div>
  );
}

function FieldControl({ field, value, onChange, disabled }: FieldRowProps) {
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
      return (
        <div className="flex flex-col gap-1.5">
          {field.options.map((opt) => {
            const checked = current.includes(opt.value);
            return (
              <label key={opt.value} className="flex items-center gap-2 text-sm text-neutral-200">
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
                {opt.label}
              </label>
            );
          })}
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
          <span>{field.description ?? 'Enabled'}</span>
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
  }
}
