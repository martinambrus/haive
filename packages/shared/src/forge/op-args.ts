import { isBranchName } from '../git-args.js';
import { ForgeError, type OpenPrInput } from './types.js';

const PR_NUMBER = /^[1-9][0-9]{0,9}$/;
const BRANCH_MAX_LENGTH = 255;
const TITLE_MAX_LENGTH = 256;
const BODY_MAX_LENGTH = 65_536;

export interface ForgeOpArgs {
  get_pull_request_state: { prNumber: string };
  open_pull_request: OpenPrInput;
}

export type ForgeOpArgsResult<T> = { ok: true; args: T } | { ok: false; error: string };

/** Throws before anything but a plain number can reach the path of a pull request URL. */
export function assertPrNumber(prNumber: string): void {
  if (!PR_NUMBER.test(prNumber)) throw new ForgeError('The pull request number is not a number');
}

function stringArgs<K extends string>(
  args: unknown,
  keys: readonly K[],
): Record<K, string> | string {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return 'arguments must be an object';
  }
  const given = args as Record<string, unknown>;
  for (const key of keys) {
    if (typeof given[key] !== 'string') return `${key} must be a string`;
  }
  if (Object.keys(given).length !== keys.length)
    return `arguments must be exactly: ${keys.join(', ')}`;
  return given as Record<K, string>;
}

const refuse = (error: string): { ok: false; error: string } => ({ ok: false, error });

export function validateForgeOpArgs<K extends keyof ForgeOpArgs>(
  opId: K,
  args: unknown,
): ForgeOpArgsResult<ForgeOpArgs[K]>;
export function validateForgeOpArgs(
  opId: string,
  args: unknown,
): ForgeOpArgsResult<ForgeOpArgs[keyof ForgeOpArgs]>;
export function validateForgeOpArgs(
  opId: string,
  args: unknown,
): ForgeOpArgsResult<ForgeOpArgs[keyof ForgeOpArgs]> {
  switch (opId) {
    case 'get_pull_request_state': {
      const fields = stringArgs(args, ['prNumber']);
      if (typeof fields === 'string') return refuse(fields);
      if (!PR_NUMBER.test(fields.prNumber)) {
        return refuse('prNumber must be a positive integer of at most 10 digits');
      }
      return { ok: true, args: { prNumber: fields.prNumber } };
    }
    case 'open_pull_request': {
      const fields = stringArgs(args, ['head', 'base', 'title', 'body']);
      if (typeof fields === 'string') return refuse(fields);
      if (!isBranchName(fields.head)) return refuse('head must be a valid branch name');
      if (fields.head.length > BRANCH_MAX_LENGTH) {
        return refuse(`head must be at most ${BRANCH_MAX_LENGTH} characters`);
      }
      if (!isBranchName(fields.base)) return refuse('base must be a valid branch name');
      if (fields.base.length > BRANCH_MAX_LENGTH) {
        return refuse(`base must be at most ${BRANCH_MAX_LENGTH} characters`);
      }
      if (fields.title.length < 1 || fields.title.length > TITLE_MAX_LENGTH) {
        return refuse(`title must be 1 to ${TITLE_MAX_LENGTH} characters`);
      }
      if (fields.body.length > BODY_MAX_LENGTH) {
        return refuse(`body must be at most ${BODY_MAX_LENGTH} characters`);
      }
      return { ok: true, args: fields };
    }
    default:
      return refuse('unknown operation');
  }
}
