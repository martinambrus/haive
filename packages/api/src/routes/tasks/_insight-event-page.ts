import { INSIGHTS_AT_GATE } from '@haive/shared';

/** Page only browser copies. The worker replays the full durable protocol payload. */
export function insightEventPage(
  eventType: string,
  payload: Record<string, unknown> | null,
  offset = 0,
  limit = INSIGHTS_AT_GATE,
): Record<string, unknown> | null {
  const fields =
    eventType === 'insight.auto_round_started'
      ? ['insights']
      : eventType === 'insight.classified'
        ? ['items']
        : eventType === 'task.markdown_report'
          ? ['items']
          : eventType === 'insight.batch'
            ? ['selected', 'items']
            : [];
  if (!payload) return payload;
  // Historical journals may predate bounded digest evidence. Browser copies never need maps.
  const { worktreeBefore: _legacySnapshot, ...boundedBatch } = payload;
  let page = eventType === 'insight.batch' ? boundedBatch : payload;
  for (const key of fields) {
    const entries = payload[key];
    if (!Array.isArray(entries) || (!offset && entries.length <= limit)) continue;
    const shown = entries.slice(offset, offset + limit);
    page = {
      ...page,
      [key]: shown,
      [`${key}Omitted`]: entries.length - shown.length,
      insightOffset: offset,
    };
  }
  return page;
}
