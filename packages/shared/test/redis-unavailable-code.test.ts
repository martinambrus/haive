import { expect, it } from 'vitest';
import * as constants from '../src/constants/index.js';
it('exports the stable Redis unavailable contract for all writers and matchers', () => {
  expect(constants).toHaveProperty('REDIS_UNAVAILABLE_CODE', 'redis_unavailable');
});
