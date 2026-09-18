// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CoverPool} from "../src/CoverPool.sol";
import {CoverToken} from "../src/CoverToken.sol";
import {IObservationOracle} from "../src/interfaces/IObservationOracle.sol";
import {MockObservationOracle, TestERC20} from "./utils/Helpers.sol";

/// @notice CoverPool scenario matrix (SPEC §7): create/buy/settle/redeem/withdraw,
///         window and clamp edges, pause semantics, solvency, plus fuzz. Invariants
///         live in {CoverPoolInvariantTest} below.
contract CoverPoolTest is Test {
    uint64 internal constant T0 = 1_789_000_000; // base clock for all series

    uint32 internal constant LOW = 8800;
    uint32 internal constant HIGH = 9600;
    uint16 internal constant RATE = 2850;
    uint128 internal constant CAP = 100 ether;

    uint64 internal saleEnd;
    uint64 internal obsStart;
    uint64 internal obsEnd;
    uint64 internal redeemEnd;

    TestERC20 internal wxdai;
    MockObservationOracle internal oracle;
    CoverToken internal token;
    CoverPool internal pool;

    address internal sponsor = makeAddr("sponsor");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        vm.warp(T0);
        obsStart = T0 - 10 days;
        obsEnd = T0 + 10 days;
        saleEnd = obsEnd;
        redeemEnd = obsEnd + 30 days;

        wxdai = new TestERC20();
        oracle = new MockObservationOracle();

        uint64 nonce = vm.getNonce(address(this));
        address predictedPool = vm.computeCreateAddress(address(this), nonce + 1);
        token = new CoverToken(predictedPool);
        pool = new CoverPool(wxdai, token, IObservationOracle(address(oracle)), sponsor);
        assertEq(address(pool), predictedPool);

        wxdai.mint(sponsor, 1_000 ether);
        wxdai.mint(alice, 1_000 ether);
        wxdai.mint(bob, 1_000 ether);
        vm.prank(sponsor);
        wxdai.approve(address(pool), type(uint256).max);
        vm.prank(alice);
        wxdai.approve(address(pool), type(uint256).max);
        vm.prank(bob);
        wxdai.approve(address(pool), type(uint256).max);
    }

    function _createDefault() internal returns (uint256 id) {
        vm.prank(sponsor);
        id = pool.createSeries(LOW, HIGH, RATE, saleEnd, obsStart, obsEnd, redeemEnd, CAP);
    }

    function _fund(uint256 amt) internal {
        vm.prank(sponsor);
        pool.fundPool(amt);
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
    // createSeries
    // ─────────────────────────────────────────────────────────────────────────

    function test_createSeries_storesParams() public {
        uint256 id = _createDefault();
        assertEq(id, 0);
        assertEq(pool.seriesCount(), 1);
        CoverPool.Series memory s = pool.series(0);
        assertEq(s.strikeLowCents, LOW);
        assertEq(s.strikeHighCents, HIGH);
        assertEq(s.premiumRateBps, RATE);
        assertEq(s.saleEnd, saleEnd);
        assertEq(s.obsStart, obsStart);
        assertEq(s.obsEnd, obsEnd);
        assertEq(s.redeemEnd, redeemEnd);
        assertEq(s.capacity, CAP);
        assertEq(s.sold, 0);
        assertFalse(s.settled);
    }

    function test_createSeries_onlySponsor() public {
        vm.expectRevert(CoverPool.NotSponsor.selector);
        pool.createSeries(LOW, HIGH, RATE, saleEnd, obsStart, obsEnd, redeemEnd, CAP);
    }

    function test_createSeries_validations() public {
        vm.startPrank(sponsor);
        vm.expectRevert(abi.encodeWithSelector(CoverPool.InvalidParams.selector, "strikes"));
        pool.createSeries(HIGH, HIGH, RATE, saleEnd, obsStart, obsEnd, redeemEnd, CAP);
        vm.expectRevert(abi.encodeWithSelector(CoverPool.InvalidParams.selector, "saleEnd"));
        pool.createSeries(LOW, HIGH, RATE, obsEnd + 1, obsStart, obsEnd, redeemEnd, CAP);
        vm.expectRevert(abi.encodeWithSelector(CoverPool.InvalidParams.selector, "windows"));
        pool.createSeries(LOW, HIGH, RATE, saleEnd, obsEnd, obsEnd, redeemEnd, CAP);
        vm.expectRevert(abi.encodeWithSelector(CoverPool.InvalidParams.selector, "windows"));
        pool.createSeries(LOW, HIGH, RATE, obsStart, obsStart, obsEnd, obsEnd, CAP);
        vm.expectRevert(abi.encodeWithSelector(CoverPool.InvalidParams.selector, "capacity"));
        pool.createSeries(LOW, HIGH, RATE, saleEnd, obsStart, obsEnd, redeemEnd, 0);
        vm.stopPrank();
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
        _fund(10 ether);
        (uint256 premium, uint16 rateBps, uint256 capacityLeft, uint256 issuableNow) = pool.quote(id, 1 ether);
        assertEq(premium, 0.285 ether);
        assertEq(rateBps, RATE);
        assertEq(capacityLeft, CAP);
        // x - x*rate ≤ free → x ≤ 10e18 * 1e4 / 7150
        assertEq(issuableNow, (10 ether * 1e4) / (1e4 - RATE));
    }

    function test_buy_mintsAndPullsPremium() public {
        uint256 id = _createDefault();
        _fund(10 ether);
        uint256 premium = _buy(alice, id, 1 ether);
        assertEq(premium, 0.285 ether);
        assertEq(token.balanceOf(alice, id), 1 ether);
        assertEq(wxdai.balanceOf(address(pool)), 10 ether + premium);
        assertEq(pool.series(id).sold, 1 ether);
        assertEq(pool.reservedOf(id), 1 ether);
    }

    function test_buy_slippageGuard() public {
        uint256 id = _createDefault();
        _fund(10 ether);
        vm.expectRevert(abi.encodeWithSelector(CoverPool.PremiumTooHigh.selector, 0.285 ether, 0.284 ether));
        vm.prank(alice);
        pool.buyProtection(id, 1 ether, 0.284 ether);
    }

    function test_buy_capacityExceeded() public {
        uint256 id = _createDefault();
        _fund(1_000 ether);
        vm.expectRevert(CoverPool.CapacityExceeded.selector);
        vm.prank(alice);
        pool.buyProtection(id, uint256(CAP) + 1, type(uint256).max);
    }

    function test_buy_solvencyGuard_unfundedPool() public {
        uint256 id = _createDefault();
        // no funding: premium (28.5%) alone cannot back a 100% claim
        vm.expectRevert(CoverPool.Insolvent.selector);
        vm.prank(alice);
        pool.buyProtection(id, 1 ether, type(uint256).max);
    }

    function test_buy_solvencyGuard_exactBoundary() public {
        uint256 id = _createDefault();
        _fund(0.715 ether); // 1 - 0.285: premium tops the backing up to exactly 100%
        _buy(alice, id, 1 ether);
        assertEq(pool.freeCapital(), 0);
        // one wei more claim cannot be backed
        vm.expectRevert(CoverPool.Insolvent.selector);
        vm.prank(bob);
        pool.buyProtection(id, 1e18, type(uint256).max);
    }

    function test_buy_afterSaleEnd_reverts() public {
        uint256 id = _createDefault();
        _fund(10 ether);
        vm.warp(saleEnd + 1);
        vm.expectRevert(CoverPool.SaleClosed.selector);
        vm.prank(alice);
        pool.buyProtection(id, 1 ether, type(uint256).max);
    }

    function test_buy_atSaleEnd_ok() public {
        uint256 id = _createDefault();
        _fund(10 ether);
        vm.warp(saleEnd);
        _buy(alice, id, 1 ether);
    }

    function test_buy_afterSettle_reverts() public {
        uint256 id = _createDefault();
        _fund(10 ether);
        _settleAt(id, T0, 9000);
        vm.expectRevert(CoverPool.SaleClosed.selector);
        vm.prank(alice);
        pool.buyProtection(id, 1 ether, type(uint256).max);
    }

    function test_buy_whenPaused_reverts_thenUnpause() public {
        uint256 id = _createDefault();
        _fund(10 ether);
        vm.prank(sponsor);
        pool.setSalesPaused(true);
        vm.expectRevert(CoverPool.SalesArePaused.selector);
        vm.prank(alice);
        pool.buyProtection(id, 1 ether, type(uint256).max);
        vm.prank(sponsor);
        pool.setSalesPaused(false);
        _buy(alice, id, 1 ether);
    }

    function test_buy_zeroAmount_reverts() public {
        uint256 id = _createDefault();
        vm.expectRevert(CoverPool.ZeroAmount.selector);
        vm.prank(alice);
        pool.buyProtection(id, 0, 0);
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
        _settleAt(a, T0, LOW);
        assertEq(pool.series(a).payoutRatioWad, 0);
        // cents just below low → 0
        uint256 b = _createDefault();
        _settleAt(b, T0, LOW - 1);
        assertEq(pool.series(b).payoutRatioWad, 0);
        // cents == high → 1e18
        uint256 c = _createDefault();
        _settleAt(c, T0, HIGH);
        assertEq(pool.series(c).payoutRatioWad, 1e18);
        // cents above high → 1e18
        uint256 d = _createDefault();
        _settleAt(d, T0, HIGH + 500);
        assertEq(pool.series(d).payoutRatioWad, 1e18);
        // midpoint: (9288-8800)/(9600-8800) = 61%
        uint256 e = _createDefault();
        _settleAt(e, T0, 9288);
        assertEq(pool.series(e).payoutRatioWad, 0.61e18);
        // one cent above low: 1/800 of 1e18
        uint256 f = _createDefault();
        _settleAt(f, T0, LOW + 1);
        assertEq(pool.series(f).payoutRatioWad, uint256(1e18) / 800);
    }

    function test_settle_onceOnly_firstWins() public {
        uint256 id = _createDefault();
        _settleAt(id, T0, 9288);
        uint256 second = oracle.push(T0 + 1, HIGH, bytes32("later"));
        vm.expectRevert(CoverPool.AlreadySettled.selector);
        pool.settle(id, second);
        assertEq(pool.series(id).payoutRatioWad, 0.61e18, "first observation stays");
    }

    function test_settle_storesProvenance() public {
        uint256 id = _createDefault();
        uint256 obsIndex = oracle.push(T0 + 5, 9288, bytes32("prov"));
        pool.settle(id, obsIndex);
        CoverPool.Series memory s = pool.series(id);
        assertEq(s.observationT, T0 + 5);
        assertEq(s.emailId, bytes32("prov"));
    }

    function test_settle_unknownSeries_reverts() public {
        vm.expectRevert(CoverPool.InvalidSeries.selector);
        pool.settle(7, 0);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // redeem
    // ─────────────────────────────────────────────────────────────────────────

    function test_redeem_beforeSettle_reverts() public {
        uint256 id = _createDefault();
        _fund(10 ether);
        _buy(alice, id, 1 ether);
        vm.expectRevert(CoverPool.NotSettled.selector);
        vm.prank(alice);
        pool.redeem(id, 1 ether);
    }

    function test_redeem_paysRatio_andPartials() public {
        uint256 id = _createDefault();
        _fund(10 ether);
        _buy(alice, id, 2 ether);
        _settleAt(id, T0, 9288); // 61%
        uint256 before = wxdai.balanceOf(alice);
        vm.prank(alice);
        pool.redeem(id, 1 ether);
        assertEq(wxdai.balanceOf(alice) - before, 0.61 ether);
        assertEq(token.balanceOf(alice, id), 1 ether);
        vm.prank(alice);
        pool.redeem(id, 1 ether);
        assertEq(wxdai.balanceOf(alice) - before, 1.22 ether);
        assertEq(token.balanceOf(alice, id), 0);
        assertEq(pool.redeemedPayout(id), 1.22 ether);
    }

    function test_redeem_zeroRatio_burnsForNothing() public {
        uint256 id = _createDefault();
        _fund(10 ether);
        _buy(alice, id, 1 ether);
        _settleAt(id, T0, LOW); // ratio 0
        uint256 before = wxdai.balanceOf(alice);
        vm.prank(alice);
        pool.redeem(id, 1 ether);
        assertEq(wxdai.balanceOf(alice), before);
        assertEq(token.balanceOf(alice, id), 0);
    }

    function test_redeem_afterRedeemEnd_reverts() public {
        uint256 id = _createDefault();
        _fund(10 ether);
        _buy(alice, id, 1 ether);
        _settleAt(id, T0, 9288);
        vm.warp(redeemEnd + 1);
        vm.expectRevert(CoverPool.RedeemWindowClosed.selector);
        vm.prank(alice);
        pool.redeem(id, 1 ether);
    }

    function test_redeem_atRedeemEnd_ok() public {
        uint256 id = _createDefault();
        _fund(10 ether);
        _buy(alice, id, 1 ether);
        _settleAt(id, T0, 9288);
        vm.warp(redeemEnd);
        vm.prank(alice);
        pool.redeem(id, 1 ether);
    }

    function test_redeem_neverBlockedByPause() public {
        uint256 id = _createDefault();
        _fund(10 ether);
        _buy(alice, id, 1 ether);
        _settleAt(id, T0, 9288);
        vm.prank(sponsor);
        pool.setSalesPaused(true);
        vm.prank(alice);
        pool.redeem(id, 1 ether); // must not revert
    }

    function test_redeem_moreThanBalance_reverts() public {
        uint256 id = _createDefault();
        _fund(10 ether);
        _buy(alice, id, 1 ether);
        _settleAt(id, T0, 9288);
        vm.expectRevert(); // ERC1155InsufficientBalance from the token burn
        vm.prank(alice);
        pool.redeem(id, 2 ether);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // fund / withdrawExcess / reserve accounting
    // ─────────────────────────────────────────────────────────────────────────

    function test_withdraw_soldReservedBeforeSettlement() public {
        uint256 id = _createDefault();
        _fund(10 ether);
        uint256 premium = _buy(alice, id, 4 ether);
        // reserved = sold (4); free = 10 + premium - 4
        assertEq(pool.freeCapital(), 6 ether + premium);
        vm.prank(sponsor);
        vm.expectRevert(
            abi.encodeWithSelector(CoverPool.InsufficientFreeCapital.selector, 6 ether + premium + 1, 6 ether + premium)
        );
        pool.withdrawExcess(6 ether + premium + 1);
        vm.prank(sponsor);
        pool.withdrawExcess(6 ether + premium);
        assertEq(wxdai.balanceOf(address(pool)), 4 ether, "exactly the reserve remains");
    }

    function test_withdraw_ratioReservedAfterSettlement() public {
        uint256 id = _createDefault();
        _fund(10 ether);
        uint256 premium = _buy(alice, id, 4 ether);
        _settleAt(id, T0, 9288); // 61% → reserved drops to 2.44
        assertEq(pool.reservedOf(id), 2.44 ether);
        assertEq(pool.freeCapital(), 10 ether + premium - 2.44 ether);
        // partial redemption further reduces the reserve
        vm.prank(alice);
        pool.redeem(id, 1 ether);
        assertEq(pool.reservedOf(id), 2.44 ether - 0.61 ether);
    }

    function test_withdraw_fullReleaseAfterRedeemEnd() public {
        uint256 id = _createDefault();
        _fund(10 ether);
        uint256 premium = _buy(alice, id, 4 ether);
        _settleAt(id, T0, 9288);
        vm.warp(redeemEnd + 1);
        assertEq(pool.reservedOf(id), 0, "reserves release after redeemEnd");
        uint256 balance = 10 ether + premium;
        assertEq(pool.freeCapital(), balance);
        vm.prank(sponsor);
        pool.withdrawExcess(balance);
        assertEq(wxdai.balanceOf(address(pool)), 0);
    }

    function test_fund_onlySponsor_andZeroGuard() public {
        vm.expectRevert(CoverPool.NotSponsor.selector);
        pool.fundPool(1);
        vm.prank(sponsor);
        vm.expectRevert(CoverPool.ZeroAmount.selector);
        pool.fundPool(0);
    }

    function test_withdraw_onlySponsor() public {
        vm.expectRevert(CoverPool.NotSponsor.selector);
        pool.withdrawExcess(1);
    }

    function test_pause_onlySponsor() public {
        vm.expectRevert(CoverPool.NotSponsor.selector);
        pool.setSalesPaused(true);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CoverToken rules
    // ─────────────────────────────────────────────────────────────────────────

    function test_token_transfersDisabled() public {
        uint256 id = _createDefault();
        _fund(10 ether);
        _buy(alice, id, 1 ether);
        vm.prank(alice);
        vm.expectRevert(CoverToken.TransfersDisabled.selector);
        token.safeTransferFrom(alice, bob, id, 1 ether, "");
        uint256[] memory ids = new uint256[](1);
        uint256[] memory amts = new uint256[](1);
        ids[0] = id;
        amts[0] = 1 ether;
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

    // ─────────────────────────────────────────────────────────────────────────
    // Fuzz
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Payout ratio is the documented clamp for any cents value.
    function testFuzz_settle_ratioClamp(uint32 cents) public {
        uint256 id = _createDefault();
        _settleAt(id, T0, cents);
        uint256 ratio = pool.series(id).payoutRatioWad;
        if (cents <= LOW) assertEq(ratio, 0);
        else if (cents >= HIGH) assertEq(ratio, 1e18);
        else assertEq(ratio, (uint256(cents - LOW) * 1e18) / (HIGH - LOW));
    }

    /// @dev Any funded buy leaves the pool solvent, and full redemption after any
    ///      settlement can always be paid.
    function testFuzz_buySettleRedeem_solvent(uint96 maxClaimRaw, uint32 cents, uint96 fundingRaw) public {
        uint256 maxClaim = bound(uint256(maxClaimRaw), 1, CAP);
        uint256 funding = bound(uint256(fundingRaw), 0, 900 ether);
        uint256 id = _createDefault();
        if (funding > 0) _fund(funding);

        uint256 premium = (maxClaim * RATE) / 1e4;
        vm.prank(alice);
        try pool.buyProtection(id, maxClaim, premium) {
            assertGe(wxdai.balanceOf(address(pool)), pool.totalReserved(), "solvency after buy");
        } catch {
            // must be the solvency guard: funding + premium < maxClaim
            assertLt(funding + premium, maxClaim, "only insolvency may block a capacity-ok buy");
            return;
        }

        _settleAt(id, T0, cents);
        uint256 owed = (maxClaim * pool.series(id).payoutRatioWad) / 1e18;
        uint256 before = wxdai.balanceOf(alice);
        vm.prank(alice);
        pool.redeem(id, maxClaim);
        assertEq(wxdai.balanceOf(alice) - before, owed, "full claim paid");
        assertGe(wxdai.balanceOf(address(pool)), pool.totalReserved(), "solvency after redeem");
    }

    /// @dev Sponsor can never withdraw into the reserve.
    function testFuzz_withdraw_neverBreaksSolvency(uint96 withdrawRaw) public {
        uint256 id = _createDefault();
        _fund(10 ether);
        _buy(alice, id, 4 ether);
        uint256 amt = bound(uint256(withdrawRaw), 0, 20 ether);
        uint256 free = pool.freeCapital();
        if (amt > free) {
            vm.expectRevert(abi.encodeWithSelector(CoverPool.InsufficientFreeCapital.selector, amt, free));
            vm.prank(sponsor);
            pool.withdrawExcess(amt);
        } else {
            vm.prank(sponsor);
            pool.withdrawExcess(amt);
            assertGe(wxdai.balanceOf(address(pool)), pool.totalReserved());
        }
    }
}

/// @notice Randomized-sequence handler: fund / buy / settle / redeem / withdraw /
///         pause / warp in any order the fuzzer picks.
contract PoolHandler is Test {
    CoverPool public pool;
    CoverToken public token;
    TestERC20 public wxdai;
    MockObservationOracle public oracle;
    address public sponsor;
    address[3] public buyers;

    uint64 public constant T0 = 1_789_000_000;
    uint64 public constant OBS_START = T0 - 10 days;
    uint64 public constant OBS_END = T0 + 10 days;
    uint64 public constant REDEEM_END = OBS_END + 30 days;

    uint256 public ghostRedeemed; // Σ payouts sent to buyers

    constructor(CoverPool pool_, CoverToken token_, TestERC20 wxdai_, MockObservationOracle oracle_, address sponsor_) {
        pool = pool_;
        token = token_;
        wxdai = wxdai_;
        oracle = oracle_;
        sponsor = sponsor_;
        buyers[0] = makeAddr("h-buyer0");
        buyers[1] = makeAddr("h-buyer1");
        buyers[2] = makeAddr("h-buyer2");
        for (uint256 i = 0; i < 3; ++i) {
            wxdai.mint(buyers[i], 1_000_000 ether);
            vm.prank(buyers[i]);
            wxdai.approve(address(pool), type(uint256).max);
        }
        wxdai.mint(sponsor, 1_000_000 ether);
        vm.prank(sponsor);
        wxdai.approve(address(pool), type(uint256).max);
    }

    function createSeries(uint16 rateBps, uint96 capRaw) external {
        uint128 cap = uint128(bound(uint256(capRaw), 1 ether, 10_000 ether));
        vm.prank(sponsor);
        pool.createSeries(8800, 9600, uint16(bound(rateBps, 0, 1e4)), OBS_END, OBS_START, OBS_END, REDEEM_END, cap);
    }

    function fund(uint96 amtRaw) external {
        uint256 amt = bound(uint256(amtRaw), 1, 10_000 ether);
        vm.prank(sponsor);
        pool.fundPool(amt);
    }

    function buy(uint8 who, uint8 seriesRaw, uint96 amtRaw) external {
        uint256 n = pool.seriesCount();
        if (n == 0) return;
        uint256 id = seriesRaw % n;
        address buyer = buyers[who % 3];
        uint256 amt = bound(uint256(amtRaw), 1, 100 ether);
        vm.prank(buyer);
        try pool.buyProtection(id, amt, type(uint256).max) {} catch {}
    }

    function settle(uint8 seriesRaw, uint32 cents, uint32 tOffset) external {
        uint256 n = pool.seriesCount();
        if (n == 0) return;
        uint256 id = seriesRaw % n;
        uint64 t = uint64(bound(uint256(tOffset), 0, 30 days)) + OBS_START - 5 days; // sometimes out of window
        uint256 obsIndex = oracle.push(t, cents, keccak256(abi.encode(t, cents, obsIndexSalt++)));
        try pool.settle(id, obsIndex) {} catch {}
    }

    uint256 internal obsIndexSalt;

    function redeem(uint8 who, uint8 seriesRaw, uint96 amtRaw) external {
        uint256 n = pool.seriesCount();
        if (n == 0) return;
        uint256 id = seriesRaw % n;
        address buyer = buyers[who % 3];
        uint256 balance = token.balanceOf(buyer, id);
        if (balance == 0) return;
        uint256 amt = bound(uint256(amtRaw), 1, balance);
        uint256 before = wxdai.balanceOf(buyer);
        vm.prank(buyer);
        try pool.redeem(id, amt) {
            ghostRedeemed += wxdai.balanceOf(buyer) - before;
        } catch {}
    }

    function withdrawExcess(uint96 amtRaw) external {
        uint256 free = pool.freeCapital();
        if (free == 0) return;
        uint256 amt = bound(uint256(amtRaw), 1, free);
        vm.prank(sponsor);
        pool.withdrawExcess(amt);
    }

    function setPaused(bool paused) external {
        vm.prank(sponsor);
        pool.setSalesPaused(paused);
    }

    function warp(uint32 delta) external {
        vm.warp(block.timestamp + bound(uint256(delta), 0, 5 days));
    }
}

/// @notice PRD invariants under random fund/buy/settle/redeem/withdraw sequences.
contract CoverPoolInvariantTest is Test {
    TestERC20 internal wxdai;
    MockObservationOracle internal oracle;
    CoverToken internal token;
    CoverPool internal pool;
    PoolHandler internal handler;
    address internal sponsor = makeAddr("sponsor");

    function setUp() public {
        vm.warp(1_789_000_000);
        wxdai = new TestERC20();
        oracle = new MockObservationOracle();
        uint64 nonce = vm.getNonce(address(this));
        address predictedPool = vm.computeCreateAddress(address(this), nonce + 1);
        token = new CoverToken(predictedPool);
        pool = new CoverPool(wxdai, token, oracle, sponsor);
        handler = new PoolHandler(pool, token, wxdai, oracle, sponsor);
        targetContract(address(handler));
    }

    /// @notice SOLVENCY: the pool always holds at least Σ reservedOf(series).
    function invariant_solvency() public view {
        assertGe(wxdai.balanceOf(address(pool)), pool.totalReserved());
    }

    /// @notice Token supply accounting: for every series, circulating claim units
    ///         equal sold − redeemed-units, where redeemed value maps back through
    ///         the ratio. Checked as: reserved never exceeds sold (before release).
    function invariant_reserveNeverExceedsSold() public view {
        uint256 n = pool.seriesCount();
        for (uint256 i = 0; i < n; ++i) {
            assertLe(pool.reservedOf(i), pool.series(i).sold);
        }
    }

    /// @notice Settlement is one-shot: a settled series' ratio and provenance are
    ///         immutable (spot-check: ratio stays within [0, 1e18]).
    function invariant_ratioBounded() public view {
        uint256 n = pool.seriesCount();
        for (uint256 i = 0; i < n; ++i) {
            CoverPool.Series memory s = pool.series(i);
            assertLe(s.payoutRatioWad, 1e18);
            if (!s.settled) assertEq(s.payoutRatioWad, 0);
        }
    }

    /// @notice Sold never exceeds capacity.
    function invariant_capacityRespected() public view {
        uint256 n = pool.seriesCount();
        for (uint256 i = 0; i < n; ++i) {
            CoverPool.Series memory s = pool.series(i);
            assertLe(s.sold, s.capacity);
        }
    }
}
