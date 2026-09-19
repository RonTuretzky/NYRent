/** Single source of truth for block-explorer links (Blockscout, matches
 * `appChain.blockExplorers` in wagmi.ts). */
export const EXPLORER = "https://gnosis.blockscout.com";

export const txUrl = (h: string) => `${EXPLORER}/tx/${h}`;

export const addressUrl = (a: string) => `${EXPLORER}/address/${a}`;
