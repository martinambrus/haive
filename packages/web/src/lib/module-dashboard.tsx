import type { ComponentType } from 'react';
import type { ModuleDashboardWidgetProps } from '@haive/web-kit/host';
import { api } from './api-client';

export type ModuleDashboardWidget = {
  id: string;
  Component: ComponentType<ModuleDashboardWidgetProps>;
};
export type ModuleDashboardWidgetEntry = ModuleDashboardWidget & { moduleId: string };

export function ModuleDashboardWidgets({
  widgets,
}: {
  widgets: readonly ModuleDashboardWidgetEntry[];
}) {
  return widgets.map(({ moduleId, id, Component }) => (
    <Component key={`${moduleId}:${id}`} moduleId={moduleId} api={api} />
  ));
}
