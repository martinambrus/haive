'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import {
  api,
  getModuleSettings,
  putModuleSettings,
  type ApiError,
  type ModuleSettingsKind,
  type ModuleSettingsPayload,
  type User,
} from '@/lib/api-client';
import { useModules } from '@/lib/use-modules';
import { usePageTitle } from '@/lib/use-page-title';
import { FormRenderer, type FormValues } from '@/components/form-renderer';
import { Card, FormError } from '@/components/ui';

function SettingsSection({
  moduleId,
  moduleName,
  kind,
  editable,
}: {
  moduleId: string;
  moduleName: string;
  kind: ModuleSettingsKind;
  editable: boolean;
}) {
  const [payload, setPayload] = useState<ModuleSettingsPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getModuleSettings(moduleId, kind)
      .then(setPayload)
      .catch((err) => setLoadError((err as ApiError).message ?? 'Failed to load settings'));
  }, [moduleId, kind]);

  async function save(values: FormValues) {
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const res = await putModuleSettings(moduleId, kind, values);
      setPayload((prev) => (prev ? { ...prev, values: res.values } : prev));
      setSaved(true);
    } catch (err) {
      setSaveError((err as ApiError).message ?? 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  if (loadError) return <FormError message={loadError} />;
  if (!payload) return null;
  return (
    <Card>
      <FormRenderer
        schema={payload.form}
        hideTitle={payload.form.title === moduleName}
        initialValues={payload.values}
        disabled={!editable}
        submitting={saving}
        errorMessage={saveError}
        onSubmit={save}
        onValuesChange={() => setSaved(false)}
      />
      {saved && <p className="mt-3 text-xs text-emerald-400">Saved.</p>}
    </Card>
  );
}

export default function ModuleSettingsPage() {
  const params = useParams<{ moduleId: string }>();
  const moduleId = params.moduleId;
  const { modules, error: modulesError } = useModules();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [meError, setMeError] = useState<string | null>(null);
  const module = modules === null ? undefined : (modules.find((m) => m.id === moduleId) ?? null);
  const error = modulesError ?? meError;
  usePageTitle(module ? `${module.name} settings` : 'Module settings');

  useEffect(() => {
    api
      .get<{ user: User }>('/auth/me')
      .then((me) => setIsAdmin(me.user.role === 'admin'))
      .catch((err) => setMeError((err as ApiError).message ?? 'Failed to load module'));
  }, []);

  if (error) return <FormError message={error} />;
  if (module === undefined || isAdmin === null) return null;

  const showGlobal = module?.hasGlobalSettings === true;
  const showAdmin = module?.hasAdminSettings === true && isAdmin;
  if (!module || (!showGlobal && !showAdmin)) {
    return <p className="text-sm text-neutral-400">This module has no settings.</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-lg font-semibold text-neutral-50">{module.name}</h2>
      {!isAdmin && (
        <p className="text-sm text-neutral-400">Only administrators can change these settings.</p>
      )}
      {showGlobal && (
        <SettingsSection
          moduleId={module.id}
          moduleName={module.name}
          kind="global"
          editable={isAdmin}
        />
      )}
      {showAdmin && (
        <SettingsSection moduleId={module.id} moduleName={module.name} kind="admin" editable />
      )}
    </div>
  );
}
