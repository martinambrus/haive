import type { ComponentType } from 'react';
import type { ModuleDashboardWidgetProps } from '@haive/web-kit/host';
import { StatsWidget } from './stats-widget.js';

const widgets: { id: string; Component: ComponentType<ModuleDashboardWidgetProps> }[] = [
  { id: 'overview', Component: StatsWidget },
];

export default widgets;
