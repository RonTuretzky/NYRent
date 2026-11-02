/**
 * Block-explorer links. Callers pass the base captured when the link was
 * created (tx toasts and TxStatus capture it at send time); an empty base
 * falls back to Arbiscan so links never break outright.
 */
export const EXPLORER = "https://arbiscan.io";

export const txUrl = (h: string, base: string) =>
  `${base || EXPLORER}/tx/${h}`;

export const addressUrl = (a: string, base: string) =>
  `${base || EXPLORER}/address/${a}`;
