'use client';
import { useEffect, useState } from 'react';
import {
  previewDerivedTaskType,
  type ApiError,
  type DerivedTaskTypeCreate,
  type DerivedTaskTypeDiagnostics,
} from './api-client';

export const DERIVED_PREVIEW_DEBOUNCE_MS = 350;

export function useDerivedPreview(
  body: DerivedTaskTypeCreate | null,
  debounceMs = DERIVED_PREVIEW_DEBOUNCE_MS,
) {
  const [diagnostics, setDiagnostics] = useState<DerivedTaskTypeDiagnostics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const serialized = body === null ? null : JSON.stringify(body);
  useEffect(() => {
    if (forbidden) return;
    setDiagnostics(null);
    setError(null);
    if (serialized === null) return;
    let current = true;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void previewDerivedTaskType(
        JSON.parse(serialized) as DerivedTaskTypeCreate,
        controller.signal,
      )
        .then((result) => {
          if (current) setDiagnostics(result);
        })
        .catch((err: ApiError) => {
          if (!current) return;
          if (err.status === 403) setForbidden(true);
          // Invalid overlays return the same diagnostics with HTTP 400.
          const detail = err.body as DerivedTaskTypeDiagnostics | undefined;
          if (
            err.status === 400 &&
            Array.isArray(detail?.candidates) &&
            Array.isArray(detail?.issues)
          )
            setDiagnostics(detail);
          else setError(err.message ?? 'Could not preview the changes');
        });
    }, debounceMs);
    return () => {
      current = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [serialized, forbidden, debounceMs]);
  return { diagnostics, error, forbidden };
}
