/**
 * Block-explorer links, per chain. Every caller passes the base of the chain
 * that produced the hash/address — captured from the deployment at the time
 * the link was created (tx toasts and TxStatus capture it at send time), so
 * links never re-resolve against whatever chain happens to be active at
 * render time. An empty base (a local anvil chain has no explorer) falls
 * back to Blockscout so links never break outright.
 */
export const EXPLORER = "https://gnosis.blockscout.com";

export const txUrl = (h: string, base: string) =>
  `${base || EXPLORER}/tx/${h}`;

export const addressUrl = (a: string, base: string) =>
  `${base || EXPLORER}/address/${a}`;
