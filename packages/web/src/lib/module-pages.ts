import type { ComponentType } from 'react';
import type { DashboardSpec } from '@haive/shared/modularity';
import type { ModulePageProps } from '@haive/web-kit/host';

export type { ModulePageProps };
export type ModulePages = Readonly<Record<string, ComponentType<ModulePageProps>>>;

export function resolveModulePage(
  registry: Readonly<Record<string, ModulePages>>,
  moduleId: string,
  page: string[] | undefined,
): ComponentType<ModulePageProps> | null {
  // hasOwn: a moduleId or page path such as "constructor" must not reach Object.prototype.
  if (!Object.hasOwn(registry, moduleId)) return null;
  const pages = registry[moduleId]!;
  const key = (page ?? []).join('/');
  return Object.hasOwn(pages, key) ? pages[key]! : null;
}

export type ModuleRoute =
  | { kind: 'component'; Page: ComponentType<ModulePageProps> }
  | { kind: 'dashboard'; spec: DashboardSpec }
  | { kind: 'loading' }
  | { kind: 'not-found' };

/** A compiled page wins; otherwise a declared page of exactly one segment. `modules` is null until
 *  the module list has loaded. */
export function resolveModuleRoute(
  registry: Readonly<Record<string, ModulePages>>,
  modules: readonly { id: string; pages: Readonly<Record<string, DashboardSpec>> }[] | null,
  moduleId: string,
  page: string[] | undefined,
): ModuleRoute {
  const Page = resolveModulePage(registry, moduleId, page);
  if (Page !== null) return { kind: 'component', Page };
  if (modules === null) return { kind: 'loading' };
  const pages = modules.find((m) => m.id === moduleId)?.pages;
  const segments = page ?? [];
  if (pages === undefined || segments.length !== 1 || !Object.hasOwn(pages, segments[0]!)) {
    return { kind: 'not-found' };
  }
  return { kind: 'dashboard', spec: pages[segments[0]!]! };
}
