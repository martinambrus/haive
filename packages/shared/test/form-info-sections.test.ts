import { describe, expect, it } from 'vitest';
import { formSchemaSchema, infoSectionSchema } from '../src/schemas/form.js';

describe('infoSectionSchema', () => {
  it('accepts a minimal section (title + body)', () => {
    const parsed = infoSectionSchema.parse({
      title: 'Prior findings',
      body: 'No errors so far.',
    });
    expect(parsed).toEqual({ title: 'Prior findings', body: 'No errors so far.' });
  });

  it('accepts a section with a preview line', () => {
    const parsed = infoSectionSchema.parse({
      title: 'Iteration history',
      preview: '2 passes • last score 7/10',
      body: 'Pass 1: …\nPass 2: …',
    });
    expect(parsed.preview).toBe('2 passes • last score 7/10');
  });

  it('rejects empty title', () => {
    expect(() => infoSectionSchema.parse({ title: '', body: 'x' })).toThrow();
  });

  it('rejects missing body', () => {
    expect(() => infoSectionSchema.parse({ title: 'x' })).toThrow();
  });

  it('rejects non-string preview', () => {
    expect(() => infoSectionSchema.parse({ title: 'x', body: 'y', preview: 42 })).toThrow();
  });

  it('accepts an optional defaultOpen flag', () => {
    const opened = infoSectionSchema.parse({ title: 'x', body: 'y', defaultOpen: true });
    const closed = infoSectionSchema.parse({ title: 'x', body: 'y', defaultOpen: false });
    const omitted = infoSectionSchema.parse({ title: 'x', body: 'y' });
    expect(opened.defaultOpen).toBe(true);
    expect(closed.defaultOpen).toBe(false);
    expect(omitted.defaultOpen).toBeUndefined();
  });

  it('rejects non-boolean defaultOpen', () => {
    expect(() => infoSectionSchema.parse({ title: 'x', body: 'y', defaultOpen: 'yes' })).toThrow();
  });
});

describe('formSchemaSchema with infoSections', () => {
  const baseForm = {
    title: 'Spec quality review',
    fields: [{ id: 'maxIterations', type: 'select' as const, label: 'Max', options: [] }],
  };

  it('accepts a form schema without infoSections (backwards-compat)', () => {
    const parsed = formSchemaSchema.parse(baseForm);
    expect(parsed.infoSections).toBeUndefined();
  });

  it('accepts a form schema with one infoSection', () => {
    const parsed = formSchemaSchema.parse({
      ...baseForm,
      infoSections: [{ title: 'History', body: 'Pass 0: 2 errors found.' }],
    });
    expect(parsed.infoSections).toHaveLength(1);
    expect(parsed.infoSections![0]!.title).toBe('History');
  });

  it('accepts a form schema with multiple infoSections', () => {
    const parsed = formSchemaSchema.parse({
      ...baseForm,
      infoSections: [
        { title: 'a', body: 'A' },
        { title: 'b', body: 'B', preview: 'shorter' },
      ],
    });
    expect(parsed.infoSections).toHaveLength(2);
  });

  it('rejects infoSections containing an invalid section', () => {
    const result = formSchemaSchema.safeParse({
      ...baseForm,
      infoSections: [{ title: '', body: 'x' }],
    });
    expect(result.success).toBe(false);
  });
});
