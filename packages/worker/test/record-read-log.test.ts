import { expect, it } from 'vitest';
import { isRecordReadLog } from './support/record-read-log.js';

it.each([
  `-c core.hooksPath=/dev/null ls-tree -r -l -z ${'a'.repeat(40)} -- .haive-data/state`,
  'ls-tree -r -l -z HEAD -- .haive-data/state',
  'ls-tree -z -l -r HEAD -- .haive-data/state',
  'ls-tree -r HEAD',
  `cat-file blob ${'b'.repeat(40)}`,
  `cat-file blob ${'b'.repeat(64)}`,
])('counts record reads without depending on a ref or flag order: %s', (line) => {
  expect(isRecordReadLog(line)).toBe(true);
});

it.each([
  'ls-tree -r -l -z HEAD -- .haive-data/state .haive-data/plan.json .haive-data/plan.md',
  'cat-file --batch',
  'cat-file blob HEAD:.haive-data/plan.md',
])('allows projection metadata and restore reads: %s', (line) => {
  expect(isRecordReadLog(line)).toBe(false);
});
