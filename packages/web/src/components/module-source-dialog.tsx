'use client';

import { useState, type FormEvent } from 'react';
import { MODULE_ID_PATTERN_SOURCE, MODULE_ID_MAX_LENGTH } from '@haive/shared/modularity';
import {
  createModuleSource,
  updateModuleSource,
  deleteModuleSource,
  type ApiError,
  type ModuleInstallSource,
} from '@/lib/api-client';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/dialog';
import { InlineMarkdown } from '@/components/markdown/inline-markdown';
import { Button, FormError, Input, Label } from '@/components/ui';

export type ModuleSourceTarget = {
  mode: 'add' | 'edit' | 'delete';
  source?: ModuleInstallSource;
};

export function ModuleSourceDialog({
  target,
  onClose,
  onSaved,
}: {
  target: ModuleSourceTarget;
  onClose: () => void;
  onSaved: () => void;
}) {
  const source = target.source;
  const deleting = target.mode === 'delete';
  const [kind, setKind] = useState<'git' | 'registry'>(source?.kind ?? 'git');
  const [moduleId, setModuleId] = useState(source?.moduleId ?? '');
  const [url, setUrl] = useState(source?.url ?? '');
  const [ref, setRef] = useState(source?.ref ?? 'main');
  const [version, setVersion] = useState(source?.version ?? '');
  const [token, setToken] = useState('');
  const [clearToken, setClearToken] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (running) return;
    setRunning(true);
    setError(null);
    try {
      if (deleting && source) await deleteModuleSource(source.id);
      else {
        const body = {
          kind,
          moduleId,
          ...(kind === 'git'
            ? { url, ref }
            : { packageName: '@haive-module/' + moduleId, version }),
          ...(token ? { token } : {}),
          ...(clearToken ? { clearToken: true } : {}),
        };
        if (source) await updateModuleSource(source.id, body);
        else await createModuleSource(body);
      }
      setToken('');
      onSaved();
      onClose();
    } catch (err) {
      setError((err as ApiError).message ?? 'Failed to save the install source');
    } finally {
      setRunning(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent aria-labelledby="module-source-title">
        <DialogHeader>
          <DialogTitle id="module-source-title">
            {deleting
              ? 'Delete install source'
              : source
                ? 'Edit install source'
                : 'Add install source'}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
          <FormError message={error} />
          {deleting ? (
            <InlineMarkdown
              className="text-sm text-neutral-300"
              body="Delete this source and its stored access token? The installed module and its data are kept."
            />
          ) : (
            <>
              <Label htmlFor="source-kind">Source kind</Label>
              <select
                id="source-kind"
                value={kind}
                disabled={running}
                className="rounded-md border border-neutral-800 bg-neutral-950 p-2 text-sm"
                onChange={(event) => setKind(event.target.value as 'git' | 'registry')}
              >
                <option value="git">Git repository</option>
                <option value="registry">Registry package</option>
              </select>
              <Label htmlFor="source-module-id">Module id</Label>
              <Input
                id="source-module-id"
                value={moduleId}
                required
                maxLength={MODULE_ID_MAX_LENGTH}
                // HTML compiles patterns with the v flag, which requires literal hyphens escaped.
                pattern={MODULE_ID_PATTERN_SOURCE.replaceAll('-]', '\\-]')}
                disabled={running}
                onChange={(event) => setModuleId(event.target.value)}
              />
              {kind === 'git' ? (
                <>
                  <Label htmlFor="source-url">HTTPS repository URL</Label>
                  <Input
                    id="source-url"
                    type="url"
                    value={url}
                    required
                    disabled={running}
                    onChange={(event) => setUrl(event.target.value)}
                  />
                  <Label htmlFor="source-ref">Requested git ref</Label>
                  <Input
                    id="source-ref"
                    value={ref}
                    required
                    disabled={running}
                    onChange={(event) => setRef(event.target.value)}
                  />
                </>
              ) : (
                <>
                  <Label htmlFor="source-package">Package name</Label>
                  <Input id="source-package" value={'@haive-module/' + moduleId} readOnly />
                  <Label htmlFor="source-version">Exact version</Label>
                  <Input
                    id="source-version"
                    value={version}
                    required
                    disabled={running}
                    placeholder="1.2.3"
                    onChange={(event) => setVersion(event.target.value)}
                  />
                </>
              )}
              <Label htmlFor="source-token">Access token</Label>
              <Input
                id="source-token"
                type="password"
                autoComplete="new-password"
                value={token}
                disabled={running || clearToken}
                onChange={(event) => setToken(event.target.value)}
              />
              <InlineMarkdown
                className="text-sm text-neutral-400"
                body={
                  source?.hasToken
                    ? 'A token is stored. Leave blank to keep the stored token.'
                    : 'Optional. The token is write-only and is never displayed.'
                }
              />
              {source?.hasToken && (
                <Label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={clearToken}
                    disabled={running}
                    onChange={(event) => {
                      setClearToken(event.target.checked);
                      setToken('');
                    }}
                  />
                  Clear stored token
                </Label>
              )}
            </>
          )}
          {deleting && <code className="text-sm text-neutral-200">{source?.moduleId}</code>}
          <div className="mt-2 flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant={deleting ? 'destructive' : 'primary'} disabled={running}>
              {running ? 'Saving…' : deleting ? 'Delete source' : 'Save source'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
