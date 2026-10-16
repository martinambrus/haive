'use client';

import { useState } from 'react';
import {
  PROMPT_STEP_CAPABILITIES,
  PROMPT_STEP_TITLE_MAX_LENGTH,
  type PromptStepCapability,
  type PromptStepEntry,
} from '@haive/shared/modularity';
import type { StoredPromptStep } from '@/lib/api-client';
import type { PromptStepIssue } from '@/lib/composition-messages';
import {
  PROMPT_STEP_TIMEOUT_MAX_MINUTES,
  PROMPT_STEP_TIMEOUT_MIN_MINUTES,
} from '@/lib/prompt-step-editing';
import { Button, Input } from '@/components/ui';
import { InlineMarkdown } from '@/components/markdown/inline-markdown';
import { PromptStepTools } from '@/components/prompt-step-tools';

const CAPABILITY_LABELS: Record<PromptStepCapability, string> = {
  tool_use: 'Can use tools',
  file_write: 'Can write files',
  vision: 'Can read images',
};

const tokenHelp = (withFields: boolean) =>
  `Tokens: \`{{task.title}}\` \`{{task.description}}\`${withFields ? ' `{{field:<id>}}`' : ''} \`{{step:<id>}}\` \`{{agent:<id>}}\` \`{{integration:<id>.account}}\`. A \`{{step:<id>}}\` token must be alone on its line.`;

const NO_ISSUES: readonly PromptStepIssue[] = [];

interface PromptStepEditorProps {
  entry: StoredPromptStep;
  /** The step's problems that name one of its tools, shown on that tool's row. */
  issues?: readonly PromptStepIssue[];
  disabled?: boolean;
  onChange: (entry: PromptStepEntry) => void;
  onRemove: () => void;
}

export function PromptStepEditor({
  entry: stored,
  issues = NO_ISSUES,
  disabled = false,
  onChange,
  onRemove,
}: PromptStepEditorProps) {
  const entry: PromptStepEntry = { ...stored, tools: stored.tools ?? [] };
  const id = `prompt-step-${entry.slug}`;
  const [minutes, setMinutes] = useState(String(entry.timeoutMs / 60_000));

  function setCapability(capability: PromptStepCapability, on: boolean) {
    const rest = entry.capabilities.filter((c) => c !== capability);
    onChange({ ...entry, capabilities: on ? [...rest, capability] : rest });
  }

  function setMinutesText(raw: string) {
    setMinutes(raw);
    const value = Number(raw);
    onChange({
      ...entry,
      timeoutMs: raw.trim() !== '' && Number.isFinite(value) ? Math.round(value * 60_000) : 0,
    });
  }

  return (
    <div className="mt-3 flex flex-col gap-3 border-t border-neutral-800 pt-3">
      <label htmlFor={`${id}-title`} className="flex flex-col gap-1 text-xs text-neutral-400">
        Title
        <Input
          id={`${id}-title`}
          type="text"
          maxLength={PROMPT_STEP_TITLE_MAX_LENGTH}
          value={entry.title}
          disabled={disabled}
          onChange={(e) => onChange({ ...entry, title: e.target.value })}
          className="h-11 text-sm text-neutral-100"
        />
      </label>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-template`} className="text-xs text-neutral-400">
          Prompt template
        </label>
        <textarea
          id={`${id}-template`}
          rows={8}
          spellCheck={false}
          value={entry.template}
          disabled={disabled}
          onChange={(e) => onChange({ ...entry, template: e.target.value })}
          className="w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-sm text-neutral-100 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
        />
        <InlineMarkdown
          body={tokenHelp(entry.paramFormSchema !== undefined)}
          className="text-xs text-neutral-500"
        />
      </div>
      <fieldset className="flex flex-wrap gap-x-4 gap-y-1">
        <legend className="mb-1 text-xs text-neutral-400">Capabilities</legend>
        {PROMPT_STEP_CAPABILITIES.map((capability) => (
          <label
            key={capability}
            className="flex min-h-11 items-center gap-2 text-sm text-neutral-200"
          >
            <input
              type="checkbox"
              checked={entry.capabilities.includes(capability)}
              disabled={disabled}
              onChange={(e) => setCapability(capability, e.target.checked)}
            />
            {CAPABILITY_LABELS[capability]}
          </label>
        ))}
      </fieldset>
      <PromptStepTools
        tools={entry.tools}
        issues={issues}
        disabled={disabled}
        onChange={(tools) => onChange({ ...entry, tools })}
      />
      <label htmlFor={`${id}-timeout`} className="flex items-center gap-2 text-xs text-neutral-400">
        Timeout (minutes)
        <Input
          id={`${id}-timeout`}
          type="number"
          inputMode="decimal"
          min={PROMPT_STEP_TIMEOUT_MIN_MINUTES}
          max={PROMPT_STEP_TIMEOUT_MAX_MINUTES}
          step="any"
          value={minutes}
          disabled={disabled}
          onChange={(e) => setMinutesText(e.target.value)}
          className="h-11 w-24"
        />
      </label>
      <div>
        <Button
          type="button"
          variant="destructive"
          className="h-11"
          disabled={disabled}
          onClick={onRemove}
        >
          Remove prompt step
        </Button>
      </div>
    </div>
  );
}
