// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CoverPool} from "../src/CoverPool.sol";
import {CoverToken} from "../src/CoverToken.sol";
import {MockObservationOracle} from "./utils/Helpers.sol";
import {TestUSDC} from "./CoverPool.t.sol";

/// @notice Randomized-sequence handler for the permissionless {CoverPool}: create /
///         addCapacity / buy / buyFor / settle / redeem / cancel / withdrawResidual /
///         per-series pause / warp in any order the fuzzer picks, across three
///         independent creators and three buyers. Creator-only calls are pranked as
///         the series' own creator so the sequences exercise real state transitions,
///         not just access-control reverts.
contract PoolHandler is Test {
    CoverPool public pool;
    CoverToken public token;
    TestUSDC public usdc;
    MockObservationOracle public oracle;
    address[3] public creators;
    address[3] public buyers;

    uint256 public constant ONE = 1e6;

    /// @notice Claim units burned through {CoverPool.redeem}, per series.
    mapping(uint256 seriesId => uint256) public ghostRedeemedUnits;

    uint256 internal obsIndexSalt;

    constructor(CoverPool pool_, CoverToken token_, TestUSDC usdc_, MockObservationOracle oracle_) {
        pool = pool_;
        token = token_;
        usdc = usdc_;
        oracle = oracle_;
        for (uint256 i = 0; i < 3; ++i) {
            creators[i] = makeAddr(string.concat("h-creator", vm.toString(i)));
            buyers[i] = makeAddr(string.concat("h-buyer", vm.toString(i)));
            usdc.mint(creators[i], 10_000_000 * ONE);
            vm.prank(creators[i]);
            usdc.approve(address(pool), type(uint256).max);
            usdc.mint(buyers[i], 1_000_000 * ONE);
            vm.prank(buyers[i]);
            usdc.approve(address(pool), type(uint256).max);
        }
    }

    /// @dev Short-lifetime series are GENERATABLE by design: the sale can close within
    ///      seconds, the observation window can be a second long and the claim window
    ///      bottoms out at the on-chain minimum (`MIN_REDEEM_WINDOW`, 7 days), so a
    ///      series' entire life — including the post-`redeemEnd` surface of
    ///      withdrawResidual / late settle / cancel-after-residual — fits comfortably
    ///      inside one fuzzed run and the conservation invariant can see double-exit
    ///      bugs.
    function createSeries(
        uint8 who,
        uint16 rateBps,
        uint96 capRaw,
        uint32 saleDelayRaw,
        uint32 obsLenRaw,
        uint32 claimDelayRaw
    ) external {
        uint128 cap = uint128(bound(uint256(capRaw), ONE, 10_000 * ONE));
        uint64 saleEnd = uint64(block.timestamp + bound(uint256(saleDelayRaw), 1, 3 days));
        uint64 obsStart = saleEnd;
        uint64 obsEnd = obsStart + uint64(bound(uint256(obsLenRaw), 1, 5 days));
        uint64 redeemEnd = obsEnd + uint64(bound(uint256(claimDelayRaw), 7 days, 21 days));
        vm.prank(creators[who % 3]);
        pool.createSeries(8800, 9600, uint16(bound(rateBps, 0, 1e4)), saleEnd, obsStart, obsEnd, redeemEnd, cap);
    }

    function addCapacity(uint8 seriesRaw, uint96 amtRaw) external {
        uint256 n = pool.seriesCount();
        if (n == 0) return;
        uint256 id = seriesRaw % n;
        uint128 amt = uint128(bound(uint256(amtRaw), 1, 10_000 * ONE));
        vm.prank(pool.series(id).creator);
        try pool.addCapacity(id, amt) {} catch {}
    }

    function buy(uint8 who, uint8 seriesRaw, uint96 amtRaw) external {
        uint256 n = pool.seriesCount();
        if (n == 0) return;
        uint256 id = seriesRaw % n;
        address buyer = buyers[who % 3];
        uint256 amt = bound(uint256(amtRaw), 1, 100 * ONE);
        vm.prank(buyer);
        try pool.buyProtection(id, amt, type(uint256).max) {} catch {}
    }

    function buyFor(uint8 who, uint8 recipientRaw, uint8 seriesRaw, uint96 amtRaw) external {
        uint256 n = pool.seriesCount();
        if (n == 0) return;
        uint256 id = seriesRaw % n;
        address payer = buyers[who % 3];
        address recipient = buyers[recipientRaw % 3];
        uint256 amt = bound(uint256(amtRaw), 1, 100 * ONE);
        vm.prank(payer);
        try pool.buyProtectionFor(id, amt, type(uint256).max, recipient) {} catch {}
    }

    function settle(uint8 seriesRaw, uint32 cents, uint32 tOffset) external {
        uint256 n = pool.seriesCount();
        if (n == 0) return;
        uint256 id = seriesRaw % n;
        CoverPool.Series memory s = pool.series(id);
        // sometimes out of window on either side
        uint64 t =
            uint64(uint256(s.obsStart) - 5 days + bound(uint256(tOffset), 0, uint256(s.obsEnd - s.obsStart) + 10 days));
        uint256 obsIndex = oracle.push(t, cents, keccak256(abi.encode(t, cents, obsIndexSalt++)));
        try pool.settle(id, obsIndex) {} catch {}
    }

    function redeem(uint8 who, uint8 seriesRaw, uint96 amtRaw) external {
        uint256 n = pool.seriesCount();
        if (n == 0) return;
        uint256 id = seriesRaw % n;
        address buyer = buyers[who % 3];
        uint256 balance = token.balanceOf(buyer, id);
        if (balance == 0) return;
        uint256 amt = bound(uint256(amtRaw), 1, balance);
        vm.prank(buyer);
        try pool.redeem(id, amt) {
            ghostRedeemedUnits[id] += amt;
        } catch {}
    }

    function cancel(uint8 seriesRaw) external {
        uint256 n = pool.seriesCount();
        if (n == 0) return;
        uint256 id = seriesRaw % n;
        vm.prank(pool.series(id).creator);
        try pool.cancelSeries(id) {} catch {}
    }

    function withdrawResidual(uint8 seriesRaw) external {
        uint256 n = pool.seriesCount();
        if (n == 0) return;
        uint256 id = seriesRaw % n;
        vm.prank(pool.series(id).creator);
        try pool.withdrawResidual(id) {} catch {}
    }

    /// @dev Both creator exits back-to-back on one series, in either order — the
    ///      distilled shape of every double-exit bug. Under the mutual-exclusivity
    ///      rule at most ONE of the two calls may ever pay, whatever the series
    ///      state; if both pay, the conservation invariant fails on the spot (the
    ///      second payment can only come out of a sibling series' bucket).
    function creatorExit(uint8 seriesRaw, bool residualFirst) external {
        uint256 n = pool.seriesCount();
        if (n == 0) return;
        uint256 id = seriesRaw % n;
        address creator = pool.series(id).creator;
        if (residualFirst) {
            vm.prank(creator);
            try pool.withdrawResidual(id) {} catch {}
            vm.prank(creator);
            try pool.cancelSeries(id) {} catch {}
        } else {
            vm.prank(creator);
            try pool.cancelSeries(id) {} catch {}
            vm.prank(creator);
            try pool.withdrawResidual(id) {} catch {}
        }
    }

    function setSeriesPaused(uint8 seriesRaw, bool paused) external {
        uint256 n = pool.seriesCount();
        if (n == 0) return;
        uint256 id = seriesRaw % n;
        vm.prank(pool.series(id).creator);
        pool.setSeriesPaused(id, paused);
    }

    /// @dev Warp steps routinely cross a fresh series' full lifetime (the legal
    ///      minimum is ~7 days), not just its sale window.
    function warp(uint32 delta) external {
        vm.warp(block.timestamp + bound(uint256(delta), 0, 10 days));
    }

    /// @dev Targeted warp to just past a chosen series' `redeemEnd`, so the
    ///      post-claim-window state class (residual withdrawal and its interleavings
    ///      with cancel) is reachable in every run, not only when enough random warps
    ///      compound.
    function warpPastRedeemEnd(uint8 seriesRaw) external {
        uint256 n = pool.seriesCount();
        if (n == 0) return;
        uint256 id = seriesRaw % n;
        uint256 redeemEnd = pool.series(id).redeemEnd;
        if (block.timestamp <= redeemEnd) vm.warp(redeemEnd + 1);
    }
}

/// @notice Option-B invariants under random multi-actor sequences: per-series
///         conservation against the pool balance, per-series solvency (paidOut ≤
///         sold × ratio ≤ escrow), capacity/ratio bounds, and soulbound supply
///         accounting (claim units never move, they only mint on buy and burn on
///         redeem).
contract CoverPoolInvariantTest is Test {
    TestUSDC internal usdc;
    MockObservationOracle internal oracle;
    CoverToken internal token;
    CoverPool internal pool;
    PoolHandler internal handler;

    function setUp() public {
        vm.warp(1_789_000_000);
        usdc = new TestUSDC();
        oracle = new MockObservationOracle();
        uint64 nonce = vm.getNonce(address(this));
        address predictedPool = vm.computeCreateAddress(address(this), nonce + 1);
        token = new CoverToken(predictedPool, usdc.decimals());
        pool = new CoverPool(usdc, token, oracle);
        handler = new PoolHandler(pool, token, usdc, oracle);
        targetContract(address(handler));
    }

    /// @notice CONSERVATION: Σ over series of (escrow + premiumsAccrued − paidOut −
    ///         withdrawn) always equals the pool's currency balance — no series can
    ///         gain or lose a wei except through its own recorded flows.
    function invariant_conservation() public view {
        uint256 n = pool.seriesCount();
        uint256 total;
        for (uint256 i = 0; i < n; ++i) {
            CoverPool.Series memory s = pool.series(i);
            total += uint256(s.escrow) + s.premiumsAccrued - s.paidOut - s.withdrawn;
        }
        assertEq(usdc.balanceOf(address(pool)), total);
    }

    /// @notice SOLVENCY, per series: sold never exceeds escrow, premiums never exceed
    ///         sold, and paidOut never exceeds the settled obligation sold × ratio.
    ///         An unsettled series has paid nothing.
    function invariant_perSeriesSolvency() public view {
        uint256 n = pool.seriesCount();
        for (uint256 i = 0; i < n; ++i) {
            CoverPool.Series memory s = pool.series(i);
            assertLe(s.sold, s.escrow, "sold <= escrow");
            assertLe(s.premiumsAccrued, s.sold, "premiums <= sold");
            if (s.settled) {
                assertLe(s.paidOut, (uint256(s.sold) * s.payoutRatioWad) / 1e18, "paidOut <= sold x ratio");
            } else {
                assertEq(s.paidOut, 0, "unsettled series pays nothing");
            }
        }
    }

    /// @notice Settlement is one-shot and bounded: ratio stays within [0, 1e18] and is
    ///         zero until settlement; a cancelled series is never settled and never
    ///         sold anything.
    function invariant_ratioAndCancelBounds() public view {
        uint256 n = pool.seriesCount();
        for (uint256 i = 0; i < n; ++i) {
            CoverPool.Series memory s = pool.series(i);
            assertLe(s.payoutRatioWad, 1e18);
            if (!s.settled) assertEq(s.payoutRatioWad, 0);
            if (s.cancelled) {
                assertFalse(s.settled, "cancelled series never settles");
                assertEq(s.sold, 0, "cancelled series never sold");
                assertEq(s.escrow, 0, "cancel zeroes the escrow: the refund closes the book");
                assertEq(s.withdrawn, 0, "cancel books its refund via escrow, never via withdrawn");
                assertTrue(s.residualWithdrawn, "cancel consumes the shared exit latch");
            }
        }
    }

    /// @notice SOULBOUND supply: claim units cannot move, so for every series the sum
    ///         of actor balances is exactly sold − redeemed units.
    function invariant_soulboundSupply() public view {
        uint256 n = pool.seriesCount();
        for (uint256 i = 0; i < n; ++i) {
            uint256 held;
            for (uint256 b = 0; b < 3; ++b) {
                held += token.balanceOf(handler.buyers(b), i);
            }
            assertEq(held, pool.series(i).sold - handler.ghostRedeemedUnits(i));
        }
    }

    /// @notice The creator can never take out more than its own bucket ever contained.
    function invariant_withdrawnBounded() public view {
        uint256 n = pool.seriesCount();
        for (uint256 i = 0; i < n; ++i) {
            CoverPool.Series memory s = pool.series(i);
            assertLe(s.withdrawn + s.paidOut, uint256(s.escrow) + s.premiumsAccrued);
            if (!s.residualWithdrawn) assertEq(s.withdrawn, 0, "withdrawn only through cancel/residual");
        }
    }
}
