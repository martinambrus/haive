import type { ComponentType } from 'react';

export type ModuleDashboardWidget = { id: string; Component: ComponentType<{ moduleId: string }> };
export type ModuleDashboardWidgetEntry = ModuleDashboardWidget & { moduleId: string };

export function ModuleDashboardWidgets({
  widgets,
}: {
  widgets: readonly ModuleDashboardWidgetEntry[];
}) {
  return widgets.map(({ moduleId, id, Component }) => (
    <Component key={`${moduleId}:${id}`} moduleId={moduleId} />
  ));
}
