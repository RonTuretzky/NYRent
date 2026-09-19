// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {CoverPool} from "../src/CoverPool.sol";
import {CoverToken} from "../src/CoverToken.sol";
import {CredailyRentOracle} from "../src/CredailyRentOracle.sol";
import {CredailyKey} from "../src/gen/CredailyKey.sol";
import {IObservationOracle} from "../src/interfaces/IObservationOracle.sol";
import {ICoverPool, ISwapRouter02, SwapAndBuyRouter} from "../src/SwapAndBuyRouter.sol";
import {LocalWXDAI} from "./LocalWXDAI.sol";

/// @title Deploy
/// @notice One-shot deployment of the NY Rent Cover stack: {CredailyRentOracle} (pinned
///         CRE Daily DKIM key from the GENERATED constant `src/gen/CredailyKey.sol` —
///         zero file deps at deploy time) → {CoverToken} + {CoverPool} (CREATE-address
///         precompute for the circular immutable) → {SwapAndBuyRouter} against the
///         chain's Uniswap SwapRouter02 (skipped where none exists) → the demo series.
///         Etherform-compatible: `forge script script/Deploy.s.sol:Deploy`.
/// @dev    Env: PRIVATE_KEY (etherform secret name; DEPLOYER_PRIVATE_KEY also accepted),
///         optional CURRENCY to override the pool currency, optional UNISWAP_ROUTER to
///         override SwapRouter02 (zero address skips the router deploy).
///
///         Per-chain defaults:
///         - Arbitrum One (42161): native USDC (6 decimals — amounts are NOT 18-dec
///           wei) + the canonical SwapRouter02;
///         - Gnosis (100): WXDAI (18 decimals) + the canonical Gnosis SwapRouter02;
///         - any other chain (anvil 31337 e2e included): a fresh {LocalWXDAI} stand-in
///           unless CURRENCY is set, and no router unless UNISWAP_ROUTER is set.
///
///         The demo series is sized from the currency's live `decimals()` (capacity
///         0.5 units — 500000 six-dec on Arbitrum, 0.5e18 at 18 decimals), mirroring
///         live Gnosis legacy series 1 (its exact capacity was 0.500335 units; the
///         mirror deliberately rounds to 0.5). Re-running deploys a fresh, unrelated
///         stack. The 2026-09-18 Gnosis deployment (see docs/OPERATIONS.md) predates
///         this contract version and remains on-chain as a legacy artifact.
contract Deploy is Script {
    // ─────────────────────────────────────────────────────────────────────────
    // Chain constants
    // ─────────────────────────────────────────────────────────────────────────

    uint256 public constant ARBITRUM_ONE_CHAIN_ID = 42_161;
    uint256 public constant GNOSIS_CHAIN_ID = 100;

    /// @notice Native (Circle-issued) USDC. ADDRESS VERIFICATION (2026-09-19, arb1.arbitrum.io/rpc):
    ///         `cast call 0xaf88…5831 "symbol()(string)"`   → "USDC"
    ///         `cast call 0xaf88…5831 "decimals()(uint8)"`  → 6
    address public constant NATIVE_USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;

    /// @notice Wrapped xDAI. ADDRESS VERIFICATION (2026-09-18, rpc.gnosischain.com):
    ///         `cast call 0xe91D…a97d "symbol()(string)"`   → "WXDAI"
    ///         `cast call 0xe91D…a97d "decimals()(uint8)"`  → 18
    address public constant WXDAI = 0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d;

    /// @notice Canonical Uniswap SwapRouter02 on Arbitrum One. ADDRESS VERIFICATION
    ///         (2026-09-19, arb1.arbitrum.io/rpc):
    ///         `cast call 0x68b3…Fc45 "factory()(address)"` → the Uniswap v3 factory 0x1F98…F984
    ///         `cast call 0x68b3…Fc45 "WETH9()(address)"`   → Arbitrum WETH 0x82aF…Bab1
    address public constant SWAP_ROUTER_02_ARBITRUM = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;

    /// @notice Canonical Uniswap SwapRouter02 on Gnosis (WETH9() → WXDAI). The
    ///         postflight re-verifies the WETH9 wiring by RPC on every deploy.
    address public constant SWAP_ROUTER_02_GNOSIS = 0xc6D25285D5C5b62b7ca26D6092751A145D50e9Be;

    // ─────────────────────────────────────────────────────────────────────────
    // Demo series parameters (mirror of live Gnosis legacy series 1)
    // ─────────────────────────────────────────────────────────────────────────

    uint32 public constant STRIKE_LOW_CENTS = 9288; // $92.88 / SF → payout 0
    uint32 public constant STRIKE_HIGH_CENTS = 10_088; // $100.88 / SF → payout 1
    uint16 public constant PREMIUM_RATE_BPS = 1133; // 11.33% of max claim
    uint64 public constant OBS_START = 1_791_029_810; // 2026-10-03 12:16:50 UTC
    uint64 public constant OBS_END = 1_793_621_810; // 2026-11-02 12:16:50 UTC
    uint64 public constant SALE_END = OBS_START; // sale closes when observation opens (no informed trading)
    uint64 public constant REDEEM_END = 1_796_213_810; // 2026-12-02 12:16:50 UTC

    error NoCode(string what, address where);
    error BadCurrencyMetadata(string what);
    error PoolAddressMismatch(address predicted, address actual);
    error PostDeployCheckFailed(string what);

    function run()
        external
        returns (CredailyRentOracle oracle, CoverToken token, CoverPool pool, SwapAndBuyRouter router)
    {
        uint256 pk = vm.envOr("PRIVATE_KEY", vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0)));
        require(pk != 0, "set PRIVATE_KEY (or DEPLOYER_PRIVATE_KEY)");
        address deployer = vm.rememberKey(pk);

        IERC20 currency = _resolveCurrency();
        address swapRouter = _resolveSwapRouter();

        vm.startBroadcast(deployer);

        // 0. Local chains only: no CURRENCY override → deploy a WETH9-style stand-in
        //    so the e2e suite can wrap dev-account coin exactly like WXDAI on Gnosis.
        if (address(currency) == address(0)) {
            currency = IERC20(address(new LocalWXDAI()));
        }
        uint8 decimals = IERC20Metadata(address(currency)).decimals();

        // 1. Oracle with the pinned CRE Daily key.
        oracle = new CredailyRentOracle(CredailyKey.MODULUS);

        // 2. CoverToken ↔ CoverPool circular immutable: the pool is the deployer's NEXT
        //    CREATE after the token, so its address is computeCreateAddress(deployer,
        //    nonce + 1). Do not send any other tx from the deployer between the two.
        uint64 nonce = vm.getNonce(deployer);
        address predictedPool = vm.computeCreateAddress(deployer, nonce + 1);
        token = new CoverToken(predictedPool, decimals);
        pool = new CoverPool(currency, token, IObservationOracle(address(oracle)), deployer);
        if (address(pool) != predictedPool) revert PoolAddressMismatch(predictedPool, address(pool));

        // 3. Router against the chain's SwapRouter02 (zero address = no router here,
        //    skip). The router reads the pool currency from the pool itself.
        if (swapRouter != address(0)) {
            router = new SwapAndBuyRouter(ISwapRouter02(swapRouter), ICoverPool(address(pool)));
        }

        // 4. Demo series. Capacity is 0.5 currency units at the currency's LIVE
        //    decimals — 500000 for 6-dec USDC on Arbitrum, 0.5e18 at 18 decimals.
        uint128 capacity = uint128(10 ** uint256(decimals) / 2);
        uint256 seriesId = pool.createSeries(
            STRIKE_LOW_CENTS, STRIKE_HIGH_CENTS, PREMIUM_RATE_BPS, SALE_END, OBS_START, OBS_END, REDEEM_END, capacity
        );

        vm.stopBroadcast();

        _postflight(oracle, token, pool, router, currency, swapRouter, deployer, seriesId, capacity, decimals);

        console.log("CredailyRentOracle:", address(oracle));
        console.log("CoverToken:       ", address(token));
        console.log("CoverPool:        ", address(pool));
        if (address(router) != address(0)) {
            console.log("SwapAndBuyRouter: ", address(router));
        } else {
            console.log("SwapAndBuyRouter:  skipped (no swap router on this chain)");
        }
        console.log("Currency:         ", address(currency));
        console.log("Demo seriesId:    ", seriesId);
    }

    /// @dev Currency resolution + metadata verification by RPC. On Arbitrum the default
    ///      native USDC must answer symbol "USDC" / 6 decimals; on Gnosis the default
    ///      WXDAI must answer symbol "WXDAI" / 18 decimals; a CURRENCY override must at
    ///      least be deployed code (its live `decimals()` still sizes the demo capacity
    ///      in `run`). On any other chain (anvil 31337 e2e included) the behaviour is
    ///      unchanged from the original local path: optional CURRENCY override, else
    ///      address(0) so `run` deploys a {LocalWXDAI} inside the broadcast.
    function _resolveCurrency() internal view returns (IERC20) {
        if (block.chainid == ARBITRUM_ONE_CHAIN_ID) {
            address currency = vm.envOr("CURRENCY", NATIVE_USDC);
            if (currency.code.length == 0) revert NoCode("CURRENCY", currency);
            if (currency == NATIVE_USDC) {
                if (keccak256(bytes(IERC20Metadata(currency).symbol())) != keccak256("USDC")) {
                    revert BadCurrencyMetadata("symbol != USDC");
                }
                if (IERC20Metadata(currency).decimals() != 6) revert BadCurrencyMetadata("decimals != 6");
            }
            return IERC20(currency);
        }
        if (block.chainid == GNOSIS_CHAIN_ID) {
            address currency = vm.envOr("CURRENCY", WXDAI);
            if (currency.code.length == 0) revert NoCode("CURRENCY", currency);
            if (currency == WXDAI) {
                if (keccak256(bytes(IERC20Metadata(currency).symbol())) != keccak256("WXDAI")) {
                    revert BadCurrencyMetadata("symbol != WXDAI");
                }
                if (IERC20Metadata(currency).decimals() != 18) revert BadCurrencyMetadata("decimals != 18");
            }
            return IERC20(currency);
        }
        address overrideCurrency = vm.envOr("CURRENCY", address(0));
        if (overrideCurrency == address(0)) return IERC20(address(0)); // deploy LocalWXDAI in run()
        if (overrideCurrency.code.length == 0) revert NoCode("CURRENCY override (local)", overrideCurrency);
        return IERC20(overrideCurrency);
    }

    /// @dev UNISWAP_ROUTER env override; defaults to the canonical SwapRouter02 on
    ///      Arbitrum and Gnosis and to zero (skip the {SwapAndBuyRouter} deploy) on
    ///      every other chain.
    function _resolveSwapRouter() internal view returns (address) {
        address defaultRouter = block.chainid == ARBITRUM_ONE_CHAIN_ID
            ? SWAP_ROUTER_02_ARBITRUM
            : block.chainid == GNOSIS_CHAIN_ID ? SWAP_ROUTER_02_GNOSIS : address(0);
        address swapRouter = vm.envOr("UNISWAP_ROUTER", defaultRouter);
        if (swapRouter != address(0) && swapRouter.code.length == 0) revert NoCode("UNISWAP_ROUTER", swapRouter);
        return swapRouter;
    }

    /// @dev Wiring invariants; nothing is upgradeable, so any failure means redeploy.
    function _postflight(
        CredailyRentOracle oracle,
        CoverToken token,
        CoverPool pool,
        SwapAndBuyRouter router,
        IERC20 currency,
        address swapRouter,
        address deployer,
        uint256 seriesId,
        uint128 capacity,
        uint8 decimals
    ) internal view {
        if (oracle.MODULUS_HASH() != CredailyKey.MODULUS_HASH) {
            revert PostDeployCheckFailed("oracle.MODULUS_HASH");
        }
        if (keccak256(oracle.modulus()) != CredailyKey.MODULUS_HASH) revert PostDeployCheckFailed("oracle.modulus");
        if (oracle.observationCount() != 0) revert PostDeployCheckFailed("oracle not empty");
        if (token.pool() != address(pool)) revert PostDeployCheckFailed("token.pool");
        if (token.currencyDecimals() != decimals) revert PostDeployCheckFailed("token.currencyDecimals");
        if (address(pool.token()) != address(token)) revert PostDeployCheckFailed("pool.token");
        if (address(pool.oracle()) != address(oracle)) revert PostDeployCheckFailed("pool.oracle");
        if (address(pool.currency()) != address(currency)) revert PostDeployCheckFailed("pool.currency");
        if (pool.sponsor() != deployer) revert PostDeployCheckFailed("pool.sponsor");
        if (swapRouter == address(0)) {
            if (address(router) != address(0)) revert PostDeployCheckFailed("router deployed without swap router");
        } else {
            if (address(router.pool()) != address(pool)) revert PostDeployCheckFailed("router.pool");
            if (address(router.swapRouter()) != swapRouter) revert PostDeployCheckFailed("router.swapRouter");
            if (address(router.usdc()) != address(currency)) revert PostDeployCheckFailed("router.usdc");
            if (router.weth9() != ISwapRouter02(swapRouter).WETH9()) revert PostDeployCheckFailed("router.weth9");
        }
        if (pool.seriesCount() != 1 || seriesId != 0) revert PostDeployCheckFailed("seriesCount");
        CoverPool.Series memory s = pool.series(0);
        if (s.strikeLowCents != STRIKE_LOW_CENTS || s.strikeHighCents != STRIKE_HIGH_CENTS) {
            revert PostDeployCheckFailed("series.strikes");
        }
        if (s.premiumRateBps != PREMIUM_RATE_BPS || s.capacity != capacity) {
            revert PostDeployCheckFailed("series.economics");
        }
        if (s.saleEnd != SALE_END || s.obsStart != OBS_START || s.obsEnd != OBS_END || s.redeemEnd != REDEEM_END) {
            revert PostDeployCheckFailed("series.windows");
        }
        if (s.sold != 0 || s.settled) revert PostDeployCheckFailed("series.state");
    }
}
