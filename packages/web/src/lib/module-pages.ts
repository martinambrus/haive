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

/** A compiled page wins; otherwise a declared page of exactly one segment. Both need the module in
 *  `modules` (the api omits a deactivated one), which is null until the list has loaded. */
export function resolveModuleRoute(
  registry: Readonly<Record<string, ModulePages>>,
  modules: readonly { id: string; pages: Readonly<Record<string, DashboardSpec>> }[] | null,
  moduleId: string,
  page: string[] | undefined,
): ModuleRoute {
  if (modules === null) return { kind: 'loading' };
  const listed = modules.find((m) => m.id === moduleId);
  if (listed === undefined) return { kind: 'not-found' };
  const Page = resolveModulePage(registry, moduleId, page);
  if (Page !== null) return { kind: 'component', Page };
  const segments = page ?? [];
  if (segments.length !== 1 || !Object.hasOwn(listed.pages, segments[0]!)) {
    return { kind: 'not-found' };
  }
  return { kind: 'dashboard', spec: listed.pages[segments[0]!]! };
}
