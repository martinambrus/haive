'use client';

import { useEffect, useState, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import {
  widgetResponseSchema,
  type DashboardSpec,
  type DashboardWidget,
} from '@haive/shared/modularity';
import { Card, FormError } from '@haive/web-kit/ui';
import type { HostApi } from '@haive/web-kit/host';
import { API_BASE_URL } from '@/lib/api-client';
import { StatusSummary } from './form-renderer';
import { MarkdownView } from './markdown/markdown-view';

type RemoteType = 'kpi' | 'table' | 'meter' | 'status' | 'chart';
type ResponseOf<T extends RemoteType> = ReturnType<typeof widgetResponseSchema<T>>['_output'];

const DashboardChart = dynamic(() => import('./dashboard-chart'), {
  ssr: false,
  loading: () => <div className="h-[220px] text-sm text-neutral-500">Loading chart...</div>,
});

/** True when the endpoint, resolved the way fetch resolves it, stays on the api origin inside
 *  /m/<moduleId>; encoded or literal dot segments are collapsed by the URL parser before the check. */
export function isModuleEndpoint(moduleId: string, endpoint: string, apiBase: string): boolean {
  let url: URL;
  try {
    url = new URL(apiBase + endpoint);
  } catch {
    return false;
  }
  const base = new URL(apiBase);
  if (url.origin !== base.origin) return false;
  const prefix = `${base.pathname.replace(/\/$/, '')}/m/${moduleId}`;
  return url.pathname === prefix || url.pathname.startsWith(`${prefix}/`);
}

export async function fetchWidgetData<T extends RemoteType>(
  api: HostApi,
  moduleId: string,
  type: T,
  endpoint: string,
  apiBase: string = API_BASE_URL,
): Promise<ResponseOf<T>> {
  if (!isModuleEndpoint(moduleId, endpoint, apiBase)) {
    throw new Error('Widget endpoint is outside this module.');
  }
  const parsed = widgetResponseSchema(type).safeParse(await api.get<unknown>(endpoint));
  if (!parsed.success) throw new Error('The endpoint returned an invalid response.');
  return parsed.data as ResponseOf<T>;
}

function Remote<T extends RemoteType>({
  api,
  moduleId,
  type,
  endpoint,
  inline,
  children,
}: {
  api: HostApi;
  moduleId: string;
  type: T;
  endpoint: string | undefined;
  inline: ResponseOf<T> | undefined;
  children: (data: ResponseOf<T>) => ReactNode;
}) {
  const [state, setState] = useState<{ data: ResponseOf<T> } | { error: string } | null>(null);
  const refused = endpoint !== undefined && !isModuleEndpoint(moduleId, endpoint, API_BASE_URL);
  useEffect(() => {
    if (endpoint === undefined || refused) return;
    let live = true;
    fetchWidgetData(api, moduleId, type, endpoint)
      .then((data) => live && setState({ data }))
      .catch((err: unknown) => {
        if (live) setState({ error: err instanceof Error ? err.message : 'Failed to load.' });
      });
    return () => {
      live = false;
    };
  }, [api, moduleId, type, endpoint, refused]);

  if (inline !== undefined) return <>{children(inline)}</>;
  if (endpoint === undefined) return null;
  if (refused) return <FormError message="Widget endpoint is outside this module." />;
  if (state === null) return <div className="text-sm text-neutral-500">Loading...</div>;
  if ('error' in state) return <FormError message={state.error} />;
  return <>{children(state.data)}</>;
}

function CellText({ value }: { value: string | number | null | undefined }) {
  return <>{value === null || value === undefined ? '-' : String(value)}</>;
}

function Frame({ span, children }: { span: string; children: ReactNode }) {
  return <Card className={`min-w-0 p-4 ${span}`}>{children}</Card>;
}

function Heading({ children }: { children?: string }) {
  if (!children) return null;
  return <h3 className="mb-2 text-sm font-medium text-neutral-300">{children}</h3>;
}

const FULL = 'col-span-full';

function WidgetView({
  widget,
  moduleId,
  api,
}: {
  widget: DashboardWidget;
  moduleId: string;
  api: HostApi;
}) {
  switch (widget.type) {
    case 'kpi':
      return (
        <Frame span="">
          <div className="text-xs text-neutral-400">{widget.label}</div>
          <Remote
            api={api}
            moduleId={moduleId}
            type="kpi"
            endpoint={widget.endpoint}
            inline={
              widget.value === undefined ? undefined : { value: widget.value, unit: widget.unit }
            }
          >
            {(d) => (
              <div className="mt-1 break-words text-2xl font-semibold text-neutral-50">
                {d.value}
                {(d.unit ?? widget.unit) && (
                  <span className="ml-1 text-sm font-normal text-neutral-400">
                    {d.unit ?? widget.unit}
                  </span>
                )}
              </div>
            )}
          </Remote>
        </Frame>
      );
    case 'meter':
      return (
        <Frame span="">
          <div className="text-xs text-neutral-400">{widget.label}</div>
          <Remote
            api={api}
            moduleId={moduleId}
            type="meter"
            endpoint={widget.endpoint}
            inline={
              widget.value === undefined || widget.max === undefined
                ? undefined
                : { value: widget.value, max: widget.max }
            }
          >
            {(d) => {
              const pct = d.max > 0 ? Math.min(100, Math.max(0, (d.value / d.max) * 100)) : 0;
              return (
                <div className="mt-2">
                  <div
                    role="progressbar"
                    aria-label={widget.label}
                    aria-valuemin={0}
                    aria-valuemax={d.max}
                    aria-valuenow={d.value}
                    className="h-2 overflow-hidden rounded-full bg-neutral-800"
                  >
                    <div className="h-full bg-indigo-400" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="mt-1 text-xs text-neutral-400">
                    {d.value} / {d.max}
                  </div>
                </div>
              );
            }}
          </Remote>
        </Frame>
      );
    case 'table':
      return (
        <Frame span={FULL}>
          <Heading>{widget.title}</Heading>
          <Remote
            api={api}
            moduleId={moduleId}
            type="table"
            endpoint={widget.endpoint}
            inline={widget.rows === undefined ? undefined : { rows: widget.rows }}
          >
            {(d) => (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-neutral-800 text-xs text-neutral-400">
                      {widget.columns.map((c) => (
                        <th key={c.key} className="px-2 py-1 font-medium">
                          {c.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {d.rows.map((row, i) => (
                      <tr key={i} className="border-b border-neutral-800 last:border-b-0">
                        {widget.columns.map((c) => (
                          <td key={c.key} className="px-2 py-1 text-neutral-200">
                            <CellText value={row[c.key]} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Remote>
        </Frame>
      );
    case 'markdown':
      return (
        <Frame span={FULL}>
          <MarkdownView body={widget.body} />
        </Frame>
      );
    case 'status':
      return (
        <Frame span={FULL}>
          <Heading>{widget.title}</Heading>
          <Remote
            api={api}
            moduleId={moduleId}
            type="status"
            endpoint={widget.endpoint}
            inline={undefined}
          >
            {(d) => <StatusSummary items={d.items} />}
          </Remote>
        </Frame>
      );
    case 'chart':
      return (
        <Frame span="sm:col-span-2">
          <Heading>{widget.title}</Heading>
          <Remote
            api={api}
            moduleId={moduleId}
            type="chart"
            endpoint={widget.endpoint}
            inline={widget.data === undefined ? undefined : { data: widget.data }}
          >
            {(d) => (
              <DashboardChart
                kind={widget.kind}
                xKey={widget.xKey}
                series={widget.series}
                data={d.data}
              />
            )}
          </Remote>
        </Frame>
      );
  }
}

export function DashboardRenderer({
  moduleId,
  spec,
  api,
}: {
  moduleId: string;
  spec: DashboardSpec;
  api: HostApi;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {spec.widgets.map((widget, i) => (
        <WidgetView key={i} widget={widget} moduleId={moduleId} api={api} />
      ))}
    </div>
  );
}
