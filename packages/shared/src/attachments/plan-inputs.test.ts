import { describe, expect, it } from 'vitest';
import { PLAN_INPUT_SIDECAR_SUFFIX, planInputSidecarName } from './plan-inputs.js';

describe('planInputSidecarName', () => {
  it('suffixes the original’s own name', () => {
    expect(planInputSidecarName('spec.docx')).toBe('spec.docx.extracted.md');
    expect(planInputSidecarName('spec.docx').endsWith(PLAN_INPUT_SIDECAR_SUFFIX)).toBe(true);
  });

  it('keeps the folder, because an attachment name is a relative path', () => {
    expect(planInputSidecarName('docs/api/spec.pdf')).toBe('docs/api/spec.pdf.extracted.md');
  });

  it('never gives two originals one sidecar', () => {
    expect(planInputSidecarName('spec.docx')).not.toBe(planInputSidecarName('spec.xlsx'));
  });
});
