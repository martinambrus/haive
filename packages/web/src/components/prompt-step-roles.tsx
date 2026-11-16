'use client';

import {
  STEP_ROLE_REGISTRY,
  isQuotableRole,
  isPromptProvidableRole,
  type StepRoleId,
} from '@haive/shared/step-outputs';
import type { PromptStepEntry } from '@haive/shared/modularity';
import { Button, Input } from '@/components/ui';
import { InlineMarkdown } from '@/components/markdown/inline-markdown';

const roles = Object.values(STEP_ROLE_REGISTRY);
const providable = roles.filter((r) => isPromptProvidableRole(r.id));
const selectClass = 'h-11 rounded-md border border-neutral-800 bg-neutral-950 px-2 text-sm';

export function PromptStepRoles({
  entry,
  disabled,
  onChange,
}: {
  entry: PromptStepEntry;
  disabled: boolean;
  onChange: (entry: PromptStepEntry) => void;
}) {
  const inputs = entry.consumesRoles ?? [];
  const output = entry.providesRoles?.[0];
  const update = (index: number, patch: Partial<(typeof inputs)[number]>) =>
    onChange({
      ...entry,
      consumesRoles: inputs.map((i, n) => (n === index ? { ...i, ...patch } : i)),
      ...(patch.input !== undefined && patch.input !== inputs[index]?.input
        ? {
            template: entry.template.replaceAll(
              `{{role:${inputs[index]!.input}}}`,
              `{{role:${patch.input}}}`,
            ),
          }
        : {}),
    });
  return (
    <div className="flex flex-col gap-3">
      <fieldset className="flex flex-col gap-2">
        <legend className="text-xs text-neutral-400">Role inputs</legend>
        <InlineMarkdown
          body="Role inputs quote agent-only output. Each token must be alone on its line; mixed or human roles require a host adapter."
          className="text-xs text-neutral-500"
        />
        {inputs.map((input, index) => (
          <div key={index} className="flex flex-wrap items-center gap-2">
            <label className="text-xs">
              Input name
              <Input
                aria-label={`Role input ${index + 1} name`}
                value={input.input}
                disabled={disabled}
                onChange={(e) => update(index, { input: e.target.value })}
              />
            </label>
            <label className="text-xs">
              Role
              <select
                className={selectClass}
                aria-label={`Role input ${index + 1} role`}
                value={input.role}
                disabled={disabled}
                onChange={(e) => {
                  const role = e.target.value as StepRoleId;
                  update(index, { role, contract: STEP_ROLE_REGISTRY[role].contract });
                }}
              >
                {roles
                  .filter((r) => isQuotableRole(r.id) || r.id === input.role)
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.id} — {r.contract.id}@{r.contract.version}
                    </option>
                  ))}
              </select>
            </label>
            <label className="flex min-h-11 items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={input.optional}
                disabled={disabled}
                onChange={(e) => update(index, { optional: e.target.checked })}
              />
              Optional
            </label>
            <InlineMarkdown
              body={`\`{{role:${input.input}}}\` · \`${input.contract.id}@${input.contract.version}\``}
              className="text-xs"
            />
            <Button
              type="button"
              disabled={disabled}
              onClick={() =>
                onChange({
                  ...entry,
                  template: `${entry.template}${entry.template.endsWith('\n') || !entry.template ? '' : '\n'}{{role:${input.input}}}\n`,
                })
              }
            >
              Insert token
            </Button>
            <Button
              type="button"
              disabled={disabled}
              onClick={() =>
                onChange({ ...entry, consumesRoles: inputs.filter((_, n) => n !== index) })
              }
            >
              Remove input
            </Button>
          </div>
        ))}
        <Button
          type="button"
          disabled={disabled || inputs.length >= 32}
          onClick={() => {
            let n = 1;
            while (inputs.some((i) => i.input === `report-${n}`)) n++;
            const role = roles.find((r) => isQuotableRole(r.id))!;
            onChange({
              ...entry,
              consumesRoles: [
                ...inputs,
                { input: `report-${n}`, role: role.id, contract: role.contract, optional: false },
              ],
            });
          }}
        >
          Add role input
        </Button>
      </fieldset>
      <label className="flex min-h-11 items-center gap-2 text-xs">
        <input
          type="checkbox"
          disabled={disabled || providable.length === 0}
          checked={entry.outputMode === 'structured'}
          onChange={(e) => {
            if (e.target.checked) {
              onChange({
                ...entry,
                outputMode: 'structured',
                providesRoles: output && isPromptProvidableRole(output.role) ? [output] : [],
              });
            } else {
              const { outputMode: _mode, providesRoles: _provides, ...raw } = entry;
              onChange(raw);
            }
          }}
        />
        Structured output
      </label>
      {providable.length === 0 && (
        <InlineMarkdown
          body="Structured output is unavailable: no agent-only data roles can currently be provided."
          className="text-xs text-neutral-500"
        />
      )}
      {(entry.outputMode === 'structured' || output) && (
        <>
          <label className="flex flex-col gap-1 text-xs">
            Provided role
            <select
              aria-label="Provided role"
              className={selectClass}
              disabled={disabled || providable.length === 0}
              value={output && isPromptProvidableRole(output.role) ? output.role : ''}
              onChange={(e) => {
                const role = e.target.value as StepRoleId;
                onChange({
                  ...entry,
                  providesRoles: [{ role, contract: STEP_ROLE_REGISTRY[role].contract }],
                });
              }}
            >
              <option value="" disabled>
                Select a role
              </option>
              {providable.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.id} — {r.contract.id}@{r.contract.version}
                </option>
              ))}
            </select>
          </label>
          <InlineMarkdown
            body={`Return a JSON object with \`contract\` and \`data\`. Haive validates the exact contract${output ? ` \`${output.contract.id}@${output.contract.version}\`` : ''} before publishing the output. Invalid replies fail this step. Roles carry data only.`}
            className="text-xs text-neutral-500"
          />
        </>
      )}
    </div>
  );
}
