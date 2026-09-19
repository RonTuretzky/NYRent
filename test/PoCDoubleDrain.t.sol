// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CoverPool} from "../src/CoverPool.sol";
import {CoverToken} from "../src/CoverToken.sol";
import {IObservationOracle} from "../src/interfaces/IObservationOracle.sol";
import {MockObservationOracle} from "./utils/Helpers.sol";
import {TestUSDC} from "./CoverPool.t.sol";

/// @notice Regression for the critical withdrawResidual-then-cancelSeries double-drain
///         (adversarial review, both lenses). Before the fix, cancelSeries never
///         checked `residualWithdrawn`, so an attacker with an unsold, unsettled
///         series could take the escrow TWICE — the second payment out of a victim
///         creator's bucket — until the pool was empty. The exits are now strictly
///         mutually exclusive (shared latch, consumed in both directions) and cancel
///         zeroes the escrow, so even a hypothetical latch bypass would pay nothing.
contract PoCDoubleDrainTest is Test {
    uint64 internal constant T0 = 1_789_000_000;
    uint256 internal constant ONE = 1e6;

    TestUSDC internal usdc;
    CoverToken internal token;
    CoverPool internal pool;
    MockObservationOracle internal oracle;

    address internal attacker = makeAddr("attacker");
    address internal victim = makeAddr("victim"); // honest creator of a sibling series

    function setUp() public {
        vm.warp(T0);
        usdc = new TestUSDC();
        oracle = new MockObservationOracle();
        uint64 nonce = vm.getNonce(address(this));
        address predictedPool = vm.computeCreateAddress(address(this), nonce + 1);
        token = new CoverToken(predictedPool, usdc.decimals());
        pool = new CoverPool(usdc, token, IObservationOracle(address(oracle)));

        usdc.mint(attacker, 100 * ONE);
        usdc.mint(victim, 100 * ONE);
        vm.prank(attacker);
        usdc.approve(address(pool), type(uint256).max);
        vm.prank(victim);
        usdc.approve(address(pool), type(uint256).max);
    }

    function test_regression_withdrawResidualThenCancel_cannotDoubleDrain() public {
        // victim's honest series escrows 100 into the pool
        vm.prank(victim);
        uint256 victimId = pool.createSeries(
            8800, 9600, 2850, T0 + 10 days, T0 + 10 days, T0 + 20 days, T0 + 50 days, uint128(100 * ONE)
        );

        // attacker's series escrows 100, sells nothing
        vm.prank(attacker);
        uint256 id = pool.createSeries(
            8800, 9600, 2850, T0 + 10 days, T0 + 10 days, T0 + 20 days, T0 + 50 days, uint128(100 * ONE)
        );

        vm.warp(T0 + 50 days + 1); // past redeemEnd

        vm.startPrank(attacker);
        pool.withdrawResidual(id); // takes back the 100 escrow (sold == 0, unsettled)
        vm.expectRevert(CoverPool.ResidualAlreadyWithdrawn.selector);
        pool.cancelSeries(id); // MUST NOT refund the escrow a second time
        vm.stopPrank();

        // attacker got back exactly its own escrow; the victim's bucket is intact
        assertEq(usdc.balanceOf(attacker), 100 * ONE, "no double drain");
        assertEq(usdc.balanceOf(address(pool)), 100 * ONE, "victim's escrow untouched");
        assertEq(pool.series(victimId).escrow, 100 * ONE, "victim series still fully backed");

        // conservation: Σ (escrow + premiums − paidOut − withdrawn) == pool balance
        uint256 total;
        for (uint256 i = 0; i < pool.seriesCount(); ++i) {
            CoverPool.Series memory s = pool.series(i);
            total += uint256(s.escrow) + s.premiumsAccrued - s.paidOut - s.withdrawn;
        }
        assertEq(usdc.balanceOf(address(pool)), total, "conservation invariant holds");
    }
}
