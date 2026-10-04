'use client';

import { useEffect, useRef, useState } from 'react';
import { Input, Label } from '@/components/ui';

interface HoursMinutesInputProps {
  id: string;
  label: string;
  /** Decimal hours at the API boundary; an empty value means no estimate. */
  value: number | '';
  onChange: (value: number | '') => void;
  min?: number;
  max?: number;
  required?: boolean;
  disabled?: boolean;
}

function splitHours(value: number | ''): { hours: string; minutes: string } {
  if (value === '' || !Number.isFinite(value)) return { hours: '', minutes: '' };
  const hours = Math.floor(value);
  // Remove floating-point noise when displaying existing decimal-hour estimates.
  const minutes = Number(((value - hours) * 60).toPrecision(12));
  return { hours: String(hours), minutes: String(minutes) };
}

export function HoursMinutesInput({
  id,
  label,
  value,
  onChange,
  min,
  max,
  required = false,
  disabled = false,
}: HoursMinutesInputProps) {
  const [parts, setParts] = useState(() => splitHours(value));
  const lastEmitted = useRef(value);
  const minutesInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Keep an in-progress edit (including blank parts) when the parent echoes it.
    // A genuinely new default or reset updates both inputs.
    if (value !== lastEmitted.current) {
      lastEmitted.current = value;
      setParts(splitHours(value));
    }
  }, [value]);

  useEffect(() => {
    const present = parts.hours !== '' || parts.minutes !== '';
    const total = Number(parts.hours) + Number(parts.minutes) / 60;
    let message = '';
    if (required && !present) message = 'Enter an estimate in hours or minutes.';
    else if (present && (!Number.isFinite(total) || total <= 0))
      message = 'The estimate must be greater than zero.';
    else if (present && min !== undefined && total < min)
      message = `The estimate must be at least ${min * 60} minutes.`;
    else if (present && max !== undefined && total > max)
      message = `The estimate must be at most ${max} hours.`;
    minutesInput.current?.setCustomValidity(disabled ? '' : message);
  }, [parts, min, max, required, disabled]);

  function change(part: 'hours' | 'minutes', raw: string): void {
    const next = { ...parts, [part]: raw };
    setParts(next);
    const total =
      next.hours === '' && next.minutes === ''
        ? ''
        : Number(next.hours) + Number(next.minutes) / 60;
    lastEmitted.current = total;
    onChange(total);
  }

  return (
    <div role="group" aria-label={label} className="grid grid-cols-2 gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={id}>Hours</Label>
        <Input
          id={id}
          aria-label={`${label}: hours`}
          type="number"
          inputMode="numeric"
          min={0}
          step={1}
          value={parts.hours}
          placeholder="0"
          disabled={disabled}
          onChange={(event) => change('hours', event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-minutes`}>Minutes</Label>
        <Input
          ref={minutesInput}
          id={`${id}-minutes`}
          aria-label={`${label}: minutes`}
          type="number"
          inputMode="decimal"
          min={0}
          step="any"
          value={parts.minutes}
          placeholder="0"
          disabled={disabled}
          onChange={(event) => change('minutes', event.target.value)}
        />
      </div>
    </div>
  );
}
