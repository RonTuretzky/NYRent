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
/// @notice One-shot deployment of the fully permissionless NY Rent Cover stack:
///         {CredailyRentOracle} (pinned CRE Daily DKIM key from the GENERATED constant
///         `src/gen/CredailyKey.sol` — zero file deps at deploy time) → {CoverToken} +
///         {CoverPool} (CREATE-address precompute for the circular immutable) →
///         {SwapAndBuyRouter} against the chain's Uniswap SwapRouter02 (skipped where
///         none exists). The pool has NO ROLES AT ALL — no sponsor, no owner, no
///         global pause — so on MAINNET chains nothing else is deployed: series
///         creation is a post-deploy permissionless act (the agent escrows capacity
///         and calls `createSeries` itself, whenever it wants).
///         Etherform-compatible: `forge script script/Deploy.s.sol:Deploy`.
/// @dev    Env: PRIVATE_KEY (etherform secret name; DEPLOYER_PRIVATE_KEY also accepted),
///         optional CURRENCY to override the pool currency, optional UNISWAP_ROUTER to
///         override SwapRouter02 (zero address skips the router deploy).
///
///         Per-chain behaviour:
///         - Arbitrum One (42161): native USDC (6 decimals — amounts are NOT 18-dec
///           wei) + the canonical SwapRouter02; oracle + token + pool + router ONLY;
///         - Gnosis (100): WXDAI (18 decimals) + the canonical Gnosis SwapRouter02;
///           oracle + token + pool + router ONLY;
///         - any other chain (anvil 31337 e2e included): a fresh {LocalWXDAI} stand-in
///           unless CURRENCY is set, no router unless UNISWAP_ROUTER is set, AND the
///           demo series created inline — the broadcaster wraps `capacity` native coin
///           (when the stand-in was deployed here), approves the pool and escrows it
///           through the permissionless `createSeries`.
///
///         E2E TIME BASE (SPEC §7): the contract rule `saleEnd ≤ obsStart` plus the
///         Playwright journey's shape (buy first, then settle with the real fixture
///         email whose signed t = 1789642464 = 2026-09-17 is in the PAST) means the
///         local chain cannot run at real time. e2e/global-setup.ts spawns anvil with
///         `--timestamp 1789000000` (2026-09-10, ~7.4 days before the fixture t) and
///         this script derives the demo window from `block.timestamp`:
///         saleEnd = obsStart = now + 36h (sale open at journey time, closed before
///         the warped observation), obsEnd = obsStart + 30 days (contains the fixture
///         t — asserted below), redeemEnd = obsEnd + 60 days. The journey buys at
///         chain time ~1789000000 and must warp past the fixture t (e2e/support
///         `warpTo`) before settling. Demo economics keep the frozen e2e numbers:
///         strikes 8800/9600, 2850 bps, capacity 0.02 currency units (buy 0.01 →
///         premium 0.00285; settle at 9288 cents → ratio 61%).
///
///         Re-running deploys a fresh, unrelated stack. The 2026-09-18 Gnosis
///         deployment (see docs/OPERATIONS.md) predates this contract version and
///         remains on-chain as a legacy artifact.
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
    // Demo series parameters (LOCAL/e2e chains only — mainnet ships zero series)
    // ─────────────────────────────────────────────────────────────────────────

    uint32 public constant STRIKE_LOW_CENTS = 8800; // $88.00 / SF → payout 0
    uint32 public constant STRIKE_HIGH_CENTS = 9600; // $96.00 / SF → payout 1
    uint16 public constant PREMIUM_RATE_BPS = 2850; // 28.50% of max claim

    /// @notice Signed DKIM t= of the real fixture email (fixtures/credaily-2026-09-17/,
    ///         cents 9288 → demo ratio 61%). The demo observation window MUST contain
    ///         it, or the e2e journey could never settle.
    uint64 public constant FIXTURE_T = 1_789_642_464;

    /// @notice Demo window offsets from the local chain clock: the sale stays open for
    ///         the whole Playwright journey (which runs at anvil start time) and closes
    ///         before the warped settlement, honouring `saleEnd ≤ obsStart` on-chain.
    uint64 public constant DEMO_SALE_DURATION = 36 hours;
    uint64 public constant DEMO_OBS_DURATION = 30 days;
    uint64 public constant DEMO_CLAIM_DURATION = 60 days;

    error NoCode(string what, address where);
    error BadCurrencyMetadata(string what);
    error PoolAddressMismatch(address predicted, address actual);
    error PostDeployCheckFailed(string what);

    /// @dev Everything the postflight re-verifies, packed to keep `run`'s stack flat.
    struct Deployment {
        CredailyRentOracle oracle;
        CoverToken token;
        CoverPool pool;
        SwapAndBuyRouter router;
        IERC20 currency;
        address swapRouter;
        address deployer;
        bool mainnet;
        uint256 seriesId;
        uint128 capacity;
        uint8 decimals;
    }

    function run()
        external
        returns (CredailyRentOracle oracle, CoverToken token, CoverPool pool, SwapAndBuyRouter router)
    {
        Deployment memory d;
        uint256 pk = vm.envOr("PRIVATE_KEY", vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0)));
        require(pk != 0, "set PRIVATE_KEY (or DEPLOYER_PRIVATE_KEY)");
        d.deployer = vm.rememberKey(pk);

        d.mainnet = block.chainid == ARBITRUM_ONE_CHAIN_ID || block.chainid == GNOSIS_CHAIN_ID;
        d.currency = _resolveCurrency();
        d.swapRouter = _resolveSwapRouter();

        vm.startBroadcast(d.deployer);

        // 0. Local chains only: no CURRENCY override → deploy a WETH9-style stand-in
        //    so the e2e suite can wrap dev-account coin exactly like WXDAI on Gnosis.
        bool localCurrency = address(d.currency) == address(0);
        if (localCurrency) {
            d.currency = IERC20(address(new LocalWXDAI()));
        }
        d.decimals = IERC20Metadata(address(d.currency)).decimals();

        // 1. Oracle with the pinned CRE Daily key.
        d.oracle = new CredailyRentOracle(CredailyKey.MODULUS);

        // 2. CoverToken ↔ CoverPool circular immutable: the pool is the deployer's NEXT
        //    CREATE after the token, so its address is computeCreateAddress(deployer,
        //    nonce + 1). Do not send any other tx from the deployer between the two.
        address predictedPool = vm.computeCreateAddress(d.deployer, vm.getNonce(d.deployer) + 1);
        d.token = new CoverToken(predictedPool, d.decimals);
        d.pool = new CoverPool(d.currency, d.token, IObservationOracle(address(d.oracle)));
        if (address(d.pool) != predictedPool) revert PoolAddressMismatch(predictedPool, address(d.pool));

        // 3. Router against the chain's SwapRouter02 (zero address = no router here,
        //    skip). The router reads the pool currency from the pool itself.
        if (d.swapRouter != address(0)) {
            d.router = new SwapAndBuyRouter(ISwapRouter02(d.swapRouter), ICoverPool(address(d.pool)));
        }

        // 4. Demo series — LOCAL/e2e chains ONLY. On mainnet, series creation is a
        //    post-deploy permissionless act (the agent escrows real capacity itself),
        //    so the stack ships with zero series. Locally the broadcaster escrows the
        //    demo capacity inline: 0.02 currency units, the frozen e2e number (fund
        //    0.02 / buy 0.01 / premium 0.00285 / ratio 61% all still hold).
        if (!d.mainnet) {
            (d.seriesId, d.capacity) = _createDemoSeries(d.pool, d.currency, localCurrency, d.decimals);
        }

        vm.stopBroadcast();

        _postflight(d);

        console.log("CredailyRentOracle:", address(d.oracle));
        console.log("CoverToken:       ", address(d.token));
        console.log("CoverPool:        ", address(d.pool));
        if (address(d.router) != address(0)) {
            console.log("SwapAndBuyRouter: ", address(d.router));
        } else {
            console.log("SwapAndBuyRouter:  skipped (no swap router on this chain)");
        }
        console.log("Currency:         ", address(d.currency));
        if (d.mainnet) {
            console.log("Series:            none (createSeries is a permissionless post-deploy act)");
        } else {
            console.log("Demo seriesId:    ", d.seriesId);
            console.log("Demo saleEnd=obsStart:", d.pool.series(d.seriesId).obsStart);
        }
        return (d.oracle, d.token, d.pool, d.router);
    }

    /// @dev LOCAL/e2e chains only, called inside the broadcast: derives the demo
    ///      window from `block.timestamp`, wraps the demo capacity from native coin
    ///      (when the {LocalWXDAI} stand-in was deployed here), approves the pool and
    ///      escrows it through the permissionless `createSeries`.
    function _createDemoSeries(CoverPool pool, IERC20 currency, bool localCurrency, uint8 decimals)
        internal
        returns (uint256 seriesId, uint128 capacity)
    {
        uint64 saleEnd = uint64(block.timestamp) + DEMO_SALE_DURATION;
        uint64 obsStart = saleEnd; // sale closes exactly when the window opens
        uint64 obsEnd = obsStart + DEMO_OBS_DURATION;
        uint64 redeemEnd = obsEnd + DEMO_CLAIM_DURATION;
        // The whole point of the warped e2e clock: the real fixture email must be
        // able to settle the demo series. With anvil at --timestamp 1789000000,
        // obsStart ≈ 1789129600 ≤ FIXTURE_T = 1789642464 ≤ obsEnd ≈ 1791721600.
        if (!(obsStart <= FIXTURE_T && FIXTURE_T <= obsEnd)) {
            revert PostDeployCheckFailed("fixture t outside demo window (spawn anvil with --timestamp 1789000000)");
        }
        capacity = uint128(2 * 10 ** uint256(decimals) / 100); // 0.02 units
        if (localCurrency) {
            LocalWXDAI(payable(address(currency))).deposit{value: capacity}();
        }
        if (!currency.approve(address(pool), capacity)) revert PostDeployCheckFailed("escrow approve");
        seriesId = pool.createSeries(
            STRIKE_LOW_CENTS, STRIKE_HIGH_CENTS, PREMIUM_RATE_BPS, saleEnd, obsStart, obsEnd, redeemEnd, capacity
        );
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
    function _postflight(Deployment memory d) internal view {
        if (d.oracle.MODULUS_HASH() != CredailyKey.MODULUS_HASH) {
            revert PostDeployCheckFailed("oracle.MODULUS_HASH");
        }
        if (keccak256(d.oracle.modulus()) != CredailyKey.MODULUS_HASH) revert PostDeployCheckFailed("oracle.modulus");
        if (d.oracle.observationCount() != 0) revert PostDeployCheckFailed("oracle not empty");
        if (d.token.pool() != address(d.pool)) revert PostDeployCheckFailed("token.pool");
        if (d.token.currencyDecimals() != d.decimals) revert PostDeployCheckFailed("token.currencyDecimals");
        if (address(d.pool.token()) != address(d.token)) revert PostDeployCheckFailed("pool.token");
        if (address(d.pool.oracle()) != address(d.oracle)) revert PostDeployCheckFailed("pool.oracle");
        if (address(d.pool.currency()) != address(d.currency)) revert PostDeployCheckFailed("pool.currency");
        _assertNoOwnerishSelectors(d.pool);
        if (d.swapRouter == address(0)) {
            if (address(d.router) != address(0)) revert PostDeployCheckFailed("router deployed without swap router");
        } else {
            if (address(d.router.pool()) != address(d.pool)) revert PostDeployCheckFailed("router.pool");
            if (address(d.router.swapRouter()) != d.swapRouter) revert PostDeployCheckFailed("router.swapRouter");
            if (address(d.router.usdc()) != address(d.currency)) revert PostDeployCheckFailed("router.usdc");
            if (d.router.weth9() != ISwapRouter02(d.swapRouter).WETH9()) revert PostDeployCheckFailed("router.weth9");
        }
        if (d.mainnet) {
            // Mainnet ships with ZERO series: createSeries is permissionless and the
            // agent escrows real capacity itself, after the deploy.
            if (d.pool.seriesCount() != 0) revert PostDeployCheckFailed("mainnet seriesCount != 0");
            return;
        }
        if (d.pool.seriesCount() != 1 || d.seriesId != 0) revert PostDeployCheckFailed("seriesCount");
        CoverPool.Series memory s = d.pool.series(0);
        if (s.creator != d.deployer) revert PostDeployCheckFailed("series.creator");
        if (s.strikeLowCents != STRIKE_LOW_CENTS || s.strikeHighCents != STRIKE_HIGH_CENTS) {
            revert PostDeployCheckFailed("series.strikes");
        }
        if (s.premiumRateBps != PREMIUM_RATE_BPS || s.escrow != d.capacity) {
            revert PostDeployCheckFailed("series.economics");
        }
        if (d.currency.balanceOf(address(d.pool)) < d.capacity) revert PostDeployCheckFailed("series.escrowFunded");
        if (s.saleEnd != s.obsStart || s.obsEnd != s.obsStart + DEMO_OBS_DURATION) {
            revert PostDeployCheckFailed("series.windows");
        }
        if (s.redeemEnd != s.obsEnd + DEMO_CLAIM_DURATION) revert PostDeployCheckFailed("series.windows");
        if (!(s.obsStart <= FIXTURE_T && FIXTURE_T <= s.obsEnd)) revert PostDeployCheckFailed("series.fixtureT");
        if (block.timestamp > s.saleEnd) revert PostDeployCheckFailed("series not buyable now");
        if (s.sold != 0 || s.settled || s.cancelled) revert PostDeployCheckFailed("series.state");
    }

    /// @dev The Option B pool has NO ROLES AT ALL: every sponsor/owner-era selector
    ///      must be absent from the bytecode. A STATICCALL to a selector the contract
    ///      does not implement hits the (nonexistent) fallback and fails, so every
    ///      probe below must come back `false`.
    function _assertNoOwnerishSelectors(CoverPool pool) internal view {
        bytes[10] memory probes = [
            abi.encodeWithSignature("owner()"),
            abi.encodeWithSignature("sponsor()"),
            abi.encodeWithSignature("pendingSponsor()"),
            abi.encodeWithSignature("salesPaused()"),
            abi.encodeWithSignature("freeCapital()"),
            abi.encodeWithSignature("fundPool(uint256)", uint256(0)),
            abi.encodeWithSignature("withdrawExcess(uint256)", uint256(0)),
            abi.encodeWithSignature("setSalesPaused(bool)", true),
            abi.encodeWithSignature("transferSponsorship(address)", address(0xdEaD)),
            abi.encodeWithSignature("acceptSponsorship()")
        ];
        for (uint256 i = 0; i < probes.length; ++i) {
            (bool okCall,) = address(pool).staticcall(probes[i]);
            if (okCall) revert PostDeployCheckFailed("pool exposes an owner-ish selector");
        }
    }
}
