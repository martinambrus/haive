/** Review progress is portable; runtime commands, credentials and security decisions are not. */
export const REVIEW_WATERMARK_KEYS = ['kbSyncedCommit', 'planSyncedCommit'] as const;
export type ReviewWatermarkKey = (typeof REVIEW_WATERMARK_KEYS)[number];
export type ReviewWatermarks = Partial<Record<ReviewWatermarkKey, string>>;
export const REVIEW_WATERMARK_SETTING = 'review-watermarks';
export const REVIEW_WATERMARK_UNIT = 'settings/review-watermarks.json';

export function reviewWatermarks(value: unknown): ReviewWatermarks | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: ReviewWatermarks = {};
  for (const key of REVIEW_WATERMARK_KEYS) {
    const sha = (value as Record<string, unknown>)[key];
    if (sha === undefined || sha === null) continue;
    if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) return null;
    out[key] = sha;
  }
  return out;
}

export function watermarkKeyOfUnit(unit: string): ReviewWatermarkKey | null {
  for (const key of REVIEW_WATERMARK_KEYS)
    if (unit === `${REVIEW_WATERMARK_UNIT}#${key}`) return key;
  return null;
}
