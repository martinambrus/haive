import { parseCategoryId, parseProviderId } from '@haive/shared/modularity';
import type { IntegrationCategoryOption } from '@/components/prompt-step-integrations';
import type { TaskTypeCatalog } from './api-client';
import type { IntegrationProvider } from './integrations';

export interface ComposerIntegrationInfo {
  status: 'loading' | 'error' | 'current';
  providers: readonly IntegrationProvider[];
  categories: readonly IntegrationCategoryOption[];
  modules: TaskTypeCatalog['modules'];
}

/** Labels are data, never Markdown or a place to hide control characters. */
export function integrationLabel(label: string | undefined, id: string): string {
  return label?.trim() && label.length <= 200 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(label)
    ? label
    : id;
}

export function providerInstallState(id: string, info: ComposerIntegrationInfo): string {
  const provider = info.providers.find((item) => item.id === id);
  const parsed = parseProviderId(id);
  if (parsed?.kind === 'module') {
    const module = info.modules.find((item) => item.id === parsed.moduleId);
    if (module?.state === 'missing' || (!module && !provider)) return 'Module missing';
    if (module?.state === 'deactivated') return 'Module deactivated';
    if (!module) return 'Module state unknown';
    if (!provider) return 'Provider not registered';
  }
  if (!provider) return 'Unknown provider';
  return provider.enabled ? 'Installed and enabled' : 'Provider disabled';
}

export function categoryInstallNote(id: string, info: ComposerIntegrationInfo): string | null {
  const parsed = parseCategoryId(id);
  if (parsed?.kind === 'module') {
    const module = info.modules.find((item) => item.id === parsed.moduleId);
    if (!module) {
      return info.categories.some((item) => item.id === id)
        ? 'Module state unknown'
        : 'Module missing';
    }
    if (module.state === 'missing') return 'Module missing';
    if (module.state === 'deactivated') return 'Module deactivated';
  }
  return info.categories.some((item) => item.id === id) ? null : 'Category unavailable';
}
