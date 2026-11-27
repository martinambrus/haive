/** Display and audit copy only. The stored URL remains private transport input. */
export function displayOllamaUrl(value: string | null | undefined): string {
  if (!value) return '';
  try {
    const url = new URL(value);
    if (!url.username && !url.password) return value;
    url.username = '***';
    url.password = '';
    return url.toString();
  } catch {
    // An invalid stored value may still contain credentials; never echo it.
    return '(invalid URL)';
  }
}

/** A redaction is a keep instruction, including a stale form's redaction. */
export function isOllamaUrlRedaction(value: string): boolean {
  if (value === '(invalid URL)') return true;
  try {
    return new URL(value).username === '***';
  } catch {
    return false;
  }
}

/** Older append-only audit rows may predate URL redaction. Sanitize their read projection too. */
export function displayGlobalKbAuditMetadata(action: string, metadata: unknown): unknown {
  if (
    action !== 'config.global_kb' ||
    !metadata ||
    typeof metadata !== 'object' ||
    Array.isArray(metadata)
  ) {
    return metadata;
  }
  const safe = { ...metadata } as Record<string, unknown>;
  for (const side of ['from', 'to']) {
    const values = safe[side];
    if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
    const settings = values as Record<string, unknown>;
    if (typeof settings.ollamaUrl === 'string') {
      safe[side] = { ...settings, ollamaUrl: displayOllamaUrl(settings.ollamaUrl) };
    }
  }
  return safe;
}
