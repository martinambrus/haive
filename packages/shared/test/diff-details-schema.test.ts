import { describe, expect, it } from 'vitest';
import {
  diffDetailsSchema,
  formSchemaSchema,
  multiSelectFieldSchema,
  optionSchema,
  radioFieldSchema,
} from '../src/schemas/form.js';

describe('diffDetailsSchema', () => {
  it('parses minimal valid input with null baseline (new artifact case)', () => {
    const parsed = diffDetailsSchema.parse({
      kind: 'diff',
      baseline: null,
      current: 'hello\n',
    });
    expect(parsed).toEqual({ kind: 'diff', baseline: null, current: 'hello\n' });
  });

  it('parses with editable flag', () => {
    const parsed = diffDetailsSchema.parse({
      kind: 'diff',
      baseline: 'a',
      current: 'b',
      editable: true,
    });
    expect(parsed.editable).toBe(true);
  });

  it('rejects missing kind', () => {
    expect(() => diffDetailsSchema.parse({ baseline: null, current: 'x' })).toThrow();
  });

  it('rejects unknown kind discriminator', () => {
    expect(() =>
      diffDetailsSchema.parse({ kind: 'patch', baseline: null, current: 'x' }),
    ).toThrow();
  });

  it('rejects non-string current', () => {
    expect(() => diffDetailsSchema.parse({ kind: 'diff', baseline: null, current: 123 })).toThrow();
  });
});

describe('details on optionSchema (per-option diffs)', () => {
  it('accepts an option with diff details', () => {
    const opt = optionSchema.parse({
      value: 'e1:.claude/agents/code-reviewer.md',
      label: '.claude/agents/code-reviewer.md',
      group: 'Agents',
      details: {
        kind: 'diff',
        baseline: 'old',
        current: 'new',
        editable: false,
      },
    });
    expect(opt.details?.kind).toBe('diff');
    expect(opt.details?.baseline).toBe('old');
  });

  it('accepts an option without details (back-compat)', () => {
    const opt = optionSchema.parse({ value: 'x', label: 'X' });
    expect(opt.details).toBeUndefined();
  });

  it('multi-select round-trips options carrying diff details', () => {
    const field = multiSelectFieldSchema.parse({
      type: 'multi-select',
      id: 'selectedUpdates',
      label: 'Updates',
      options: [
        {
          value: 'a',
          label: '.claude/agents/a.md',
          group: 'Agents',
          details: { kind: 'diff', baseline: null, current: 'body', editable: false },
        },
      ],
    });
    expect(field.options[0].details?.baseline).toBeNull();
    expect(field.options[0].details?.current).toBe('body');
  });
});

describe('details on baseField (field-level diffs, e.g. conflict radios)', () => {
  it('radio field accepts field-level diff details', () => {
    const field = radioFieldSchema.parse({
      type: 'radio',
      id: 'conflict__abc',
      label: 'Conflict: .claude/agents/x.md',
      details: { kind: 'diff', baseline: 'their disk', current: 'new template' },
      options: [
        { value: 'apply_theirs', label: 'Overwrite' },
        { value: 'keep_ours', label: 'Keep mine' },
        { value: 'skip', label: 'Skip' },
      ],
      default: 'skip',
    });
    expect(field.details?.kind).toBe('diff');
    expect(field.details?.baseline).toBe('their disk');
  });

  it('whole formSchemaSchema accepts a mix of details-bearing fields', () => {
    const schema = formSchemaSchema.parse({
      title: 'Upgrade',
      fields: [
        {
          type: 'multi-select',
          id: 'selectedUpdates',
          label: 'Updates',
          options: [
            {
              value: 'a',
              label: 'a',
              details: { kind: 'diff', baseline: 'x', current: 'y', editable: false },
            },
          ],
        },
        {
          type: 'radio',
          id: 'conflict__abc',
          label: 'Conflict',
          details: { kind: 'diff', baseline: 'p', current: 'q' },
          options: [
            { value: 'a', label: 'A' },
            { value: 'b', label: 'B' },
          ],
        },
      ],
    });
    expect(schema.fields).toHaveLength(2);
  });
});
