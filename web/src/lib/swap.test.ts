/**
 * Pay-with-any-token core: per-chain payment tables, exact-output path
 * encoding (mirrors SwapAndBuyRouter's on-chain path checks), slippage math,
 * premium math and the router/pool transaction builders.
 *
 * Run: cd web && npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodePacked, parseEther, type Address } from "viem";

import {
  ARBITRUM,
  ARB_ARBITRUM,
  FEE_GNO_USDCE,
  FEE_WXDAI_USDCE,
  GNO,
  GNOSIS,
  PAYMENT_TOKENS,
  QUOTERS,
  USDC_ARBITRUM,
  USDCE_GNOSIS,
  WETH_ARBITRUM,
  WXDAI,
  effectiveSlippageBps,
  exactOutputPath,
  friendlySwapError,
  paymentTokensFor,
  withSlippage,
  type DeploymentLike,
  type PaymentToken,
} from "../chain/swapCore.ts";
import {
  approveCurrencyRequest,
  approveRouterRequest,
  buyProtectionRequest,
  premiumFor,
  premiumRoundsToZero,
  swapAndBuyRequest,
  wrapNativeRequest,
} from "../chain/router.ts";

const ROUTER = "0x36861cbD424CDAaf9EF981Dd8C6a89F77CEB5f8b" as Address;
const POOL = "0x68A3b66cb9d66c359B83d6CaAEeAABbA0cA29Aa3" as Address;

const gnosisDeployment: DeploymentLike & { pool: Address } = {
  chainId: GNOSIS,
  router: ROUTER,
  pool: POOL,
  currency: { address: WXDAI, symbol: "WXDAI", decimals: 18 },
};

const currencyFor = (chainId: number): Address =>
  chainId === GNOSIS ? WXDAI : USDC_ARBITRUM;

const strip = (hex: string) => hex.toLowerCase().replace(/^0x/, "");

// ------------------------------------------------------------ path encoding

test("exactOutputPath: single hop matches encodePacked reference", () => {
  assert.equal(
    exactOutputPath([WXDAI, USDCE_GNOSIS], [FEE_WXDAI_USDCE]),
    encodePacked(
      ["address", "uint24", "address"],
      [WXDAI, FEE_WXDAI_USDCE, USDCE_GNOSIS],
    ),
  );
});

test("exactOutputPath: GNO 2-hop path is currency-first, tokenIn-last", () => {
  const path = exactOutputPath(
    [WXDAI, USDCE_GNOSIS, GNO],
    [FEE_WXDAI_USDCE, FEE_GNO_USDCE],
  );
  assert.equal(
    path,
    encodePacked(
      ["address", "uint24", "address", "uint24", "address"],
      [WXDAI, FEE_WXDAI_USDCE, USDCE_GNOSIS, FEE_GNO_USDCE, GNO],
    ),
  );
});

test("exactOutputPath: rejects mismatched token/fee counts", () => {
  assert.throws(() => exactOutputPath([WXDAI], []));
  assert.throws(() => exactOutputPath([WXDAI, GNO], [100, 100]));
});

// ------------------------------------------------- table structural checks
// Mirrors SwapAndBuyRouter's own on-chain validation: a path must be
// 20 + n×23 bytes, start with the pool currency (exact-output) and end with
// tokenIn — for every token on every chain, primary and fallback.

for (const chainId of [GNOSIS, ARBITRUM]) {
  test(`payment table ${chainId}: routes satisfy the router's path rules`, () => {
    const currency = strip(currencyFor(chainId));
    for (const t of PAYMENT_TOKENS[chainId]) {
      assert.ok(t.decimals > 0, `${t.id} decimals`);
      if (t.route.kind !== "router") continue;
      for (const path of [t.route.path, t.route.fallbackPath]) {
        if (path === undefined) continue;
        const bytes = strip(path).length / 2;
        assert.ok(bytes >= 43, `${t.id} path too short`);
        assert.equal((bytes - 20) % 23, 0, `${t.id} path shape`);
        assert.ok(
          strip(path).startsWith(currency),
          `${t.id} path must start with the pool currency`,
        );
        assert.ok(
          strip(path).endsWith(strip(t.route.tokenIn)),
          `${t.id} path must end with tokenIn`,
        );
      }
      if (t.route.native) {
        assert.equal(t.address, undefined, `${t.id} native has no address`);
        assert.equal(
          t.route.tokenIn,
          WETH_ARBITRUM,
          "native pay routes through WETH9",
        );
      } else {
        assert.equal(t.address, t.route.tokenIn, `${t.id} pulls itself`);
      }
    }
  });
}

test("payment tables: exactly one direct (pool-currency) entry per chain", () => {
  for (const chainId of [GNOSIS, ARBITRUM]) {
    const directs = PAYMENT_TOKENS[chainId].filter(
      (t) => t.route.kind === "direct",
    );
    assert.equal(directs.length, 1);
    assert.equal(
      directs[0].address?.toLowerCase(),
      currencyFor(chainId).toLowerCase(),
    );
  }
});

test("ARB lists a fallback fee tier and a thin-depth note", () => {
  const arb = PAYMENT_TOKENS[ARBITRUM].find((t) => t.id === "arb");
  assert.ok(arb && arb.route.kind === "router");
  assert.ok(arb.route.fallbackPath !== undefined);
  assert.ok(arb.route.thin);
  assert.ok(strip(arb.route.path).endsWith(strip(ARB_ARBITRUM)));
});

test("quoters exist for both production chains", () => {
  assert.ok(QUOTERS[GNOSIS]);
  assert.ok(QUOTERS[ARBITRUM]);
});

test("paymentTokensFor: unknown (anvil) chain collapses to direct + wrap", () => {
  const local: DeploymentLike = {
    chainId: 31337,
    currency: {
      address: "0x0000000000000000000000000000000000000001",
      symbol: "WXDAI",
      decimals: 18,
    },
  };
  const tokens = paymentTokensFor(local);
  assert.deepEqual(
    tokens.map((t) => t.route.kind),
    ["direct", "wrap"],
  );
  assert.equal(tokens[0].address, local.currency.address);
});

test("paymentTokensFor: router routes drop when the deployment has no router", () => {
  const noRouter: DeploymentLike = {
    chainId: GNOSIS,
    currency: { address: WXDAI, symbol: "WXDAI", decimals: 18 },
  };
  assert.ok(
    paymentTokensFor(noRouter).every((t) => t.route.kind !== "router"),
  );
  assert.ok(
    paymentTokensFor(gnosisDeployment).some((t) => t.route.kind === "router"),
  );
});

// ------------------------------------------------------------ number rules

test("withSlippage: 50 bps stable / 100 bps volatile / 0 identity", () => {
  assert.equal(withSlippage(1_000_000n, 50), 1_005_000n);
  assert.equal(withSlippage(1_000_000n, 100), 1_010_000n);
  assert.equal(withSlippage(123n, 0), 123n);
});

test("effectiveSlippageBps: finite non-negative override wins, else default", () => {
  const token = { defaultSlippageBps: 50 };
  assert.equal(effectiveSlippageBps(token), 50);
  assert.equal(effectiveSlippageBps(token, 75), 75);
  assert.equal(effectiveSlippageBps(token, 12.9), 12);
  assert.equal(effectiveSlippageBps(token, -1), 50);
  assert.equal(effectiveSlippageBps(token, Number.NaN), 50);
});

test("premiumFor mirrors the pool: truncating maxClaim × rate / 1e4", () => {
  assert.equal(premiumFor(parseEther("0.01"), 2850), parseEther("0.00285"));
  assert.equal(premiumFor(500_000_000n, 2850), 142_500_000n); // 500 USDC, 6 dec
  assert.equal(premiumFor(3n, 2850), 0n); // truncates
});

test("premiumRoundsToZero flags dust only for nonzero rates", () => {
  assert.equal(premiumRoundsToZero(3n, 2850), true);
  assert.equal(premiumRoundsToZero(0n, 2850), false);
  assert.equal(premiumRoundsToZero(3n, 0), false);
  assert.equal(premiumRoundsToZero(parseEther("1"), 2850), false);
});

// -------------------------------------------------------- friendly reverts

test("friendlySwapError: overlays Uniswap and router revert copy", () => {
  const overlaid = friendlySwapError({
    name: "Error",
    message: "execution reverted: Too much requested",
    kind: "revert",
  });
  assert.equal(overlaid.name, "SwapFailed");
  assert.match(overlaid.message, /slippage/);

  const routerErr = friendlySwapError({
    name: "InvalidPath",
    message: "The contract reverted with InvalidPath.",
    kind: "revert",
  });
  assert.equal(routerErr.name, "SwapFailed");

  const untouched = friendlySwapError({
    name: "PremiumTooHigh",
    message: "The premium moved above your maximum.",
    kind: "revert",
  });
  assert.equal(untouched.name, "PremiumTooHigh");
});

// ------------------------------------------------------------- tx builders

const usdce = PAYMENT_TOKENS[GNOSIS].find(
  (t) => t.id === "usdce",
) as PaymentToken & { route: { kind: "router"; tokenIn: Address; path: `0x${string}` } };
const eth = PAYMENT_TOKENS[ARBITRUM].find(
  (t) => t.id === "eth",
) as PaymentToken & {
  route: { kind: "router"; tokenIn: Address; native: true; path: `0x${string}` };
};

test("swapAndBuyRequest: ERC-20 pay carries no value, native pays value == cap", () => {
  const erc20Req = swapAndBuyRequest(
    gnosisDeployment,
    usdce.route,
    1_000_000n,
    1n,
    parseEther("1"),
  );
  assert.equal(erc20Req.address, ROUTER);
  assert.equal(erc20Req.chainId, GNOSIS);
  assert.equal(erc20Req.functionName, "swapAndBuy");
  assert.deepEqual(erc20Req.args, [
    usdce.route.tokenIn,
    1_000_000n,
    usdce.route.path,
    1n,
    parseEther("1"),
  ]);
  assert.equal(erc20Req.value, undefined);

  const arbDeployment: DeploymentLike = {
    chainId: ARBITRUM,
    router: ROUTER,
    currency: { address: USDC_ARBITRUM, symbol: "USDC", decimals: 6 },
  };
  const nativeReq = swapAndBuyRequest(
    arbDeployment,
    eth.route,
    parseEther("0.05"),
    0n,
    500_000_000n,
  );
  assert.equal(nativeReq.value, parseEther("0.05"));
  assert.equal(nativeReq.chainId, ARBITRUM);
  assert.equal(nativeReq.args?.[0], WETH_ARBITRUM);
});

test("swapAndBuyRequest: pathOverride swaps in the fallback fee tier", () => {
  const arb = PAYMENT_TOKENS[ARBITRUM].find((t) => t.id === "arb");
  assert.ok(arb && arb.route.kind === "router" && arb.route.fallbackPath);
  const req = swapAndBuyRequest(
    { ...gnosisDeployment, chainId: ARBITRUM },
    arb.route,
    1n,
    0n,
    1n,
    undefined,
    arb.route.fallbackPath,
  );
  assert.equal(req.args?.[2], arb.route.fallbackPath);
});

test("swapAndBuyRequest: throws without a router deployment", () => {
  assert.throws(() =>
    swapAndBuyRequest(
      { chainId: GNOSIS, currency: gnosisDeployment.currency },
      usdce.route,
      1n,
      0n,
      1n,
    ),
  );
});

test("approveRouterRequest: approves the router, rejects native tokens", () => {
  const req = approveRouterRequest(gnosisDeployment, usdce, 42n);
  assert.equal(req.address, usdce.address);
  assert.deepEqual(req.args, [ROUTER, 42n]);
  assert.throws(() => approveRouterRequest(gnosisDeployment, eth, 1n));
});

test("direct-leg builders: approve targets the pool, wrap carries value", () => {
  const approve = approveCurrencyRequest(gnosisDeployment, 7n);
  assert.equal(approve.address, WXDAI);
  assert.deepEqual(approve.args, [POOL, 7n]);

  const buy = buyProtectionRequest(gnosisDeployment, 2n, 100n, 3n);
  assert.equal(buy.address, POOL);
  assert.deepEqual(buy.args, [2n, 100n, 3n]);

  const wrap = wrapNativeRequest(gnosisDeployment, 55n);
  assert.equal(wrap.address, WXDAI);
  assert.equal(wrap.functionName, "deposit");
  assert.equal(wrap.value, 55n);
});
