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
import {LocalWXDAI} from "./LocalWXDAI.sol";

/// @title Deploy
/// @notice One-shot deployment of the NY Rent Cover stack on Gnosis Chain (chainId 100):
///         {CredailyRentOracle} (pinned CRE Daily DKIM key from the GENERATED constant
///         `src/gen/CredailyKey.sol` — zero file deps at deploy time) → {CoverToken} +
///         {CoverPool} (CREATE-address precompute for the circular immutable) → the demo
///         series. Etherform-compatible: `forge script script/Deploy.s.sol:Deploy`.
/// @dev    Env: PRIVATE_KEY (etherform secret name; DEPLOYER_PRIVATE_KEY also accepted),
///         optional CURRENCY to override the token on non-Gnosis chains (anvil e2e).
contract Deploy is Script {
    // ─────────────────────────────────────────────────────────────────────────
    // Gnosis Chain constants
    // ─────────────────────────────────────────────────────────────────────────

    uint256 public constant GNOSIS_CHAIN_ID = 100;

    /// @notice Wrapped xDAI. ADDRESS VERIFICATION (2026-09-18, rpc.gnosischain.com):
    ///         `cast call 0xe91D…a97d "symbol()(string)"`   → "WXDAI"
    ///         `cast call 0xe91D…a97d "decimals()(uint8)"`  → 18
    address public constant WXDAI = 0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d;

    // ─────────────────────────────────────────────────────────────────────────
    // Demo series parameters (SPEC §2.5)
    // ─────────────────────────────────────────────────────────────────────────

    uint32 public constant STRIKE_LOW_CENTS = 8800; // $88.00 / SF → payout 0
    uint32 public constant STRIKE_HIGH_CENTS = 9600; // $96.00 / SF → payout 1
    uint16 public constant PREMIUM_RATE_BPS = 2850; // 28.50% of max claim
    uint64 public constant OBS_START = 1_788_220_800; // 2026-09-01 00:00:00 UTC
    uint64 public constant OBS_END = 1_790_812_740; // 2026-09-30 23:59:00 UTC
    uint64 public constant SALE_END = OBS_END; // demo sells during the window (documented caveat)
    uint64 public constant REDEEM_END = OBS_END + 90 days;
    uint128 public constant CAPACITY = 0.02 ether; // 0.02 WXDAI — tiny demo capacity

    error WrongChain(uint256 chainId);
    error NoCode(string what, address where);
    error BadCurrencyMetadata(string what);
    error PoolAddressMismatch(address predicted, address actual);
    error PostDeployCheckFailed(string what);

    function run() external returns (CredailyRentOracle oracle, CoverToken token, CoverPool pool) {
        uint256 pk = vm.envOr("PRIVATE_KEY", vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0)));
        require(pk != 0, "set PRIVATE_KEY (or DEPLOYER_PRIVATE_KEY)");
        address deployer = vm.rememberKey(pk);

        IERC20 currency = _resolveCurrency();

        vm.startBroadcast(deployer);

        // 0. Local chains only: no CURRENCY override → deploy a WETH9-style stand-in
        //    so the e2e suite can wrap dev-account coin exactly like WXDAI on Gnosis.
        if (address(currency) == address(0)) {
            currency = IERC20(address(new LocalWXDAI()));
        }

        // 1. Oracle with the pinned CRE Daily key.
        oracle = new CredailyRentOracle(CredailyKey.MODULUS);

        // 2. CoverToken ↔ CoverPool circular immutable: the pool is the deployer's NEXT
        //    CREATE after the token, so its address is computeCreateAddress(deployer,
        //    nonce + 1). Do not send any other tx from the deployer between the two.
        uint64 nonce = vm.getNonce(deployer);
        address predictedPool = vm.computeCreateAddress(deployer, nonce + 1);
        token = new CoverToken(predictedPool);
        pool = new CoverPool(currency, token, IObservationOracle(address(oracle)), deployer);
        if (address(pool) != predictedPool) revert PoolAddressMismatch(predictedPool, address(pool));

        // 3. Demo series.
        uint256 seriesId = pool.createSeries(
            STRIKE_LOW_CENTS, STRIKE_HIGH_CENTS, PREMIUM_RATE_BPS, SALE_END, OBS_START, OBS_END, REDEEM_END, CAPACITY
        );

        vm.stopBroadcast();

        _postflight(oracle, token, pool, currency, deployer, seriesId);

        console.log("CredailyRentOracle:", address(oracle));
        console.log("CoverToken:       ", address(token));
        console.log("CoverPool:        ", address(pool));
        console.log("Demo seriesId:    ", seriesId);
    }

    /// @dev Chain guard + WXDAI metadata verification. On anvil (31337) an optional
    ///      CURRENCY env override may point at deployed ERC-20 code; with no override
    ///      address(0) is returned and `run` deploys a {LocalWXDAI} inside the broadcast.
    function _resolveCurrency() internal view returns (IERC20) {
        if (block.chainid == GNOSIS_CHAIN_ID) {
            if (WXDAI.code.length == 0) revert NoCode("WXDAI", WXDAI);
            if (keccak256(bytes(IERC20Metadata(WXDAI).symbol())) != keccak256("WXDAI")) {
                revert BadCurrencyMetadata("symbol != WXDAI");
            }
            if (IERC20Metadata(WXDAI).decimals() != 18) revert BadCurrencyMetadata("decimals != 18");
            return IERC20(WXDAI);
        }
        if (block.chainid == 31337) {
            address overrideCurrency = vm.envOr("CURRENCY", address(0));
            if (overrideCurrency == address(0)) return IERC20(address(0)); // deploy LocalWXDAI in run()
            if (overrideCurrency.code.length == 0) revert NoCode("CURRENCY override (anvil)", overrideCurrency);
            return IERC20(overrideCurrency);
        }
        revert WrongChain(block.chainid);
    }

    /// @dev Wiring invariants; nothing is upgradeable, so any failure means redeploy.
    function _postflight(
        CredailyRentOracle oracle,
        CoverToken token,
        CoverPool pool,
        IERC20 currency,
        address deployer,
        uint256 seriesId
    ) internal view {
        if (oracle.MODULUS_HASH() != CredailyKey.MODULUS_HASH) {
            revert PostDeployCheckFailed("oracle.MODULUS_HASH");
        }
        if (keccak256(oracle.modulus()) != CredailyKey.MODULUS_HASH) revert PostDeployCheckFailed("oracle.modulus");
        if (oracle.observationCount() != 0) revert PostDeployCheckFailed("oracle not empty");
        if (token.pool() != address(pool)) revert PostDeployCheckFailed("token.pool");
        if (address(pool.token()) != address(token)) revert PostDeployCheckFailed("pool.token");
        if (address(pool.oracle()) != address(oracle)) revert PostDeployCheckFailed("pool.oracle");
        if (address(pool.currency()) != address(currency)) revert PostDeployCheckFailed("pool.currency");
        if (pool.sponsor() != deployer) revert PostDeployCheckFailed("pool.sponsor");
        if (pool.seriesCount() != 1 || seriesId != 0) revert PostDeployCheckFailed("seriesCount");
        CoverPool.Series memory s = pool.series(0);
        if (s.strikeLowCents != STRIKE_LOW_CENTS || s.strikeHighCents != STRIKE_HIGH_CENTS) {
            revert PostDeployCheckFailed("series.strikes");
        }
        if (s.premiumRateBps != PREMIUM_RATE_BPS || s.capacity != CAPACITY) {
            revert PostDeployCheckFailed("series.economics");
        }
        if (s.saleEnd != SALE_END || s.obsStart != OBS_START || s.obsEnd != OBS_END || s.redeemEnd != REDEEM_END) {
            revert PostDeployCheckFailed("series.windows");
        }
        if (s.sold != 0 || s.settled) revert PostDeployCheckFailed("series.state");
    }
}
