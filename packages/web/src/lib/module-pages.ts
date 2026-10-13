import type { ComponentType } from 'react';
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
