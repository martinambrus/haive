import type { ComponentType } from 'react';
import type { ModulePageProps } from '@haive/web-kit/host';
import { StatsPage } from './stats-page.js';

const pages: Record<string, ComponentType<ModulePageProps>> = { '': StatsPage };

export default pages;
