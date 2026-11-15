import { INSIGHTS_AT_GATE } from '@haive/shared';
/** A report page is bounded independently of its complete durable snapshot. */
export function markdownReportPage(
  payload: Record<string, unknown> | null,
  offset = 0,
  limit = INSIGHTS_AT_GATE,
) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1)
    throw new RangeError('Invalid report page.');
  if (
    payload?.version !== 1 ||
    typeof payload.title !== 'string' ||
    !Array.isArray(payload.items) ||
    payload.items.some((i) => typeof i !== 'string')
  )
    throw new Error('Unsupported markdown report.');
  const items = payload.items as string[];
  return {
    title: payload.title,
    body: items.slice(offset, offset + limit).join('\n\n'),
    offset,
    total: items.length,
    pageSize: limit,
  };
}
