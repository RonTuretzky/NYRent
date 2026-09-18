// Lightweight EIP-1193 + EIP-6963 wallet shim for Playwright runs (SPEC §7).
// No private key lives here: transaction signing is delegated to Anvil's unlocked
// dev accounts via plain JSON-RPC eth_sendTransaction. Injected via addInitScript
// AFTER a script that sets window.__E2E_WALLET_CONFIG.
(() => {
  const cfg = Object.assign(
    {
      rpcUrl: "http://127.0.0.1:8547",
      chainIdHex: "0x7a69", // 31337
      accounts: [
        "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      ],
      accountIndex: 0,
    },
    window.__E2E_WALLET_CONFIG || {},
  );
  let chainIdHex = cfg.chainIdHex;
  let accountIndex = cfg.accountIndex;
  const listeners = {};
  const emit = (ev, payload) =>
    (listeners[ev] || []).forEach((fn) => {
      try {
        fn(payload);
      } catch {
        /* listener errors are the app's problem */
      }
    });
  let id = 0;
  async function rpc(method, params) {
    const res = await fetch(cfg.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: params ?? [] }),
    });
    const json = await res.json();
    if (json.error) {
      const err = new Error(json.error.message);
      err.code = json.error.code;
      err.data = json.error.data;
      throw err;
    }
    return json.result;
  }
  const provider = {
    isE2ETestWallet: true,
    async request({ method, params }) {
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return [cfg.accounts[accountIndex]];
        case "eth_chainId":
          return chainIdHex;
        case "net_version":
          return String(parseInt(chainIdHex, 16));
        case "wallet_switchEthereumChain": {
          chainIdHex = params[0].chainId;
          emit("chainChanged", chainIdHex);
          return null;
        }
        case "wallet_addEthereumChain":
          return null;
        case "wallet_requestPermissions":
        case "wallet_getPermissions":
          return [{ parentCapability: "eth_accounts" }];
        case "eth_sendTransaction": {
          // Anvil signs with its unlocked dev account; pin `from` to the shim account.
          const tx = { ...params[0], from: cfg.accounts[accountIndex] };
          return rpc(method, [tx]);
        }
        default:
          return rpc(method, params);
      }
    },
    on(ev, fn) {
      (listeners[ev] ||= []).push(fn);
      return provider;
    },
    removeListener(ev, fn) {
      listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn);
      return provider;
    },
  };
  // Test-only controls for the specs.
  window.__e2eWallet = {
    setAccount(i) {
      accountIndex = i;
      emit("accountsChanged", [cfg.accounts[accountIndex]]);
    },
    setChain(hex) {
      chainIdHex = hex;
      emit("chainChanged", hex);
    },
    get account() {
      return cfg.accounts[accountIndex];
    },
  };
  window.ethereum = provider;
  // EIP-6963 announcement so RainbowKit v2's injected discovery lists us by name.
  const info = Object.freeze({
    uuid: "6ff2cd39-6ba5-4f21-a094-e2e000000001",
    name: "E2E Test Wallet",
    icon:
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='28' height='28'%3E%3Crect width='28' height='28' fill='%2316a34a'/%3E%3C/svg%3E",
    rdns: "fun.nyrent.e2e",
  });
  const announce = () =>
    window.dispatchEvent(
      new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }),
    );
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
})();
