/** True only for parseable HTTP(S) transport input. Never echo a rejected value. */
export function isValidOllamaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Display and audit copy: only scheme, host and port; private components are markers. */
export function displayOllamaUrl(value: string | null | undefined): string {
  if (!value) return '';
  if (!isValidOllamaUrl(value)) return '(invalid URL)';
  const url = new URL(value);
  return `${url.protocol}//${url.username || url.password ? '***@' : ''}${url.host}${
    url.pathname !== '/' ? '/***' : ''
  }${url.href.split('#')[0]!.includes('?') ? '?***' : ''}${url.href.includes('#') ? '#***' : ''}`;
}

/** Recognize exactly our display forms with hidden components, never a partially edited URL. */
export function isOllamaUrlRedaction(value: string): boolean {
  if (value === '(invalid URL)') return true;
  if (!isValidOllamaUrl(value) || displayOllamaUrl(value) !== value) return false;
  const url = new URL(value);
  return (
    url.username === '***' ||
    url.pathname === '/***' ||
    url.search === '?***' ||
    url.hash === '#***'
  );
}

/** A keep instruction may not silently change its visible destination. */
export function ollamaUrlRedactionMatches(value: string, stored: string): boolean {
  if (value === '(invalid URL)') return displayOllamaUrl(stored) === value;
  return isValidOllamaUrl(stored) && new URL(value).origin === new URL(stored).origin;
}

/** Audit a private-component change without recording any of its values. */
export function ollamaUrlHiddenPartsChanged(before: string | null, after: string): boolean {
  if (
    !before ||
    !isValidOllamaUrl(before) ||
    !isValidOllamaUrl(after) ||
    displayOllamaUrl(before) !== displayOllamaUrl(after)
  )
    return false;
  const from = new URL(before);
  const to = new URL(after);
  return (['username', 'password', 'pathname', 'search', 'hash'] as const).some(
    (key) => from[key] !== to[key],
  );
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
