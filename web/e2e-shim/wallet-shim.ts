/**
 * Tiny EIP-1193 test-wallet shim for Playwright e2e runs.
 *
 * NEVER loaded by production builds: nothing under web/src imports this file
 * (vite only bundles from the src entry graph). Playwright injects it with:
 *
 *   import { installTestWallet } from "../web/e2e-shim/wallet-shim";
 *   await page.addInitScript(installTestWallet, {
 *     rpcUrl: "http://127.0.0.1:8547",
 *     address: "0xf39F...2266",         // an anvil unlocked account
 *     chainId: 100,                      // what the wallet reports initially
 *   });
 *
 * The shim holds NO keys: signing methods (eth_sendTransaction) are forwarded
 * to the anvil RPC, whose unlocked accounts sign node-side. It implements the
 * request/on/removeListener surface that wagmi's injected connector and
 * RainbowKit use, announces itself via EIP-6963, and emulates
 * wallet_switchEthereumChain so wrong-network → switch flows are testable.
 */

export interface TestWalletOptions {
  /** JSON-RPC endpoint of the local node (anvil) that signs for the account. */
  rpcUrl: string;
  /** The unlocked account the wallet exposes. */
  address: string;
  /** Chain id the wallet initially reports (may differ from the app chain to
   * exercise the wrong-network banner). */
  chainId: number;
  /** Chain ids wallet_switchEthereumChain will accept (default: any). */
  knownChainIds?: number[];
}

// Serializable top-level function: everything it needs comes in via `options`
// or lives inside its own body (page.addInitScript serializes the function).
export function installTestWallet(options: TestWalletOptions): void {
  const state = {
    accounts: [options.address],
    chainId: options.chainId,
    connected: false,
    nextId: 1,
  };

  type Listener = (...args: unknown[]) => void;
  const listeners: Record<string, Listener[]> = {};

  function emit(event: string, payload: unknown) {
    for (const fn of listeners[event] ?? []) {
      try {
        fn(payload);
      } catch {
        /* listener errors are not ours */
      }
    }
  }

  function rpcError(code: number, message: string): Error {
    const err = new Error(message) as Error & { code: number };
    err.code = code;
    return err;
  }

  async function forwardToNode(method: string, params: unknown): Promise<unknown> {
    const res = await fetch(options.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: state.nextId++,
        method,
        params: params ?? [],
      }),
    });
    const body = (await res.json()) as {
      result?: unknown;
      error?: { code: number; message: string; data?: unknown };
    };
    if (body.error) {
      const err = rpcError(body.error.code, body.error.message) as Error & {
        data?: unknown;
      };
      err.data = body.error.data;
      throw err;
    }
    return body.result;
  }

  const provider = {
    isMetaMask: true, // lets wagmi's injected connector pick it up eagerly
    isNyRentCoverTestWallet: true,

    async request(args: { method: string; params?: unknown }): Promise<unknown> {
      const { method, params } = args;
      switch (method) {
        case "eth_requestAccounts":
          state.connected = true;
          emit("connect", { chainId: "0x" + state.chainId.toString(16) });
          emit("accountsChanged", state.accounts.slice());
          return state.accounts.slice();
        case "eth_accounts":
          return state.connected ? state.accounts.slice() : [];
        case "eth_chainId":
          return "0x" + state.chainId.toString(16);
        case "net_version":
          return String(state.chainId);
        case "wallet_switchEthereumChain": {
          const target = parseInt(
            (params as [{ chainId: string }])[0].chainId,
            16,
          );
          if (
            options.knownChainIds &&
            !options.knownChainIds.includes(target)
          ) {
            throw rpcError(4902, "Unrecognized chain ID");
          }
          state.chainId = target;
          emit("chainChanged", "0x" + target.toString(16));
          return null;
        }
        case "wallet_addEthereumChain":
          return null;
        case "wallet_requestPermissions":
        case "wallet_getPermissions":
          return [{ parentCapability: "eth_accounts" }];
        case "personal_sign":
        case "eth_sign":
        case "eth_signTypedData_v4":
        case "eth_sendTransaction":
          // anvil's unlocked accounts sign node-side
          return forwardToNode(method, params);
        default:
          return forwardToNode(method, params);
      }
    },

    on(event: string, fn: Listener) {
      (listeners[event] = listeners[event] ?? []).push(fn);
      return provider;
    },
    removeListener(event: string, fn: Listener) {
      listeners[event] = (listeners[event] ?? []).filter((l) => l !== fn);
      return provider;
    },
    // legacy niceties some libraries still probe
    enable() {
      return provider.request({ method: "eth_requestAccounts" });
    },
  };

  const w = window as unknown as { ethereum?: unknown };
  w.ethereum = provider;

  // EIP-6963 announcement (wagmi v2 discovers wallets this way too)
  const info = {
    uuid: "e2e0e2e0-1111-4222-8333-c0ffee00beef",
    name: "NY Rent Cover Test Wallet",
    icon:
      "data:image/svg+xml;base64," +
      btoa(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#16a34a"/></svg>',
      ),
    rdns: "fun.nyrentcover.testwallet",
  };
  const announce = () => {
    window.dispatchEvent(
      new CustomEvent("eip6963:announceProvider", {
        detail: Object.freeze({ info, provider }),
      }),
    );
  };
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
}
