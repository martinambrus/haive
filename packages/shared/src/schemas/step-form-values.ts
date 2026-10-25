import { gitRemoteUrlSchema } from './git-url.js';
import type { FormValidationFailure, FormValidationSuccess } from '../step-engine/schemas.js';

/** Only this core gate's named field is a Git destination. Other forms may use the
 *  same field name for arbitrary text; normalize before any answer or default is saved. */
export function normalizeStepFormValues(
  stepId: string,
  values: Record<string, unknown>,
): FormValidationSuccess | FormValidationFailure {
  if (stepId !== '11a-gate-4-push' || !Object.hasOwn(values, 'remoteUrl'))
    return { success: true, data: values };
  const raw = values.remoteUrl;
  if (raw == null || (typeof raw === 'string' && raw.trim() === ''))
    return { success: true, data: values };
  const parsed = gitRemoteUrlSchema.safeParse(raw);
  if (!parsed.success)
    return { success: false, issues: ['remoteUrl: must be a supported Git remote URL'] };
  return {
    success: true,
    data: parsed.data === raw ? values : { ...values, remoteUrl: parsed.data },
  };
}
