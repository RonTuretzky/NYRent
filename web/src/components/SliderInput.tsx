/** Branded range control with an editable amount and keyboard-native slider. */
import { useEffect, useId, useRef, useState, type CSSProperties } from "react";

export function SliderInput({ label, value, onChange, min, max, step, unit, hint, testId }: {
  label: string; value: number; onChange: (next: number) => void;
  min: number; max: number; step: number; unit?: string; hint?: string; testId?: string;
}) {
  const id = useId();
  const [text, setText] = useState(String(value));
  const editing = useRef(false);
  useEffect(() => { if (!editing.current) setText(String(value)); }, [value]);
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  const progress = ((value - min) / (max - min)) * 100;
  const bound = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 3 });
  function changeText(raw: string) {
    setText(raw);
    const parsed = Number(raw);
    // Keep partial decimals and amounts intact while typing. Clamp only on blur.
    if (raw.trim() !== "" && Number.isFinite(parsed) && parsed >= min && parsed <= max) onChange(parsed);
  }
  function finish() {
    editing.current = false;
    const parsed = Number(text);
    const next = text.trim() !== "" && Number.isFinite(parsed) ? clamp(parsed) : value;
    onChange(next); setText(String(next));
  }
  return <div className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <label htmlFor={id} className="font-parkBody text-sm font-bold text-text-standard">{label}</label>
      <div className="flex items-center gap-2 rounded-xl border-2 border-paper-2 bg-paper-0 px-3 py-2 focus-within:border-core-green focus-within:ring-2 focus-within:ring-core-green/15 transition-colors">
        <input id={id} type="text" inputMode="decimal" value={text}
          onFocus={() => { editing.current = true; }} onChange={(e) => changeText(e.target.value)}
          onBlur={finish} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
          aria-label={`${label} (number)`} aria-describedby={hint ? `${id}-hint` : undefined}
          data-testid={testId} className="w-24 min-w-0 bg-transparent outline-none text-right font-parkDisplay font-bold text-lg tabular-nums" />
        {unit ? <span className="font-parkBody text-xs text-surface-grey-2 whitespace-nowrap">{unit}</span> : null}
      </div>
    </div>
    <input type="range" min={min} max={max} step={step} value={value}
      onChange={(e) => { const n = Number(e.target.value); editing.current = false; setText(String(n)); onChange(n); }}
      aria-label={label} aria-valuetext={`${bound(value)}${unit ? ` ${unit}` : ""}`}
      data-testid={testId ? `${testId}-slider` : undefined}
      className="rent-range" style={{ "--range-progress": `${progress}%` } as CSSProperties} />
    <div className="flex justify-between font-parkBody text-xs text-surface-grey" aria-hidden="true"><span>{bound(min)}</span><span>{bound(max)}</span></div>
    {hint ? <p id={`${id}-hint`} className="font-parkBody text-xs text-surface-grey-2 leading-relaxed">{hint}</p> : null}
  </div>;
}
