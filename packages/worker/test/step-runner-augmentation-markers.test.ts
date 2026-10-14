import { describe, expect, it } from 'vitest';
import { breakAugmentationMarkers } from '../src/step-engine/step-runner.js';

const M = '[[HAIVE_TEMPLATE_PERSONA:reviewer]]';
const BROKEN = '[[ HAIVE_TEMPLATE_PERSONA:reviewer]]';
const template = `Act as ${M}.`;

describe('breakAugmentationMarkers', () => {
  it('breaks a marker in a block put before the template and keeps the template whole', () => {
    expect(breakAugmentationMarkers(template, `files: ${M}\n\n${template}`, 'before')).toBe(
      `files: ${BROKEN}\n\n${template}`,
    );
  });

  it('breaks every marker in a block put after the template', () => {
    expect(breakAugmentationMarkers(template, `${template}\n- ${M} ${M}`, 'after')).toBe(
      `${template}\n- ${BROKEN} ${BROKEN}`,
    );
  });

  it('leaves an unchanged prompt alone', () => {
    expect(breakAugmentationMarkers(template, template, 'before')).toBe(template);
    expect(breakAugmentationMarkers(template, template, 'after')).toBe(template);
  });

  it('breaks the whole result when the template is not where its side says', () => {
    expect(breakAugmentationMarkers(template, `x ${template} ${M}`, 'after')).toBe(
      `x Act as ${BROKEN}. ${BROKEN}`,
    );
  });
});
