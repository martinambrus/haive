import { expect, it } from 'vitest';
import * as constants from '../src/constants/index.js';

it('pins terminal refusal codes without colliding with login banner codes', () => {
  const codes = (constants as unknown as Record<string, unknown>).TERMINAL_CLOSE_CODES;
  expect(codes).toEqual({
    CONTAINER_NOT_RUNNING: 4420,
    CONTAINER_NOT_BOUND: 4421,
    TASK_TERMINAL_DISABLED: 4422,
    REPO_READ_ONLY: 4423,
    REPO_NOT_READY: 4424,
  });
  const all = [
    ...Object.values(codes as Record<string, number>),
    ...Object.values(constants.CLI_LOGIN_CLOSE_CODES),
  ];
  expect(new Set(all).size).toBe(all.length);
  expect(all.every((code) => code >= 4000 && code <= 4999)).toBe(true);
});
