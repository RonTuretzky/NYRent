/** Balance-annotated payment-token picker for the buy flow. Disabled options
 * stay visible, greyed, with the reason inline. */
export interface TokenOption {
  id: string;
  symbol: string;
  name: string;
  balanceLabel: string;
  routeLabel?: string;
  disabledReason?: string;
}

export function TokenSelect({
  options,
  value,
  onChange,
  label = "Pay with",
}: {
  options: TokenOption[];
  value: string;
  onChange: (id: string) => void;
  label?: string;
}) {
  return (
    <fieldset className="border-0 p-0 m-0">
      <legend className="font-parkBody text-sm text-surface-grey-2 mb-2">
        {label}
      </legend>
      <div
        role="radiogroup"
        aria-label={label}
        className="grid grid-cols-1 sm:grid-cols-2 gap-2"
        data-testid="token-select"
      >
        {options.map((opt) => {
          const selected = opt.id === value;
          const disabled = !!opt.disabledReason;
          return (
            <button
              key={opt.id}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => onChange(opt.id)}
              data-testid={`token-option-${opt.id}`}
              className={`text-left rounded-lg border-2 px-3 py-2 font-parkBody transition-colors ${
                disabled
                  ? "border-paper-1 bg-paper-1 text-surface-grey cursor-not-allowed opacity-60"
                  : selected
                    ? "border-core-green bg-paper-0"
                    : "border-paper-2 bg-paper-0 hover:border-surface-grey"
              }`}
            >
              <span className="flex items-baseline justify-between gap-2">
                <span className="font-bold text-sm text-text-standard">
                  {opt.symbol}
                </span>
                <span className="text-xs text-surface-grey-2">
                  {opt.balanceLabel}
                </span>
              </span>
              <span className="block text-xs text-surface-grey-2 mt-0.5">
                {opt.name}
              </span>
              {opt.disabledReason ? (
                <span className="block text-xs text-surface-grey-2 mt-0.5 italic">
                  {opt.disabledReason}
                </span>
              ) : opt.routeLabel ? (
                <span className="block text-xs text-surface-grey-2 mt-0.5">
                  {opt.routeLabel}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
