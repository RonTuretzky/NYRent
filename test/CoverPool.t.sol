// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20Errors, IERC1155Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {CoverPool} from "../src/CoverPool.sol";
import {CoverToken} from "../src/CoverToken.sol";
import {IObservationOracle} from "../src/interfaces/IObservationOracle.sol";
import {MockObservationOracle} from "./utils/Helpers.sol";

/// @notice Mintable 6-decimals ERC-20 standing in for Arbitrum native USDC in tests.
contract TestUSDC is ERC20 {
    constructor() ERC20("USD Coin (test)", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Contract recipient without any ERC-1155 acceptance hook: minting to it
///         must revert and roll the whole purchase back.
contract NonReceiver {}

/// @notice Contract recipient that accepts ERC-1155 mints.
contract AcceptingRecipient is ERC1155Holder {}

/// @dev Reenters the pool from the ERC-1155 mint acceptance callback of the
///      {CoverPool.buyProtectionFor} entrypoint, through every guarded surface.
contract ReentrantRecipient {
    CoverPool internal immutable pool;
    TestUSDC internal immutable usdc;
    uint8 internal mode; // 0 buyProtectionFor, 1 buyProtection, 2 settle, 3 createSeries, 4 cancelSeries, 5 withdrawResidual
    bool internal reentered;

    constructor(CoverPool pool_, TestUSDC usdc_) {
        pool = pool_;
        usdc = usdc_;
    }

    function attack(uint256 seriesId, uint256 maxClaim, uint8 mode_) external {
        mode = mode_;
        usdc.approve(address(pool), type(uint256).max);
        pool.buyProtectionFor(seriesId, maxClaim, type(uint256).max, address(this));
    }

    function onERC1155Received(address, address, uint256 seriesId, uint256, bytes calldata) external returns (bytes4) {
        if (!reentered) {
            reentered = true;
            // must revert: reentrant on any pool entrypoint
            if (mode == 0) {
                pool.buyProtectionFor(seriesId, 1, type(uint256).max, address(this));
            } else if (mode == 1) {
                pool.buyProtection(seriesId, 1, type(uint256).max);
            } else if (mode == 2) {
                pool.settle(seriesId, 0);
            } else if (mode == 3) {
                uint64 t = uint64(block.timestamp);
                pool.createSeries(8800, 9600, 2850, t + 1 days, t + 1 days, t + 2 days, t + 3 days, 1e6);
            } else if (mode == 4) {
                pool.cancelSeries(seriesId);
            } else {
                pool.withdrawResidual(seriesId);
            }
        }
        return this.onERC1155Received.selector;
    }
}

/// @notice CoverPool scenario matrix at the 6-decimals USDC deployment currency:
///         permissionless create-with-escrow, buy/settle/redeem math, window and clamp
///         edges, per-series (creator-only) pause, addCapacity/cancel/withdrawResidual
///         lifecycles, multi-creator isolation, {buyProtectionFor} recipient minting,
///         plus fuzz. Invariants live in {CoverPoolInvariantTest}.
contract CoverPoolTest is Test {
    uint64 internal constant T0 = 1_789_000_000; // base clock for all series

    uint256 internal constant ONE = 1e6; // native USDC has 6 decimals
    uint32 internal constant LOW = 8800;
    uint32 internal constant HIGH = 9600;
    uint16 internal constant RATE = 2850;
    uint128 internal constant CAP = uint128(100 * ONE);

    uint64 internal saleEnd;
    uint64 internal obsStart;
    uint64 internal obsEnd;
    uint64 internal redeemEnd;

    TestUSDC internal usdc;
    MockObservationOracle internal oracle;
    CoverToken internal token;
    CoverPool internal pool;

    address internal creator = makeAddr("creator");
    address internal rival = makeAddr("rival"); // a second, unrelated series creator
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        vm.warp(T0);
        saleEnd = T0 + 10 days;
        obsStart = saleEnd; // saleEnd ≤ obsStart is an on-chain invariant now
        obsEnd = T0 + 20 days;
        redeemEnd = T0 + 50 days;

        usdc = new TestUSDC();
        oracle = new MockObservationOracle();

        uint64 nonce = vm.getNonce(address(this));
        address predictedPool = vm.computeCreateAddress(address(this), nonce + 1);
        token = new CoverToken(predictedPool, usdc.decimals());
        pool = new CoverPool(usdc, token, IObservationOracle(address(oracle)));
        assertEq(address(pool), predictedPool);

        usdc.mint(creator, 10_000 * ONE);
        usdc.mint(rival, 10_000 * ONE);
        usdc.mint(alice, 1_000 * ONE);
        usdc.mint(bob, 1_000 * ONE);
        vm.prank(creator);
        usdc.approve(address(pool), type(uint256).max);
        vm.prank(rival);
        usdc.approve(address(pool), type(uint256).max);
        vm.prank(alice);
        usdc.approve(address(pool), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(pool), type(uint256).max);
    }

    function _createDefault() internal returns (uint256 id) {
        id = _createAs(creator, CAP);
    }

    function _createAs(address who, uint128 cap) internal returns (uint256 id) {
        vm.prank(who);
        id = pool.createSeries(LOW, HIGH, RATE, saleEnd, obsStart, obsEnd, redeemEnd, cap);
    }

    function _buy(address who, uint256 id, uint256 maxClaim) internal returns (uint256 premium) {
        premium = (maxClaim * RATE) / 1e4;
        vm.prank(who);
        pool.buyProtection(id, maxClaim, premium);
    }

    function _settleAt(uint256 id, uint64 t, uint32 cents) internal returns (uint256 obsIndex) {
        obsIndex = oracle.push(t, cents, keccak256(abi.encode(t, cents)));
        pool.settle(id, obsIndex);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // createSeries: permissionless, escrow pull
    // ─────────────────────────────────────────────────────────────────────────

    function test_createSeries_storesParamsAndPullsEscrow() public {
        uint256 creatorPre = usdc.balanceOf(creator);
        vm.prank(creator);
        vm.expectEmit(true, true, true, true);
        emit CoverPool.SeriesCreated(0, creator, LOW, HIGH, RATE, saleEnd, obsStart, obsEnd, redeemEnd, CAP);
        uint256 id = pool.createSeries(LOW, HIGH, RATE, saleEnd, obsStart, obsEnd, redeemEnd, CAP);
        assertEq(id, 0);
        assertEq(pool.seriesCount(), 1);
        CoverPool.Series memory s = pool.series(0);
        assertEq(s.creator, creator);
        assertEq(s.strikeLowCents, LOW);
        assertEq(s.strikeHighCents, HIGH);
        assertEq(s.premiumRateBps, RATE);
        assertEq(s.saleEnd, saleEnd);
        assertEq(s.obsStart, obsStart);
        assertEq(s.obsEnd, obsEnd);
        assertEq(s.redeemEnd, redeemEnd);
        assertEq(s.escrow, CAP);
        assertEq(s.sold, 0);
        assertEq(s.premiumsAccrued, 0);
        assertEq(s.paidOut, 0);
        assertEq(s.withdrawn, 0);
        assertFalse(s.settled);
        assertFalse(s.cancelled);
        assertFalse(s.residualWithdrawn);
        assertEq(creatorPre - usdc.balanceOf(creator), CAP, "escrow pulled from the creator");
        assertEq(usdc.balanceOf(address(pool)), CAP, "escrow held by the pool");
    }

    function test_createSeries_anyoneCanCreate() public {
        uint256 a = _createAs(creator, CAP);
        uint256 b = _createAs(rival, 2 * CAP);
        uint256 c = _createAs(alice, uint128(ONE));
        assertEq(pool.seriesCount(), 3);
        assertEq(pool.series(a).creator, creator);
        assertEq(pool.series(b).creator, rival);
        assertEq(pool.series(c).creator, alice);
        assertEq(usdc.balanceOf(address(pool)), 3 * uint256(CAP) + ONE);
    }

    function test_createSeries_validations() public {
        vm.startPrank(creator);
        vm.expectRevert(abi.encodeWithSelector(CoverPool.InvalidParams.selector, "strikes"));
        pool.createSeries(HIGH, HIGH, RATE, saleEnd, obsStart, obsEnd, redeemEnd, CAP);
        vm.expectRevert(abi.encodeWithSelector(CoverPool.InvalidParams.selector, "strikes"));
        pool.createSeries(0, HIGH, RATE, saleEnd, obsStart, obsEnd, redeemEnd, CAP);
        vm.expectRevert(abi.encodeWithSelector(CoverPool.InvalidParams.selector, "premiumRate"));
        pool.createSeries(LOW, HIGH, 10_001, saleEnd, obsStart, obsEnd, redeemEnd, CAP);
        // saleEnd must be strictly in the future
        vm.expectRevert(abi.encodeWithSelector(CoverPool.InvalidParams.selector, "saleEnd"));
        pool.createSeries(LOW, HIGH, RATE, T0, obsStart, obsEnd, redeemEnd, CAP);
        vm.expectRevert(abi.encodeWithSelector(CoverPool.InvalidParams.selector, "saleEnd"));
        pool.createSeries(LOW, HIGH, RATE, T0 - 1, obsStart, obsEnd, redeemEnd, CAP);
        // the informed-trading rule saleEnd ≤ obsStart is enforced on-chain
        vm.expectRevert(abi.encodeWithSelector(CoverPool.InvalidParams.selector, "windows"));
        pool.createSeries(LOW, HIGH, RATE, obsStart + 1, obsStart, obsEnd, redeemEnd, CAP);
        vm.expectRevert(abi.encodeWithSelector(CoverPool.InvalidParams.selector, "windows"));
        pool.createSeries(LOW, HIGH, RATE, saleEnd, obsEnd, obsEnd, redeemEnd, CAP);
        vm.expectRevert(abi.encodeWithSelector(CoverPool.InvalidParams.selector, "windows"));
        pool.createSeries(LOW, HIGH, RATE, saleEnd, obsStart, obsEnd, obsEnd, CAP);
        // the claim window has an on-chain floor: redeemEnd ≥ obsEnd + MIN_REDEEM_WINDOW
        vm.expectRevert(abi.encodeWithSelector(CoverPool.InvalidParams.selector, "claimWindow"));
        pool.createSeries(LOW, HIGH, RATE, saleEnd, obsStart, obsEnd, obsEnd + 1, CAP);
        vm.expectRevert(abi.encodeWithSelector(CoverPool.InvalidParams.selector, "claimWindow"));
        pool.createSeries(LOW, HIGH, RATE, saleEnd, obsStart, obsEnd, obsEnd + 7 days - 1, CAP);
        vm.expectRevert(abi.encodeWithSelector(CoverPool.InvalidParams.selector, "capacity"));
        pool.createSeries(LOW, HIGH, RATE, saleEnd, obsStart, obsEnd, redeemEnd, 0);
        vm.stopPrank();
        assertEq(pool.seriesCount(), 0, "nothing appended");
        // premiumRateBps == 1e4 is the inclusive bound
        vm.prank(creator);
        pool.createSeries(LOW, HIGH, 10_000, saleEnd, obsStart, obsEnd, redeemEnd, CAP);
        assertEq(pool.series(0).premiumRateBps, 10_000);
        // redeemEnd == obsEnd + MIN_REDEEM_WINDOW is the inclusive bound
        assertEq(pool.MIN_REDEEM_WINDOW(), 7 days);
        vm.prank(creator);
        uint256 minWindowId = pool.createSeries(LOW, HIGH, RATE, saleEnd, obsStart, obsEnd, obsEnd + 7 days, CAP);
        assertEq(pool.series(minWindowId).redeemEnd, obsEnd + 7 days);
    }

    function test_createSeries_withoutAllowance_reverts() public {
        address mallory = makeAddr("mallory");
        usdc.mint(mallory, CAP);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(pool), 0, CAP));
        vm.prank(mallory);
        pool.createSeries(LOW, HIGH, RATE, saleEnd, obsStart, obsEnd, redeemEnd, CAP);
        assertEq(pool.seriesCount(), 0, "nothing appended");
        assertEq(usdc.balanceOf(address(pool)), 0, "nothing pulled");
    }

    function test_createSeries_withoutBalance_reverts() public {
        address pauper = makeAddr("pauper");
        vm.prank(pauper);
        usdc.approve(address(pool), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, pauper, 0, CAP));
        vm.prank(pauper);
        pool.createSeries(LOW, HIGH, RATE, saleEnd, obsStart, obsEnd, redeemEnd, CAP);
        assertEq(pool.seriesCount(), 0, "nothing appended");
    }

    function test_series_unknownIdReverts() public {
        vm.expectRevert(CoverPool.InvalidSeries.selector);
        pool.series(0);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // quote / buy
    // ─────────────────────────────────────────────────────────────────────────

    function test_quote_math() public {
        uint256 id = _createDefault();
        (uint256 premium, uint16 rateBps, uint256 capacityLeft, uint256 issuableNow) = pool.quote(id, ONE);
        assertEq(premium, 0.285e6);
        assertEq(rateBps, RATE);
        assertEq(capacityLeft, CAP);
        assertEq(issuableNow, CAP, "1:1 escrow backing: the whole remaining capacity is issuable");
        _buy(alice, id, 40 * ONE);
        (,, capacityLeft, issuableNow) = pool.quote(id, ONE);
        assertEq(capacityLeft, 60 * ONE);
        assertEq(issuableNow, 60 * ONE);
    }

    function test_quote_issuableNowZeroWhenClosed() public {
        // paused
        uint256 a = _createDefault();
        vm.prank(creator);
        pool.setSeriesPaused(a, true);
        (,, uint256 capacityLeft, uint256 issuableNow) = pool.quote(a, ONE);
        assertEq(capacityLeft, CAP, "capacity is still reported");
        assertEq(issuableNow, 0, "paused series issues nothing");
        // settled
        uint256 b = _createDefault();
        _settleAt(b, obsStart, 9000);
        (,,, issuableNow) = pool.quote(b, ONE);
        assertEq(issuableNow, 0, "settled series issues nothing");
        // cancelled: no phantom capacity either — the refund zeroed the escrow
        uint256 c = _createDefault();
        vm.prank(creator);
        pool.cancelSeries(c);
        (,, capacityLeft, issuableNow) = pool.quote(c, ONE);
        assertEq(capacityLeft, 0, "cancelled series reports no escrow-backed capacity");
        assertEq(issuableNow, 0, "cancelled series issues nothing");
        // past saleEnd
        uint256 d = _createDefault();
        vm.warp(saleEnd + 1);
        (,,, issuableNow) = pool.quote(d, ONE);
        assertEq(issuableNow, 0, "closed sale issues nothing");
    }

    function test_buy_mintsAndPullsPremium() public {
        uint256 id = _createDefault();
        uint256 premium = _buy(alice, id, ONE);
        assertEq(premium, 0.285e6);
        assertEq(token.balanceOf(alice, id), ONE);
        assertEq(usdc.balanceOf(address(pool)), CAP + premium);
        CoverPool.Series memory s = pool.series(id);
        assertEq(s.sold, ONE);
        assertEq(s.premiumsAccrued, premium, "premium accrues to the series bucket");
    }

    function test_buy_slippageGuard() public {
        uint256 id = _createDefault();
        vm.expectRevert(abi.encodeWithSelector(CoverPool.PremiumTooHigh.selector, 0.285e6, 0.284e6));
        vm.prank(alice);
        pool.buyProtection(id, ONE, 0.284e6);
    }

    function test_buy_capacityExceeded() public {
        uint256 id = _createDefault();
        vm.expectRevert(CoverPool.CapacityExceeded.selector);
        vm.prank(alice);
        pool.buyProtection(id, uint256(CAP) + 1, type(uint256).max);
        // the full escrow is sellable, and then nothing more
        _buy(alice, id, CAP);
        vm.expectRevert(CoverPool.CapacityExceeded.selector);
        vm.prank(bob);
        pool.buyProtection(id, 4, type(uint256).max);
    }

    function test_buy_afterSaleEnd_reverts() public {
        uint256 id = _createDefault();
        vm.warp(saleEnd + 1);
        vm.expectRevert(CoverPool.SaleClosed.selector);
        vm.prank(alice);
        pool.buyProtection(id, ONE, type(uint256).max);
    }

    function test_buy_atSaleEnd_ok() public {
        uint256 id = _createDefault();
        vm.warp(saleEnd);
        _buy(alice, id, ONE);
    }

    function test_buy_afterSettle_reverts() public {
        uint256 id = _createDefault();
        _settleAt(id, obsStart, 9000);
        vm.expectRevert(CoverPool.SaleClosed.selector);
        vm.prank(alice);
        pool.buyProtection(id, ONE, type(uint256).max);
    }

    function test_buy_afterCancel_reverts() public {
        uint256 id = _createDefault();
        vm.prank(creator);
        pool.cancelSeries(id);
        vm.expectRevert(CoverPool.SeriesClosed.selector);
        vm.prank(alice);
        pool.buyProtection(id, ONE, type(uint256).max);
    }

    function test_buy_zeroAmount_reverts() public {
        uint256 id = _createDefault();
        vm.expectRevert(CoverPool.ZeroAmount.selector);
        vm.prank(alice);
        pool.buyProtection(id, 0, 0);
    }

    function test_buy_premiumRoundsToZero_reverts() public {
        uint256 id = _createDefault();
        // at 2850 bps, any maxClaim ≤ 3 micro-units computes premium 0 → no free cover
        for (uint256 dust = 1; dust <= 3; ++dust) {
            vm.expectRevert(CoverPool.PremiumRoundsToZero.selector);
            vm.prank(alice);
            pool.buyProtection(id, dust, type(uint256).max);
            vm.expectRevert(CoverPool.PremiumRoundsToZero.selector);
            vm.prank(alice);
            pool.buyProtectionFor(id, dust, type(uint256).max, bob);
        }
        // the smallest claim whose premium is ≥ 1 wei still buys
        vm.prank(alice);
        pool.buyProtection(id, 4, type(uint256).max);
        assertEq(token.balanceOf(alice, id), 4);
    }

    function test_buy_zeroRateSeries_isFree() public {
        vm.prank(creator);
        uint256 id = pool.createSeries(LOW, HIGH, 0, saleEnd, obsStart, obsEnd, redeemEnd, CAP);
        uint256 alicePre = usdc.balanceOf(alice);
        vm.prank(alice);
        pool.buyProtection(id, ONE, 0); // zero-rate: the dust guard does not apply
        assertEq(token.balanceOf(alice, id), ONE);
        assertEq(usdc.balanceOf(alice), alicePre, "no premium pulled");
        assertEq(pool.series(id).premiumsAccrued, 0);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // settle: window edges + clamp edges
    // ─────────────────────────────────────────────────────────────────────────

    function test_settle_windowEdges() public {
        // t == obsStart qualifies
        uint256 id = _createDefault();
        _settleAt(id, obsStart, 9000);
        assertTrue(pool.series(id).settled);

        // t == obsEnd qualifies
        uint256 id2 = _createDefault();
        _settleAt(id2, obsEnd, 9000);
        assertTrue(pool.series(id2).settled);

        // t == obsStart - 1 and obsEnd + 1 do not
        uint256 id3 = _createDefault();
        uint256 before = oracle.push(obsStart - 1, 9000, bytes32("early"));
        vm.expectRevert(abi.encodeWithSelector(CoverPool.ObservationOutOfWindow.selector, obsStart - 1));
        pool.settle(id3, before);
        uint256 late = oracle.push(obsEnd + 1, 9000, bytes32("late"));
        vm.expectRevert(abi.encodeWithSelector(CoverPool.ObservationOutOfWindow.selector, obsEnd + 1));
        pool.settle(id3, late);
    }

    function test_settle_clampEdges() public {
        // cents == low → 0
        uint256 a = _createDefault();
        _settleAt(a, obsStart, LOW);
        assertEq(pool.series(a).payoutRatioWad, 0);
        // cents just below low → 0
        uint256 b = _createDefault();
        _settleAt(b, obsStart, LOW - 1);
        assertEq(pool.series(b).payoutRatioWad, 0);
        // cents == high → 1e18
        uint256 c = _createDefault();
        _settleAt(c, obsStart, HIGH);
        assertEq(pool.series(c).payoutRatioWad, 1e18);
        // cents above high → 1e18
        uint256 d = _createDefault();
        _settleAt(d, obsStart, HIGH + 500);
        assertEq(pool.series(d).payoutRatioWad, 1e18);
        // midpoint: (9288-8800)/(9600-8800) = 61%
        uint256 e = _createDefault();
        _settleAt(e, obsStart, 9288);
        assertEq(pool.series(e).payoutRatioWad, 0.61e18);
        // one cent above low: 1/800 of 1e18
        uint256 f = _createDefault();
        _settleAt(f, obsStart, LOW + 1);
        assertEq(pool.series(f).payoutRatioWad, uint256(1e18) / 800);
    }

    function test_settle_onceOnly_firstWins() public {
        uint256 id = _createDefault();
        _settleAt(id, obsStart, 9288);
        uint256 second = oracle.push(obsStart + 1, HIGH, bytes32("later"));
        vm.expectRevert(CoverPool.AlreadySettled.selector);
        pool.settle(id, second);
        assertEq(pool.series(id).payoutRatioWad, 0.61e18, "first observation stays");
    }

    function test_settle_storesProvenance() public {
        uint256 id = _createDefault();
        uint256 obsIndex = oracle.push(obsStart + 5, 9288, bytes32("prov"));
        pool.settle(id, obsIndex);
        CoverPool.Series memory s = pool.series(id);
        assertEq(s.observationT, obsStart + 5);
        assertEq(s.emailId, bytes32("prov"));
    }

    function test_settle_unknownSeries_reverts() public {
        vm.expectRevert(CoverPool.InvalidSeries.selector);
        pool.settle(7, 0);
    }

    function test_settle_cancelledSeries_reverts() public {
        uint256 id = _createDefault();
        vm.prank(creator);
        pool.cancelSeries(id);
        uint256 obsIndex = oracle.push(obsStart, 9288, bytes32("dead"));
        vm.expectRevert(CoverPool.SeriesClosed.selector);
        pool.settle(id, obsIndex);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // redeem
    // ─────────────────────────────────────────────────────────────────────────

    function test_redeem_beforeSettle_reverts() public {
        uint256 id = _createDefault();
        _buy(alice, id, ONE);
        vm.expectRevert(CoverPool.NotSettled.selector);
        vm.prank(alice);
        pool.redeem(id, ONE);
    }

    function test_redeem_paysRatio_andPartials() public {
        uint256 id = _createDefault();
        _buy(alice, id, 2 * ONE);
        _settleAt(id, obsStart, 9288); // 61%
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        pool.redeem(id, ONE);
        assertEq(usdc.balanceOf(alice) - before, 0.61e6);
        assertEq(token.balanceOf(alice, id), ONE);
        vm.prank(alice);
        pool.redeem(id, ONE);
        assertEq(usdc.balanceOf(alice) - before, 1.22e6);
        assertEq(token.balanceOf(alice, id), 0);
        assertEq(pool.series(id).paidOut, 1.22e6);
    }

    function test_redeem_zeroRatio_burnsForNothing() public {
        uint256 id = _createDefault();
        _buy(alice, id, ONE);
        _settleAt(id, obsStart, LOW); // ratio 0
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        pool.redeem(id, ONE);
        assertEq(usdc.balanceOf(alice), before);
        assertEq(token.balanceOf(alice, id), 0);
        assertEq(pool.series(id).paidOut, 0);
    }

    function test_redeem_afterRedeemEnd_reverts() public {
        uint256 id = _createDefault();
        _buy(alice, id, ONE);
        _settleAt(id, obsStart, 9288);
        vm.warp(redeemEnd + 1);
        vm.expectRevert(CoverPool.RedeemWindowClosed.selector);
        vm.prank(alice);
        pool.redeem(id, ONE);
    }

    function test_redeem_atRedeemEnd_ok() public {
        uint256 id = _createDefault();
        _buy(alice, id, ONE);
        _settleAt(id, obsStart, 9288);
        vm.warp(redeemEnd);
        vm.prank(alice);
        pool.redeem(id, ONE);
    }

    function test_redeem_neverBlockedByPause() public {
        uint256 id = _createDefault();
        _buy(alice, id, ONE);
        _settleAt(id, obsStart, 9288);
        vm.prank(creator);
        pool.setSeriesPaused(id, true);
        vm.prank(alice);
        pool.redeem(id, ONE); // must not revert
    }

    function test_redeem_moreThanBalance_reverts() public {
        uint256 id = _createDefault();
        _buy(alice, id, ONE);
        _settleAt(id, obsStart, 9288);
        vm.expectRevert(); // ERC1155InsufficientBalance from the token burn
        vm.prank(alice);
        pool.redeem(id, 2 * ONE);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // addCapacity
    // ─────────────────────────────────────────────────────────────────────────

    function test_addCapacity_growsEscrowAndSellsBeyondOriginalCap() public {
        uint256 id = _createDefault();
        _buy(alice, id, CAP); // the original escrow is fully sold
        vm.prank(creator);
        vm.expectEmit(true, true, true, true);
        emit CoverPool.CapacityAdded(id, creator, 10 * ONE, CAP + 10 * ONE);
        pool.addCapacity(id, uint128(10 * ONE));
        assertEq(pool.series(id).escrow, CAP + 10 * ONE);
        assertEq(usdc.balanceOf(address(pool)), CAP + 10 * ONE + (uint256(CAP) * RATE) / 1e4);
        _buy(bob, id, 10 * ONE); // the top-up is sellable
        assertEq(pool.series(id).sold, CAP + 10 * ONE);
    }

    function test_addCapacity_afterEarlySettle_reverts() public {
        // early-settlement edge: with saleEnd == obsStart, the oracle's +1 day
        // future-t tolerance lets a qualifying observation settle the series while
        // the sale is still open. Sales are then shut forever, so a top-up could
        // never be sold — the pool refuses the dead escrow instead of stranding it.
        uint256 id = _createDefault();
        _settleAt(id, obsStart, 9288); // block.timestamp == T0 ≤ saleEnd: sale still open
        assertTrue(block.timestamp <= pool.series(id).saleEnd, "settled during the sale");
        vm.expectRevert(CoverPool.AlreadySettled.selector);
        vm.prank(creator);
        pool.addCapacity(id, uint128(ONE));
    }

    function test_addCapacity_afterSaleEnd_reverts() public {
        uint256 id = _createDefault();
        vm.warp(saleEnd); // at saleEnd still allowed
        vm.prank(creator);
        pool.addCapacity(id, uint128(ONE));
        vm.warp(saleEnd + 1);
        vm.expectRevert(CoverPool.SaleClosed.selector);
        vm.prank(creator);
        pool.addCapacity(id, uint128(ONE));
    }

    function test_addCapacity_onlyCreator() public {
        uint256 id = _createDefault();
        vm.expectRevert(CoverPool.NotCreator.selector);
        pool.addCapacity(id, uint128(ONE));
        vm.expectRevert(CoverPool.NotCreator.selector);
        vm.prank(rival);
        pool.addCapacity(id, uint128(ONE));
    }

    function test_addCapacity_zeroOrCancelled_reverts() public {
        uint256 id = _createDefault();
        vm.expectRevert(CoverPool.ZeroAmount.selector);
        vm.prank(creator);
        pool.addCapacity(id, 0);
        vm.prank(creator);
        pool.cancelSeries(id);
        vm.expectRevert(CoverPool.SeriesClosed.selector);
        vm.prank(creator);
        pool.addCapacity(id, uint128(ONE));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // cancelSeries
    // ─────────────────────────────────────────────────────────────────────────

    function test_cancel_unsold_refundsFullEscrow() public {
        uint256 id = _createDefault();
        uint256 creatorPre = usdc.balanceOf(creator);
        vm.prank(creator);
        vm.expectEmit(true, true, true, true);
        emit CoverPool.SeriesCancelled(id, creator, CAP);
        pool.cancelSeries(id);
        assertEq(usdc.balanceOf(creator) - creatorPre, CAP, "full escrow refunded");
        assertEq(usdc.balanceOf(address(pool)), 0);
        CoverPool.Series memory s = pool.series(id);
        assertTrue(s.cancelled);
        assertTrue(s.residualWithdrawn, "cancel consumes the one-shot exit latch");
        assertEq(s.escrow, 0, "refund zeroes the escrow: the series backs nothing");
        assertEq(s.withdrawn, 0, "the cancel refund is booked by zeroing escrow, not via withdrawn");
    }

    function test_cancel_onlyCreator() public {
        uint256 id = _createDefault();
        vm.expectRevert(CoverPool.NotCreator.selector);
        pool.cancelSeries(id);
        vm.expectRevert(CoverPool.NotCreator.selector);
        vm.prank(rival);
        pool.cancelSeries(id);
    }

    function test_cancel_matrix_soldSettledOrCancelled() public {
        // sold > 0: no cancel, even for the creator
        uint256 a = _createDefault();
        _buy(alice, a, ONE);
        vm.expectRevert(CoverPool.AlreadySold.selector);
        vm.prank(creator);
        pool.cancelSeries(a);
        // settled: no cancel
        uint256 b = _createDefault();
        _settleAt(b, obsStart, 9288);
        vm.expectRevert(CoverPool.AlreadySettled.selector);
        vm.prank(creator);
        pool.cancelSeries(b);
        // already cancelled: no double refund
        uint256 c = _createDefault();
        vm.startPrank(creator);
        pool.cancelSeries(c);
        vm.expectRevert(CoverPool.SeriesClosed.selector);
        pool.cancelSeries(c);
        vm.stopPrank();
    }

    function test_cancel_unsoldAfterSaleEnd_stillWorks() public {
        uint256 id = _createDefault();
        vm.warp(redeemEnd + 1); // nothing was ever sold; the creator recovers late
        uint256 creatorPre = usdc.balanceOf(creator);
        vm.prank(creator);
        pool.cancelSeries(id);
        assertEq(usdc.balanceOf(creator) - creatorPre, CAP);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // withdrawResidual
    // ─────────────────────────────────────────────────────────────────────────

    function test_withdrawResidual_beforeRedeemEnd_reverts() public {
        uint256 id = _createDefault();
        vm.expectRevert(CoverPool.RedeemWindowOpen.selector);
        vm.prank(creator);
        pool.withdrawResidual(id);
        vm.warp(redeemEnd); // still open AT redeemEnd (redeem is allowed there)
        vm.expectRevert(CoverPool.RedeemWindowOpen.selector);
        vm.prank(creator);
        pool.withdrawResidual(id);
    }

    function test_withdrawResidual_onlyCreator() public {
        uint256 id = _createDefault();
        vm.warp(redeemEnd + 1);
        vm.expectRevert(CoverPool.NotCreator.selector);
        pool.withdrawResidual(id);
        vm.expectRevert(CoverPool.NotCreator.selector);
        vm.prank(rival);
        pool.withdrawResidual(id);
    }

    function test_withdrawResidual_unsettledSeries_returnsEscrowAndPremiums() public {
        // UNSETTLED FALLBACK: no qualifying observation ever lands — holders can never
        // redeem, and after redeemEnd the whole escrow + premiums release to the creator.
        uint256 id = _createDefault();
        uint256 premium = _buy(alice, id, 4 * ONE);
        vm.warp(redeemEnd + 1);
        vm.expectRevert(CoverPool.NotSettled.selector); // the claim units are worthless
        vm.prank(alice);
        pool.redeem(id, ONE);
        uint256 creatorPre = usdc.balanceOf(creator);
        vm.prank(creator);
        vm.expectEmit(true, true, true, true);
        emit CoverPool.ResidualWithdrawn(id, creator, CAP + premium);
        pool.withdrawResidual(id);
        assertEq(usdc.balanceOf(creator) - creatorPre, CAP + premium);
        assertEq(usdc.balanceOf(address(pool)), 0, "series bucket fully drained");
    }

    function test_withdrawResidual_exactAmounts_unredeemedClaimsRelease() public {
        uint256 id = _createDefault();
        uint256 premium = _buy(alice, id, 4 * ONE); // 1.14
        _settleAt(id, obsStart, 9288); // 61%
        vm.prank(alice);
        pool.redeem(id, ONE); // 0.61 paid; 3 claim units never redeemed
        vm.warp(redeemEnd + 1);
        uint256 creatorPre = usdc.balanceOf(creator);
        vm.prank(creator);
        pool.withdrawResidual(id);
        // escrow + premiums − paidOut: the 3 unredeemed units' 1.83 stays with the creator
        assertEq(usdc.balanceOf(creator) - creatorPre, CAP + premium - 0.61e6);
        assertEq(usdc.balanceOf(address(pool)), 0);
        assertEq(pool.series(id).withdrawn, CAP + premium - 0.61e6);
    }

    function test_withdrawResidual_oneShot() public {
        uint256 id = _createDefault();
        vm.warp(redeemEnd + 1);
        vm.startPrank(creator);
        pool.withdrawResidual(id);
        vm.expectRevert(CoverPool.ResidualAlreadyWithdrawn.selector);
        pool.withdrawResidual(id);
        vm.stopPrank();
    }

    function test_withdrawResidual_afterCancel_reverts() public {
        uint256 id = _createDefault();
        vm.prank(creator);
        pool.cancelSeries(id); // the refund consumed the one-shot residual
        vm.warp(redeemEnd + 1);
        vm.expectRevert(CoverPool.SeriesClosed.selector);
        vm.prank(creator);
        pool.withdrawResidual(id);
    }

    /// @dev REGRESSION (double-drain): the two creator exits are strictly mutually
    ///      exclusive in BOTH orders. An unsold, unsettled series past `redeemEnd`
    ///      takes its residual once; the follow-up cancel MUST revert instead of
    ///      paying the escrow a second time out of a sibling creator's bucket.
    function test_withdrawResidualThenCancel_reverts_siblingEscrowUntouched() public {
        uint256 victimId = _createAs(rival, CAP); // the sibling escrow that must survive
        uint256 id = _createDefault(); // unsold, unsettled
        uint256 id2 = _createAs(rival, CAP); // exercised in the reverse order below
        vm.prank(rival);
        pool.cancelSeries(id2); // refund taken while unsold — books already closed
        vm.warp(redeemEnd + 1);

        uint256 creatorPre = usdc.balanceOf(creator);
        vm.startPrank(creator);
        pool.withdrawResidual(id); // pays escrow + premiums (= CAP) exactly once
        vm.expectRevert(CoverPool.ResidualAlreadyWithdrawn.selector);
        pool.cancelSeries(id); // the second exit MUST NOT pay again
        vm.stopPrank();
        assertEq(usdc.balanceOf(creator) - creatorPre, CAP, "creator paid exactly once");

        // conservation invariant: Σ (escrow + premiums − paidOut − withdrawn) == balance
        uint256 total;
        for (uint256 i = 0; i < pool.seriesCount(); ++i) {
            CoverPool.Series memory s = pool.series(i);
            total += uint256(s.escrow) + s.premiumsAccrued - s.paidOut - s.withdrawn;
        }
        assertEq(usdc.balanceOf(address(pool)), total, "conservation holds across the blocked double exit");

        // the second creator's escrow is untouched and still fully backs its series
        assertEq(pool.series(victimId).escrow, CAP, "sibling escrow intact");
        assertEq(usdc.balanceOf(address(pool)), CAP, "pool still holds exactly the sibling's bucket");

        // and the reverse order stays blocked too (see test_withdrawResidual_afterCancel_reverts)
        vm.expectRevert(CoverPool.SeriesClosed.selector);
        vm.prank(rival);
        pool.withdrawResidual(id2);
    }

    function test_lateSettle_afterRedeemEnd_doesNotReopenRedemption() public {
        // settle has no deadline, but a late settlement cannot reopen redemption or
        // shrink the residual — the pre-B fallback semantics, preserved.
        uint256 id = _createDefault();
        uint256 premium = _buy(alice, id, 4 * ONE);
        vm.warp(redeemEnd + 1);
        _settleAt(id, obsEnd, HIGH); // ratio 1e18, but the window is shut
        vm.expectRevert(CoverPool.RedeemWindowClosed.selector);
        vm.prank(alice);
        pool.redeem(id, ONE);
        uint256 creatorPre = usdc.balanceOf(creator);
        vm.prank(creator);
        pool.withdrawResidual(id);
        assertEq(usdc.balanceOf(creator) - creatorPre, CAP + premium);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Multi-creator isolation
    // ─────────────────────────────────────────────────────────────────────────

    function test_multiCreator_isolation_fullDrainNeverTouchesSibling() public {
        // interleaved: A creates, alice maxes A out, B creates, bob buys some of B
        uint128 capA = uint128(10 * ONE);
        uint128 capB = uint128(20 * ONE);
        uint256 a = _createAs(creator, capA);
        uint256 premiumA = _buy(alice, a, capA); // A's escrow fully sold
        uint256 b = _createAs(rival, capB);
        uint256 premiumB = _buy(bob, b, 5 * ONE);

        // A settles at full payout: alice's claims consume A's ENTIRE escrow
        _settleAt(a, obsStart, HIGH); // ratio 1e18
        vm.prank(alice);
        pool.redeem(a, capA);
        assertEq(pool.series(a).paidOut, capA);

        // B's bucket is untouched: escrow + premiums all still in the pool
        assertEq(usdc.balanceOf(address(pool)), premiumA + capB + premiumB, "B's bucket intact after A drained");

        // B settles worthless; bob's redemption pays zero out of B
        uint256 obsB = oracle.push(obsStart + 1, LOW, bytes32("b-zero"));
        pool.settle(b, obsB);
        vm.prank(bob);
        pool.redeem(b, 5 * ONE);

        // residuals: each creator gets exactly their own bucket, nothing more
        vm.warp(redeemEnd + 1);
        uint256 aPre = usdc.balanceOf(creator);
        uint256 bPre = usdc.balanceOf(rival);
        vm.prank(creator);
        pool.withdrawResidual(a);
        vm.prank(rival);
        pool.withdrawResidual(b);
        assertEq(usdc.balanceOf(creator) - aPre, premiumA, "A: escrow fully claimed, premiums only");
        assertEq(usdc.balanceOf(rival) - bPre, capB + premiumB, "B: full escrow + premiums back");
        assertEq(usdc.balanceOf(address(pool)), 0, "conservation: both buckets sum to the pool");
    }

    function test_multiCreator_leversAreCreatorScoped() public {
        uint256 a = _createAs(creator, CAP);
        uint256 b = _createAs(rival, CAP);
        vm.startPrank(creator);
        vm.expectRevert(CoverPool.NotCreator.selector);
        pool.setSeriesPaused(b, true);
        vm.expectRevert(CoverPool.NotCreator.selector);
        pool.addCapacity(b, uint128(ONE));
        vm.expectRevert(CoverPool.NotCreator.selector);
        pool.cancelSeries(b);
        vm.stopPrank();
        vm.startPrank(rival);
        vm.expectRevert(CoverPool.NotCreator.selector);
        pool.setSeriesPaused(a, true);
        vm.expectRevert(CoverPool.NotCreator.selector);
        pool.cancelSeries(a);
        vm.warp(redeemEnd + 1);
        vm.expectRevert(CoverPool.NotCreator.selector);
        pool.withdrawResidual(a);
        vm.stopPrank();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CoverToken rules
    // ─────────────────────────────────────────────────────────────────────────

    function test_token_transfersDisabled() public {
        uint256 id = _createDefault();
        _buy(alice, id, ONE);
        vm.prank(alice);
        vm.expectRevert(CoverToken.TransfersDisabled.selector);
        token.safeTransferFrom(alice, bob, id, ONE, "");
        uint256[] memory ids = new uint256[](1);
        uint256[] memory amts = new uint256[](1);
        ids[0] = id;
        amts[0] = ONE;
        vm.prank(alice);
        vm.expectRevert(CoverToken.TransfersDisabled.selector);
        token.safeBatchTransferFrom(alice, bob, ids, amts, "");
    }

    function test_token_mintBurnOnlyPool() public {
        vm.expectRevert(CoverToken.OnlyPool.selector);
        token.mint(alice, 0, 1);
        vm.expectRevert(CoverToken.OnlyPool.selector);
        token.burn(alice, 0, 1);
    }

    function test_token_uriIsDataJson() public view {
        string memory uri = token.uri(3);
        assertEq(bytes(uri).length > 40, true);
        // starts with the data:application/json;base64, scheme
        bytes memory prefix = "data:application/json;base64,";
        bytes memory u = bytes(uri);
        for (uint256 i = 0; i < prefix.length; ++i) {
            assertEq(u[i], prefix[i]);
        }
    }

    function test_token_uriEchoesCurrencyDecimals() public view {
        assertEq(token.currencyDecimals(), 6);
        bytes memory json = abi.encodePacked(
            unicode'{"name":"NY Rent Cover — Series #3',
            '","description":"Fully collateralized Manhattan office rent protection.',
            ' 1 unit = 1 currency-wei of max claim.","decimals":6}'
        );
        assertEq(token.uri(3), string(abi.encodePacked("data:application/json;base64,", Base64.encode(json))));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // buyProtectionFor (recipient minting; cover stays soulbound)
    // ─────────────────────────────────────────────────────────────────────────

    function test_buyFor_mintsToRecipient_pullsPremiumFromPayer() public {
        uint256 id = _createDefault();
        uint256 premium = (ONE * RATE) / 1e4;
        uint256 alicePre = usdc.balanceOf(alice);
        uint256 bobPre = usdc.balanceOf(bob);
        vm.prank(alice);
        vm.expectEmit(true, true, true, true);
        emit CoverPool.ProtectionBought(id, alice, bob, ONE, premium);
        pool.buyProtectionFor(id, ONE, premium, bob);
        assertEq(token.balanceOf(bob, id), ONE, "recipient holds the cover");
        assertEq(token.balanceOf(alice, id), 0, "payer holds nothing");
        assertEq(alicePre - usdc.balanceOf(alice), premium, "payer paid the premium");
        assertEq(usdc.balanceOf(bob), bobPre, "recipient paid nothing");
        assertEq(pool.series(id).sold, ONE);
    }

    function test_buyFor_zeroRecipient_reverts() public {
        uint256 id = _createDefault();
        vm.expectRevert(CoverPool.ZeroAddress.selector);
        vm.prank(alice);
        pool.buyProtectionFor(id, ONE, type(uint256).max, address(0));
    }

    function test_buyFor_recipientRedeems_payerCannot() public {
        uint256 id = _createDefault();
        vm.prank(alice);
        pool.buyProtectionFor(id, ONE, type(uint256).max, bob);
        _settleAt(id, obsStart, 9288); // 61%
        vm.expectRevert(); // ERC1155InsufficientBalance: the payer holds no claim units
        vm.prank(alice);
        pool.redeem(id, ONE);
        uint256 before = usdc.balanceOf(bob);
        vm.prank(bob);
        pool.redeem(id, ONE);
        assertEq(usdc.balanceOf(bob) - before, 0.61e6);
    }

    function test_buyFor_coverStaysSoulbound() public {
        uint256 id = _createDefault();
        vm.prank(alice);
        pool.buyProtectionFor(id, ONE, type(uint256).max, bob);
        vm.prank(bob);
        vm.expectRevert(CoverToken.TransfersDisabled.selector);
        token.safeTransferFrom(bob, alice, id, ONE, "");
    }

    function test_buyFor_nonReceiverContract_reverts_fundsUntouched() public {
        uint256 id = _createDefault();
        NonReceiver stranded = new NonReceiver();
        uint256 alicePre = usdc.balanceOf(alice);
        uint256 poolPre = usdc.balanceOf(address(pool));
        vm.expectRevert(abi.encodeWithSelector(IERC1155Errors.ERC1155InvalidReceiver.selector, address(stranded)));
        vm.prank(alice);
        pool.buyProtectionFor(id, ONE, type(uint256).max, address(stranded));
        assertEq(usdc.balanceOf(alice), alicePre, "premium returned");
        assertEq(usdc.balanceOf(address(pool)), poolPre, "pool balance untouched");
        assertEq(pool.series(id).sold, 0, "nothing sold");
        assertEq(token.balanceOf(address(stranded), id), 0, "nothing minted");
    }

    function test_buyFor_acceptingContractRecipient_ok() public {
        uint256 id = _createDefault();
        AcceptingRecipient holder = new AcceptingRecipient();
        vm.prank(alice);
        pool.buyProtectionFor(id, ONE, type(uint256).max, address(holder));
        assertEq(token.balanceOf(address(holder), id), ONE);
    }

    function test_buyFor_reentrancyBlocked() public {
        uint256 id = _createDefault();
        ReentrantRecipient attacker = new ReentrantRecipient(pool, usdc);
        usdc.mint(address(attacker), 5 * ONE);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        attacker.attack(id, ONE, 0);
    }

    function test_buyFor_reentrancyBlocked_viaWrapper() public {
        uint256 id = _createDefault();
        ReentrantRecipient attacker = new ReentrantRecipient(pool, usdc);
        usdc.mint(address(attacker), 5 * ONE);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        attacker.attack(id, ONE, 1);
    }

    function test_settle_reentrancyBlocked_fromMintCallback() public {
        uint256 id = _createDefault();
        // a qualifying observation already exists; settling mid-purchase must still fail
        oracle.push(obsStart, 9288, bytes32("mid-buy"));
        ReentrantRecipient attacker = new ReentrantRecipient(pool, usdc);
        usdc.mint(address(attacker), 5 * ONE);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        attacker.attack(id, ONE, 2);
        assertFalse(pool.series(id).settled, "no settlement happened");
    }

    function test_createSeries_reentrancyBlocked_fromMintCallback() public {
        uint256 id = _createDefault();
        ReentrantRecipient attacker = new ReentrantRecipient(pool, usdc);
        usdc.mint(address(attacker), 5 * ONE);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        attacker.attack(id, ONE, 3);
        assertEq(pool.seriesCount(), 1, "no series appended");
    }

    function test_cancelSeries_reentrancyBlocked_fromMintCallback() public {
        uint256 id = _createDefault();
        ReentrantRecipient attacker = new ReentrantRecipient(pool, usdc);
        usdc.mint(address(attacker), 5 * ONE);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        attacker.attack(id, ONE, 4);
        assertFalse(pool.series(id).cancelled, "no cancel happened");
    }

    function test_withdrawResidual_reentrancyBlocked_fromMintCallback() public {
        uint256 id = _createDefault();
        ReentrantRecipient attacker = new ReentrantRecipient(pool, usdc);
        usdc.mint(address(attacker), 5 * ONE);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        attacker.attack(id, ONE, 5);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Per-series pause (creator-only; no global pause exists)
    // ─────────────────────────────────────────────────────────────────────────

    function test_setSeriesPaused_onlyCreator() public {
        uint256 id = _createDefault();
        vm.expectRevert(CoverPool.NotCreator.selector);
        pool.setSeriesPaused(id, true);
        vm.expectRevert(CoverPool.NotCreator.selector);
        vm.prank(alice);
        pool.setSeriesPaused(id, true);
    }

    function test_setSeriesPaused_unknownSeries_reverts() public {
        vm.expectRevert(CoverPool.InvalidSeries.selector);
        pool.setSeriesPaused(0, true);
    }

    function test_seriesPause_blocksOnlyThatSeries() public {
        uint256 a = _createDefault();
        uint256 b = _createDefault();
        vm.prank(creator);
        pool.setSeriesPaused(a, true);
        assertTrue(pool.seriesPaused(a));
        assertFalse(pool.seriesPaused(b));
        // paused series rejects both entrypoints
        vm.expectRevert(CoverPool.SalesArePaused.selector);
        vm.prank(alice);
        pool.buyProtection(a, ONE, type(uint256).max);
        vm.expectRevert(CoverPool.SalesArePaused.selector);
        vm.prank(alice);
        pool.buyProtectionFor(a, ONE, type(uint256).max, bob);
        // the sibling series keeps selling
        _buy(alice, b, ONE);
        // unpause reopens the series
        vm.prank(creator);
        pool.setSeriesPaused(a, false);
        _buy(alice, a, ONE);
    }

    function test_seriesPause_crossCreatorMatrix() public {
        uint256 a = _createAs(creator, CAP);
        uint256 b = _createAs(rival, CAP);
        vm.prank(creator);
        pool.setSeriesPaused(a, true);
        // rival's series keeps selling while creator's is paused
        _buy(alice, b, ONE);
        vm.expectRevert(CoverPool.SalesArePaused.selector);
        vm.prank(alice);
        pool.buyProtection(a, ONE, type(uint256).max);
        // and vice versa
        vm.prank(creator);
        pool.setSeriesPaused(a, false);
        vm.prank(rival);
        pool.setSeriesPaused(b, true);
        _buy(alice, a, ONE);
        vm.expectRevert(CoverPool.SalesArePaused.selector);
        vm.prank(alice);
        pool.buyProtection(b, ONE, type(uint256).max);
    }

    function test_seriesPause_neverBlocksSettleOrRedeem() public {
        uint256 id = _createDefault();
        _buy(alice, id, ONE);
        vm.prank(creator);
        pool.setSeriesPaused(id, true);
        _settleAt(id, obsStart, 9288); // settle ignores the pause
        vm.prank(alice);
        pool.redeem(id, ONE); // redeem ignores the pause
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Fuzz
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Payout ratio is the documented clamp for any cents value.
    function testFuzz_settle_ratioClamp(uint32 cents) public {
        uint256 id = _createDefault();
        _settleAt(id, obsStart, cents);
        uint256 ratio = pool.series(id).payoutRatioWad;
        if (cents <= LOW) assertEq(ratio, 0);
        else if (cents >= HIGH) assertEq(ratio, 1e18);
        else assertEq(ratio, (uint256(cents - LOW) * 1e18) / (HIGH - LOW));
    }

    /// @dev Full circle for any single buy: the claim is always payable out of the
    ///      series escrow, and afterwards the creator's residual closes the bucket to
    ///      exactly zero — per-series conservation.
    function testFuzz_buySettleRedeem_fullCircle(uint96 maxClaimRaw, uint32 cents) public {
        uint256 maxClaim = bound(uint256(maxClaimRaw), 1, CAP);
        uint256 id = _createDefault();

        uint256 premium = (maxClaim * RATE) / 1e4;
        vm.prank(alice);
        if (premium == 0) {
            vm.expectRevert(CoverPool.PremiumRoundsToZero.selector);
            pool.buyProtection(id, maxClaim, premium);
            return;
        }
        pool.buyProtection(id, maxClaim, premium);

        _settleAt(id, obsStart, cents);
        uint256 owed = (maxClaim * pool.series(id).payoutRatioWad) / 1e18;
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        pool.redeem(id, maxClaim);
        assertEq(usdc.balanceOf(alice) - before, owed, "full claim paid");

        vm.warp(redeemEnd + 1);
        uint256 creatorPre = usdc.balanceOf(creator);
        vm.prank(creator);
        pool.withdrawResidual(id);
        assertEq(usdc.balanceOf(creator) - creatorPre, CAP + premium - owed, "residual = escrow + premium - payout");
        assertEq(usdc.balanceOf(address(pool)), 0, "bucket closes to zero");
    }

    /// @dev buyProtectionFor: for any recipient-minted purchase, the payer funds the
    ///      premium and the recipient holds exactly the claim.
    function testFuzz_buyFor_payerRecipientSplit(uint96 maxClaimRaw) public {
        uint256 maxClaim = bound(uint256(maxClaimRaw), 1, CAP);
        uint256 id = _createDefault();

        uint256 premium = (maxClaim * RATE) / 1e4;
        uint256 alicePre = usdc.balanceOf(alice);
        vm.prank(alice);
        if (premium == 0) {
            vm.expectRevert(CoverPool.PremiumRoundsToZero.selector);
            pool.buyProtectionFor(id, maxClaim, premium, bob);
            return;
        }
        pool.buyProtectionFor(id, maxClaim, premium, bob);
        assertEq(alicePre - usdc.balanceOf(alice), premium, "payer paid");
        assertEq(token.balanceOf(bob, id), maxClaim, "recipient holds");
        assertEq(token.balanceOf(alice, id), 0);
        assertEq(pool.series(id).premiumsAccrued, premium);
    }

    /// @dev Escrow can never be over-sold, whatever the top-up sequence.
    function testFuzz_addCapacity_soldNeverExceedsEscrow(uint96 topUpRaw, uint96 buyRaw) public {
        uint256 id = _createDefault();
        uint128 topUp = uint128(bound(uint256(topUpRaw), 1, 1_000 * ONE));
        vm.prank(creator);
        pool.addCapacity(id, topUp);
        uint256 escrow = uint256(CAP) + topUp;
        uint256 buyAmt = bound(uint256(buyRaw), 4, escrow + ONE);
        vm.prank(alice);
        if (buyAmt > escrow) {
            vm.expectRevert(CoverPool.CapacityExceeded.selector);
            pool.buyProtection(id, buyAmt, type(uint256).max);
        } else {
            pool.buyProtection(id, buyAmt, type(uint256).max);
            assertLe(pool.series(id).sold, escrow);
        }
    }
}
