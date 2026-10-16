'use client';

import { useState, type InputHTMLAttributes } from 'react';
import {
  CUSTOM_TOOLS_MAX_PER_STEP,
  CUSTOM_TOOL_DESCRIPTION_MAX_LENGTH,
  CUSTOM_TOOL_NAME_MAX_LENGTH,
  CUSTOM_TOOL_PARAMS_MAX,
  CUSTOM_TOOL_PARAM_DESCRIPTION_MAX_LENGTH,
  CUSTOM_TOOL_RESPONSE_MAX_BYTES,
  CUSTOM_TOOL_RESPONSE_MIN_BYTES,
  CUSTOM_TOOL_TIMEOUT_MAX_MS,
  CUSTOM_TOOL_TIMEOUT_MIN_MS,
  CUSTOM_TOOL_URL_MAX_LENGTH,
  RAG_QUERY_TOP_K_MAX,
  RAG_QUERY_TOP_K_MIN,
  type CustomTool,
  type CustomToolParam,
  type RagQueryTool,
} from '@haive/shared/modularity';
import { describePromptStepIssue, type PromptStepIssue } from '@/lib/composition-messages';
import {
  isToolIssue,
  newParam,
  newTool,
  type ParamType,
  type ToolAction,
} from '@/lib/prompt-step-editing';
import { cn } from '@/lib/cn';
import { Button, Input } from '@/components/ui';
import { InlineMarkdown } from '@/components/markdown/inline-markdown';

const FIELD = 'flex flex-col gap-1 text-xs text-neutral-400';
const CONTROL =
  'rounded-md border border-neutral-800 bg-neutral-950 px-3 text-sm text-neutral-100 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500';

const ACTIONS: Record<ToolAction, string> = {
  'http-get': 'Fetch a URL (GET)',
  'rag-query': 'Search knowledge',
};
const SCOPES: Record<RagQueryTool['scope'], string> = {
  project: 'This project',
  global: 'Global knowledge base',
  all: 'Project and global',
};
const PARAM_TYPES: Record<ParamType, string> = {
  string: 'Text',
  integer: 'Whole number',
  boolean: 'Yes or no',
  enum: 'One of a list',
};

type TextFieldProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'disabled' | 'className'
> & {
  label: string;
  value: string;
  disabled: boolean;
  onValue: (text: string) => void;
  rows?: number;
};

function TextField({ label, value, disabled, onValue, rows, ...input }: TextFieldProps) {
  return (
    <label className={FIELD}>
      {label}
      {rows === undefined ? (
        <Input
          {...input}
          value={value}
          disabled={disabled}
          onChange={(e) => onValue(e.target.value)}
          className="h-11 text-sm text-neutral-100"
        />
      ) : (
        <textarea
          rows={rows}
          placeholder={input.placeholder}
          value={value}
          disabled={disabled}
          onChange={(e) => onValue(e.target.value)}
          className={cn('w-full py-2', CONTROL)}
        />
      )}
    </label>
  );
}

// A line break is a control character, which a description may not hold; it becomes a space.
const oneLine = (text: string) => text.replace(/[\r\n]+/g, ' ');

interface Codec<T> {
  show: (value: T) => string;
  read: (text: string) => T;
}

const numberOf = (text: string): number | undefined => {
  const value = Number(text);
  return text.trim() !== '' && Number.isFinite(value) ? value : undefined;
};
const WHOLE: Codec<number> = { show: String, read: (text) => numberOf(text) ?? 0 };
// Shown in seconds and KiB, stored as the milliseconds and bytes the api checks.
const SECONDS: Codec<number> = {
  show: (ms) => String(ms / 1000),
  read: (text) => Math.round((numberOf(text) ?? 0) * 1000),
};
const KIB: Codec<number> = {
  show: (bytes) => String(bytes / 1024),
  read: (text) => Math.round((numberOf(text) ?? 0) * 1024),
};
const OPTIONAL_WHOLE: Codec<number | undefined> = {
  show: (value) => (value === undefined ? '' : String(value)),
  read: numberOf,
};
const LIST: Codec<string[]> = {
  show: (value) => value.join(', '),
  read: (text) =>
    text
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== ''),
};
const LINES: Codec<string[]> = {
  show: (value) => value.join('\n'),
  read: (text) => text.split(/\r?\n/).filter((line) => line.trim() !== ''),
};

type ParsedFieldProps<T> = Omit<TextFieldProps, 'value' | 'onValue'> & {
  value: T;
  codec: Codec<T>;
  onValue: (value: T) => void;
};

// Typed text stays while it still reads as the value, so a trailing comma survives.
function ParsedField<T>({ value, codec, onValue, ...field }: ParsedFieldProps<T>) {
  const [text, setText] = useState(() => codec.show(value));
  const same = JSON.stringify(codec.read(text)) === JSON.stringify(value);
  return (
    <TextField
      {...field}
      value={same ? text : codec.show(value)}
      onValue={(next) => {
        setText(next);
        onValue(codec.read(next));
      }}
    />
  );
}

interface SelectFieldProps {
  label: string;
  value: string;
  options: Record<string, string>;
  disabled: boolean;
  onValue: (value: string) => void;
}

function SelectField({ label, value, options, disabled, onValue }: SelectFieldProps) {
  return (
    <label className={FIELD}>
      {label}
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onValue(e.target.value)}
        className={cn('h-11 w-full', CONTROL)}
      >
        {Object.entries(options).map(([option, text]) => (
          <option key={option} value={option}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}

interface ParamRowProps {
  param: CustomToolParam;
  disabled: boolean;
  onChange: (param: CustomToolParam) => void;
  onRemove: () => void;
}

function ParamRow({ param, disabled, onChange, onRemove }: ParamRowProps) {
  return (
    <li className="flex flex-col gap-3 rounded-md border border-neutral-800 p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label="Parameter name"
          spellCheck={false}
          maxLength={CUSTOM_TOOL_NAME_MAX_LENGTH}
          value={param.name}
          disabled={disabled}
          onValue={(name) => onChange({ ...param, name })}
        />
        <SelectField
          label="Parameter type"
          value={param.type}
          options={PARAM_TYPES}
          disabled={disabled}
          onValue={(type) => onChange(newParam(type as ParamType, param))}
        />
      </div>
      <TextField
        label="Parameter description"
        maxLength={CUSTOM_TOOL_PARAM_DESCRIPTION_MAX_LENGTH}
        value={param.description}
        disabled={disabled}
        onValue={(description) => onChange({ ...param, description })}
      />
      {param.type === 'string' && (
        <ParsedField
          label="Max length"
          type="number"
          min={1}
          value={param.maxLength}
          codec={WHOLE}
          disabled={disabled}
          onValue={(maxLength) => onChange({ ...param, maxLength })}
        />
      )}
      {param.type === 'integer' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <ParsedField
            label="Min"
            type="number"
            value={param.min}
            codec={OPTIONAL_WHOLE}
            disabled={disabled}
            onValue={(min) => onChange({ ...param, min })}
          />
          <ParsedField
            label="Max"
            type="number"
            value={param.max}
            codec={OPTIONAL_WHOLE}
            disabled={disabled}
            onValue={(max) => onChange({ ...param, max })}
          />
        </div>
      )}
      {param.type === 'enum' && (
        <ParsedField
          label="Values (one per line)"
          rows={3}
          placeholder={'open\nclosed'}
          value={param.values}
          codec={LINES}
          disabled={disabled}
          onValue={(values) => onChange({ ...param, values })}
        />
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <label className="flex min-h-11 items-center gap-2 text-sm text-neutral-200">
          <input
            type="checkbox"
            checked={param.required}
            disabled={disabled}
            onChange={(e) => onChange({ ...param, required: e.target.checked })}
          />
          Required
        </label>
        <Button
          type="button"
          variant="ghost"
          className="h-11 text-red-300"
          disabled={disabled}
          aria-label={`Remove parameter ${param.name}`.trim()}
          onClick={onRemove}
        >
          Remove parameter
        </Button>
      </div>
    </li>
  );
}

interface ToolRowProps {
  tool: CustomTool;
  issues: readonly PromptStepIssue[];
  disabled: boolean;
  onChange: (tool: CustomTool) => void;
  onRemove: () => void;
}

function ToolRow({ tool, issues, disabled, onChange, onRemove }: ToolRowProps) {
  return (
    <li
      className={cn(
        'flex flex-col gap-3 rounded-md border bg-neutral-950/60 p-3',
        issues.length > 0 ? 'border-red-800/70' : 'border-neutral-800',
      )}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          label="Action"
          value={tool.action}
          options={ACTIONS}
          disabled={disabled}
          onValue={(action) =>
            onChange(action === tool.action ? tool : newTool(action as ToolAction, tool))
          }
        />
        <TextField
          label="Name"
          spellCheck={false}
          maxLength={CUSTOM_TOOL_NAME_MAX_LENGTH}
          value={tool.name}
          disabled={disabled}
          onValue={(name) => onChange({ ...tool, name })}
        />
      </div>
      <label className={FIELD}>
        Description
        <textarea
          rows={2}
          maxLength={CUSTOM_TOOL_DESCRIPTION_MAX_LENGTH}
          value={tool.description}
          disabled={disabled}
          onChange={(e) => onChange({ ...tool, description: oneLine(e.target.value) })}
          className={cn('w-full py-2', CONTROL)}
        />
      </label>
      {tool.action === 'http-get' ? (
        <>
          <TextField
            label="URL"
            inputMode="url"
            spellCheck={false}
            placeholder="https://api.example.com/items/{id}"
            maxLength={CUSTOM_TOOL_URL_MAX_LENGTH}
            value={tool.url}
            disabled={disabled}
            onValue={(url) => onChange({ ...tool, url })}
          />
          <ParsedField
            label="Query parameters"
            placeholder="page, limit"
            value={tool.query}
            codec={LIST}
            disabled={disabled}
            onValue={(query) => onChange({ ...tool, query })}
          />
          <fieldset className="flex min-w-0 flex-col gap-2">
            <legend className="mb-1 text-xs text-neutral-400">Parameters</legend>
            <InlineMarkdown
              className="text-xs text-neutral-500"
              body="A parameter goes in the URL path as `{name}`, or its name goes under Query parameters."
            />
            {tool.params.length > 0 && (
              <ul className="flex flex-col gap-2">
                {tool.params.map((param, index) => (
                  <ParamRow
                    key={index}
                    param={param}
                    disabled={disabled}
                    onChange={(next) =>
                      onChange({
                        ...tool,
                        params: tool.params.map((p, i) => (i === index ? next : p)),
                      })
                    }
                    onRemove={() =>
                      onChange({ ...tool, params: tool.params.filter((_, i) => i !== index) })
                    }
                  />
                ))}
              </ul>
            )}
            <div>
              <Button
                type="button"
                variant="secondary"
                className="h-11"
                disabled={disabled || tool.params.length >= CUSTOM_TOOL_PARAMS_MAX}
                onClick={() => onChange({ ...tool, params: [...tool.params, newParam()] })}
              >
                Add parameter
              </Button>
            </div>
          </fieldset>
        </>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField
            label="Scope"
            value={tool.scope}
            options={SCOPES}
            disabled={disabled}
            onValue={(scope) => onChange({ ...tool, scope: scope as RagQueryTool['scope'] })}
          />
          <ParsedField
            label="Results (top K)"
            type="number"
            min={RAG_QUERY_TOP_K_MIN}
            max={RAG_QUERY_TOP_K_MAX}
            value={tool.topK}
            codec={WHOLE}
            disabled={disabled}
            onValue={(topK) => onChange({ ...tool, topK })}
          />
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {tool.action === 'http-get' && (
          <ParsedField
            label="Timeout (seconds)"
            type="number"
            inputMode="decimal"
            step="any"
            min={CUSTOM_TOOL_TIMEOUT_MIN_MS / 1000}
            max={CUSTOM_TOOL_TIMEOUT_MAX_MS / 1000}
            value={tool.timeoutMs}
            codec={SECONDS}
            disabled={disabled}
            onValue={(timeoutMs) => onChange({ ...tool, timeoutMs })}
          />
        )}
        <ParsedField
          label="Response cap (KiB)"
          type="number"
          inputMode="decimal"
          step="any"
          min={CUSTOM_TOOL_RESPONSE_MIN_BYTES / 1024}
          max={CUSTOM_TOOL_RESPONSE_MAX_BYTES / 1024}
          value={tool.maxResponseBytes}
          codec={KIB}
          disabled={disabled}
          onValue={(maxResponseBytes) => onChange({ ...tool, maxResponseBytes })}
        />
      </div>
      {issues.map((issue) => (
        <InlineMarkdown
          key={`${issue.kind}:${issue.param ?? ''}`}
          className="text-xs text-red-300 [overflow-wrap:anywhere]"
          body={describePromptStepIssue(issue)}
        />
      ))}
      <div>
        <Button
          type="button"
          variant="ghost"
          className="h-11 text-red-300"
          disabled={disabled}
          aria-label={`Remove tool ${tool.name}`.trim()}
          onClick={onRemove}
        >
          Remove tool
        </Button>
      </div>
    </li>
  );
}

interface PromptStepToolsProps {
  tools: readonly CustomTool[];
  issues: readonly PromptStepIssue[];
  disabled: boolean;
  onChange: (tools: CustomTool[]) => void;
}

export function PromptStepTools({ tools, issues, disabled, onChange }: PromptStepToolsProps) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-3">
      <legend className="mb-1 text-xs text-neutral-400">Custom tools</legend>
      <p className="text-xs text-neutral-500">
        Tools the agent can call during this step. It picks the values it sends.
      </p>
      {tools.length > 0 && (
        <ul className="flex flex-col gap-3">
          {tools.map((tool, index) => (
            <ToolRow
              key={index}
              tool={tool}
              issues={issues.filter((issue) => isToolIssue(issue, tool))}
              disabled={disabled}
              onChange={(next) => onChange(tools.map((t, i) => (i === index ? next : t)))}
              onRemove={() => onChange(tools.filter((_, i) => i !== index))}
            />
          ))}
        </ul>
      )}
      <div>
        <Button
          type="button"
          variant="secondary"
          className="h-11"
          disabled={disabled || tools.length >= CUSTOM_TOOLS_MAX_PER_STEP}
          onClick={() => onChange([...tools, newTool()])}
        >
          Add tool
        </Button>
      </div>
    </fieldset>
  );
}
