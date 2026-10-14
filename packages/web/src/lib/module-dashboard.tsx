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
  modules,
}: {
  widgets: readonly ModuleDashboardWidgetEntry[];
  modules: readonly { id: string }[] | null;
}) {
  if (modules === null) return null;
  const listed = new Set(modules.map((m) => m.id));
  return widgets
    .filter(({ moduleId }) => listed.has(moduleId))
    .map(({ moduleId, id, Component }) => (
      <Component key={`${moduleId}:${id}`} moduleId={moduleId} api={api} />
    ));
}
