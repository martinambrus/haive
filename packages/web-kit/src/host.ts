export interface HostApi {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
  delete<T>(path: string, body?: unknown): Promise<T>;
}

export interface HostApiError extends Error {
  status: number;
  code?: string;
  issues?: { path?: string; message?: string }[];
  /** The parsed error body, verbatim. Kept so an endpoint can hand the UI
   *  structured detail its message cannot carry — the plan delete's 409 names
   *  the tasks blocking it, and a list of links beats a sentence telling the
   *  user to go find them. Callers that do not need it ignore it. */
  body?: unknown;
}

export type ModulePageProps = { moduleId: string; path: string[]; api: HostApi };
export type ModuleDashboardWidgetProps = { moduleId: string; api: HostApi };
