import { describe, expect, it } from 'vitest';
import { bodyToSave } from './body-edit';

const loaded = 'Use ```fenced``` examples.';
const normalized = 'Use `fenced` examples.';

describe('bodyToSave', () => {
  it('sends no body when the text is the loaded one', () => {
    expect(bodyToSave(loaded, loaded, normalized)).toBeUndefined();
  });

  it('sends no body when the editor only re-serialized the loaded text', () => {
    expect(bodyToSave(loaded, normalized, normalized)).toBeUndefined();
  });

  it('sends the body when the person changed it', () => {
    expect(bodyToSave(loaded, `${normalized} More.`, normalized)).toBe(`${normalized} More.`);
  });

  it('sends a changed body before the editor reported its baseline', () => {
    expect(bodyToSave(loaded, 'Other.', null)).toBe('Other.');
  });
});
