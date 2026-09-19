/** Slider + synced numeric input, shared by the /insurer and /renter
 * explainers. Value is a plain number; the numeric box tolerates in-progress
 * typing and re-syncs on blur. */
import { useEffect, useState } from "react";

export function SliderInput({
  label,
  value,
  onChange,
  min,
  max,
  step,
  unit,
  hint,
  testId,
}: {
  label: string;
  value: number;
  onChange: (next: number) => void;
  min: number;
  max: number;
  step: number;
  /** Suffix shown after the numeric box, e.g. "%" or the currency symbol. */
  unit?: string;
  hint?: string;
  testId?: string;
}) {
  const [text, setText] = useState(String(value));
  // External changes (slider drag, live prefill) re-sync the text box.
  useEffect(() => {
    setText(String(value));
  }, [value]);

  function commitText(raw: string) {
    setText(raw);
    const parsed = Number(raw);
    if (raw.trim() !== "" && Number.isFinite(parsed)) {
      onChange(Math.min(max, Math.max(min, parsed)));
    }
  }

  return (
    <label className="block">
      <span className="font-parkBody text-sm text-surface-grey-2">{label}</span>
      <div className="mt-1 flex items-center gap-3">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label={label}
          data-testid={testId ? `${testId}-slider` : undefined}
          className="min-w-0 flex-1 accent-core-green cursor-pointer"
        />
        <span className="flex items-center gap-1 shrink-0">
          <input
            type="text"
            inputMode="decimal"
            value={text}
            onChange={(e) => commitText(e.target.value)}
            onBlur={() => setText(String(value))}
            aria-label={`${label} (number)`}
            data-testid={testId}
            className="w-24 rounded-lg border-2 border-paper-2 focus:border-core-green outline-none px-2 py-1 font-parkBody text-sm bg-paper-0 text-right"
          />
          {unit ? (
            <span className="font-parkBody text-xs text-surface-grey-2">
              {unit}
            </span>
          ) : null}
        </span>
      </div>
      {hint ? (
        <span className="mt-1 block font-parkBody text-xs text-surface-grey">
          {hint}
        </span>
      ) : null}
    </label>
  );
}
