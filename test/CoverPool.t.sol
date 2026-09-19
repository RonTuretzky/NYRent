// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC1155Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
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
///      {CoverPool.buyProtectionFor} entrypoint.
contract ReentrantRecipient {
    CoverPool internal immutable pool;
    TestUSDC internal immutable usdc;
    uint8 internal mode; // 0 = buyProtectionFor, 1 = buyProtection, 2 = settle
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
            // must revert: reentrant on any pool entrypoint, settle included
            if (mode == 0) pool.buyProtectionFor(seriesId, 1, type(uint256).max, address(this));
            else if (mode == 1) pool.buyProtection(seriesId, 1, type(uint256).max);
            else pool.settle(seriesId, 0);
        }
        return this.onERC1155Received.selector;
    }
}

/// @notice CoverPool scenario matrix at the 6-decimals USDC deployment currency:
///         create/buy/settle/redeem/withdraw, window and clamp edges, pause semantics,
///         solvency, the two-step sponsor handoff (with cancel), {buyProtectionFor}
///         recipient minting, the per-series pause, plus fuzz. Invariants live in
///         {CoverPoolInvariantTest}.
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

    address internal sponsor = makeAddr("sponsor");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        vm.warp(T0);
        obsStart = T0 - 10 days;
        obsEnd = T0 + 10 days;
        saleEnd = obsEnd;
        redeemEnd = obsEnd + 30 days;

        usdc = new TestUSDC();
        oracle = new MockObservationOracle();

        uint64 nonce = vm.getNonce(address(this));
        address predictedPool = vm.computeCreateAddress(address(this), nonce + 1);
        token = new CoverToken(predictedPool, usdc.decimals());
        pool = new CoverPool(usdc, token, IObservationOracle(address(oracle)), sponsor);
        assertEq(address(pool), predictedPool);

        usdc.mint(sponsor, 1_000 * ONE);
        usdc.mint(alice, 1_000 * ONE);
        usdc.mint(bob, 1_000 * ONE);
        vm.prank(sponsor);
        usdc.approve(address(pool), type(uint256).max);
        vm.prank(alice);
        usdc.approve(address(pool), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(pool), type(uint256).max);
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
        _fund(10 * ONE);
        (uint256 premium, uint16 rateBps, uint256 capacityLeft, uint256 issuableNow) = pool.quote(id, ONE);
        assertEq(premium, 0.285e6);
        assertEq(rateBps, RATE);
        assertEq(capacityLeft, CAP);
        // x - x*rate ≤ free → x ≤ 10e6 * 1e4 / 7150
        assertEq(issuableNow, (10 * ONE * 1e4) / (1e4 - RATE));
    }

    function test_buy_mintsAndPullsPremium() public {
        uint256 id = _createDefault();
        _fund(10 * ONE);
        uint256 premium = _buy(alice, id, ONE);
        assertEq(premium, 0.285e6);
        assertEq(token.balanceOf(alice, id), ONE);
        assertEq(usdc.balanceOf(address(pool)), 10 * ONE + premium);
        assertEq(pool.series(id).sold, ONE);
        assertEq(pool.reservedOf(id), ONE);
    }

    function test_buy_slippageGuard() public {
        uint256 id = _createDefault();
        _fund(10 * ONE);
        vm.expectRevert(abi.encodeWithSelector(CoverPool.PremiumTooHigh.selector, 0.285e6, 0.284e6));
        vm.prank(alice);
        pool.buyProtection(id, ONE, 0.284e6);
    }

    function test_buy_capacityExceeded() public {
        uint256 id = _createDefault();
        _fund(1_000 * ONE);
        vm.expectRevert(CoverPool.CapacityExceeded.selector);
        vm.prank(alice);
        pool.buyProtection(id, uint256(CAP) + 1, type(uint256).max);
    }

    function test_buy_solvencyGuard_unfundedPool() public {
        uint256 id = _createDefault();
        // no funding: premium (28.5%) alone cannot back a 100% claim
        vm.expectRevert(CoverPool.Insolvent.selector);
        vm.prank(alice);
        pool.buyProtection(id, ONE, type(uint256).max);
    }

    function test_buy_solvencyGuard_exactBoundary() public {
        uint256 id = _createDefault();
        _fund(0.715e6); // 1 - 0.285: premium tops the backing up to exactly 100%
        _buy(alice, id, ONE);
        assertEq(pool.freeCapital(), 0);
        // any further claim cannot be backed
        vm.expectRevert(CoverPool.Insolvent.selector);
        vm.prank(bob);
        pool.buyProtection(id, ONE, type(uint256).max);
    }

    function test_buy_afterSaleEnd_reverts() public {
        uint256 id = _createDefault();
        _fund(10 * ONE);
        vm.warp(saleEnd + 1);
        vm.expectRevert(CoverPool.SaleClosed.selector);
        vm.prank(alice);
        pool.buyProtection(id, ONE, type(uint256).max);
    }

    function test_buy_atSaleEnd_ok() public {
        uint256 id = _createDefault();
        _fund(10 * ONE);
        vm.warp(saleEnd);
        _buy(alice, id, ONE);
    }

    function test_buy_afterSettle_reverts() public {
        uint256 id = _createDefault();
        _fund(10 * ONE);
        _settleAt(id, T0, 9000);
        vm.expectRevert(CoverPool.SaleClosed.selector);
        vm.prank(alice);
        pool.buyProtection(id, ONE, type(uint256).max);
    }

    function test_buy_whenPaused_reverts_thenUnpause() public {
        uint256 id = _createDefault();
        _fund(10 * ONE);
        vm.prank(sponsor);
        pool.setSalesPaused(true);
        vm.expectRevert(CoverPool.SalesArePaused.selector);
        vm.prank(alice);
        pool.buyProtection(id, ONE, type(uint256).max);
        vm.prank(sponsor);
        pool.setSalesPaused(false);
        _buy(alice, id, ONE);
    }

    function test_buy_zeroAmount_reverts() public {
        uint256 id = _createDefault();
        vm.expectRevert(CoverPool.ZeroAmount.selector);
        vm.prank(alice);
        pool.buyProtection(id, 0, 0);
    }

    function test_buy_premiumRoundsToZero_reverts() public {
        uint256 id = _createDefault();
        _fund(10 * ONE);
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
        _fund(10 * ONE);
        _buy(alice, id, ONE);
        vm.expectRevert(CoverPool.NotSettled.selector);
        vm.prank(alice);
        pool.redeem(id, ONE);
    }

    function test_redeem_paysRatio_andPartials() public {
        uint256 id = _createDefault();
        _fund(10 * ONE);
        _buy(alice, id, 2 * ONE);
        _settleAt(id, T0, 9288); // 61%
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        pool.redeem(id, ONE);
        assertEq(usdc.balanceOf(alice) - before, 0.61e6);
        assertEq(token.balanceOf(alice, id), ONE);
        vm.prank(alice);
        pool.redeem(id, ONE);
        assertEq(usdc.balanceOf(alice) - before, 1.22e6);
        assertEq(token.balanceOf(alice, id), 0);
        assertEq(pool.redeemedPayout(id), 1.22e6);
    }

    function test_redeem_zeroRatio_burnsForNothing() public {
        uint256 id = _createDefault();
        _fund(10 * ONE);
        _buy(alice, id, ONE);
        _settleAt(id, T0, LOW); // ratio 0
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        pool.redeem(id, ONE);
        assertEq(usdc.balanceOf(alice), before);
        assertEq(token.balanceOf(alice, id), 0);
    }

    function test_redeem_afterRedeemEnd_reverts() public {
        uint256 id = _createDefault();
        _fund(10 * ONE);
        _buy(alice, id, ONE);
        _settleAt(id, T0, 9288);
        vm.warp(redeemEnd + 1);
        vm.expectRevert(CoverPool.RedeemWindowClosed.selector);
        vm.prank(alice);
        pool.redeem(id, ONE);
    }

    function test_redeem_atRedeemEnd_ok() public {
        uint256 id = _createDefault();
        _fund(10 * ONE);
        _buy(alice, id, ONE);
        _settleAt(id, T0, 9288);
        vm.warp(redeemEnd);
        vm.prank(alice);
        pool.redeem(id, ONE);
    }

    function test_redeem_neverBlockedByPause() public {
        uint256 id = _createDefault();
        _fund(10 * ONE);
        _buy(alice, id, ONE);
        _settleAt(id, T0, 9288);
        vm.prank(sponsor);
        pool.setSalesPaused(true);
        vm.prank(alice);
        pool.redeem(id, ONE); // must not revert
    }

    function test_redeem_moreThanBalance_reverts() public {
        uint256 id = _createDefault();
        _fund(10 * ONE);
        _buy(alice, id, ONE);
        _settleAt(id, T0, 9288);
        vm.expectRevert(); // ERC1155InsufficientBalance from the token burn
        vm.prank(alice);
        pool.redeem(id, 2 * ONE);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // fund / withdrawExcess / reserve accounting
    // ─────────────────────────────────────────────────────────────────────────

    function test_withdraw_soldReservedBeforeSettlement() public {
        uint256 id = _createDefault();
        _fund(10 * ONE);
        uint256 premium = _buy(alice, id, 4 * ONE);
        // reserved = sold (4); free = 10 + premium - 4
        assertEq(pool.freeCapital(), 6 * ONE + premium);
        vm.prank(sponsor);
        vm.expectRevert(
            abi.encodeWithSelector(CoverPool.InsufficientFreeCapital.selector, 6 * ONE + premium + 1, 6 * ONE + premium)
        );
        pool.withdrawExcess(6 * ONE + premium + 1);
        vm.prank(sponsor);
        pool.withdrawExcess(6 * ONE + premium);
        assertEq(usdc.balanceOf(address(pool)), 4 * ONE, "exactly the reserve remains");
    }

    function test_withdraw_ratioReservedAfterSettlement() public {
        uint256 id = _createDefault();
        _fund(10 * ONE);
        uint256 premium = _buy(alice, id, 4 * ONE);
        _settleAt(id, T0, 9288); // 61% → reserved drops to 2.44
        assertEq(pool.reservedOf(id), 2.44e6);
        assertEq(pool.freeCapital(), 10 * ONE + premium - 2.44e6);
        // partial redemption further reduces the reserve
        vm.prank(alice);
        pool.redeem(id, ONE);
        assertEq(pool.reservedOf(id), 2.44e6 - 0.61e6);
    }

    function test_withdraw_fullReleaseAfterRedeemEnd() public {
        uint256 id = _createDefault();
        _fund(10 * ONE);
        uint256 premium = _buy(alice, id, 4 * ONE);
        _settleAt(id, T0, 9288);
        vm.warp(redeemEnd + 1);
        assertEq(pool.reservedOf(id), 0, "reserves release after redeemEnd");
        uint256 balance = 10 * ONE + premium;
        assertEq(pool.freeCapital(), balance);
        vm.prank(sponsor);
        pool.withdrawExcess(balance);
        assertEq(usdc.balanceOf(address(pool)), 0);
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
        _fund(10 * ONE);
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
    // Two-step sponsor handoff
    // ─────────────────────────────────────────────────────────────────────────

    function test_constructor_zeroSponsor_reverts() public {
        vm.expectRevert(CoverPool.ZeroAddress.selector);
        new CoverPool(usdc, token, IObservationOracle(address(oracle)), address(0));
    }

    function test_transferSponsorship_onlySponsor() public {
        vm.expectRevert(CoverPool.NotSponsor.selector);
        pool.transferSponsorship(alice);
    }

    function test_transferSponsorship_renounceDisallowed() public {
        vm.prank(sponsor);
        vm.expectRevert(CoverPool.ZeroAddress.selector);
        pool.transferSponsorship(address(0));
    }

    function test_sponsorHandoff_happyPath() public {
        address agent = makeAddr("agent");
        vm.prank(sponsor);
        vm.expectEmit(true, true, true, true);
        emit CoverPool.SponsorshipTransferStarted(sponsor, agent);
        pool.transferSponsorship(agent);
        assertEq(pool.sponsor(), sponsor, "no handover before accept");
        assertEq(pool.pendingSponsor(), agent);

        vm.prank(agent);
        vm.expectEmit(true, true, true, true);
        emit CoverPool.SponsorshipTransferred(sponsor, agent);
        pool.acceptSponsorship();
        assertEq(pool.sponsor(), agent);
        assertEq(pool.pendingSponsor(), address(0), "pending slot cleared");
    }

    function test_acceptSponsorship_onlyPending() public {
        // no handoff in flight: nobody may accept
        vm.prank(alice);
        vm.expectRevert(CoverPool.NotPendingSponsor.selector);
        pool.acceptSponsorship();
        // handoff in flight: neither a stranger nor the current sponsor may accept
        address agent = makeAddr("agent");
        vm.prank(sponsor);
        pool.transferSponsorship(agent);
        vm.prank(alice);
        vm.expectRevert(CoverPool.NotPendingSponsor.selector);
        pool.acceptSponsorship();
        vm.prank(sponsor);
        vm.expectRevert(CoverPool.NotPendingSponsor.selector);
        pool.acceptSponsorship();
    }

    function test_sponsorHandoff_pendingOverwrite() public {
        address first = makeAddr("first");
        address second = makeAddr("second");
        vm.startPrank(sponsor);
        pool.transferSponsorship(first);
        pool.transferSponsorship(second); // overwrites the in-flight handoff
        vm.stopPrank();
        assertEq(pool.pendingSponsor(), second);
        vm.prank(first);
        vm.expectRevert(CoverPool.NotPendingSponsor.selector);
        pool.acceptSponsorship();
        vm.prank(second);
        pool.acceptSponsorship();
        assertEq(pool.sponsor(), second);
    }

    function test_cancelSponsorshipTransfer_clearsPending() public {
        address agent = makeAddr("agent");
        vm.prank(sponsor);
        pool.transferSponsorship(agent);
        assertEq(pool.pendingSponsor(), agent);

        vm.prank(sponsor);
        vm.expectEmit(true, true, true, true);
        emit CoverPool.SponsorshipTransferCanceled(sponsor, agent);
        pool.cancelSponsorshipTransfer();
        assertEq(pool.pendingSponsor(), address(0), "pending slot cleared");
        assertEq(pool.sponsor(), sponsor, "sponsor unchanged");

        // the canceled pending sponsor can no longer accept
        vm.prank(agent);
        vm.expectRevert(CoverPool.NotPendingSponsor.selector);
        pool.acceptSponsorship();
    }

    function test_cancelSponsorshipTransfer_onlySponsor() public {
        address agent = makeAddr("agent");
        vm.prank(sponsor);
        pool.transferSponsorship(agent);
        // neither a stranger nor the pending sponsor itself may cancel
        vm.prank(alice);
        vm.expectRevert(CoverPool.NotSponsor.selector);
        pool.cancelSponsorshipTransfer();
        vm.prank(agent);
        vm.expectRevert(CoverPool.NotSponsor.selector);
        pool.cancelSponsorshipTransfer();
    }

    function test_cancelSponsorshipTransfer_noHandoffInFlight_reverts() public {
        vm.prank(sponsor);
        vm.expectRevert(CoverPool.NoHandoffInFlight.selector);
        pool.cancelSponsorshipTransfer();
    }

    function test_sponsorHandoff_pendingHasNoLeversBeforeAccept() public {
        address agent = makeAddr("agent");
        vm.prank(sponsor);
        pool.transferSponsorship(agent);
        vm.startPrank(agent);
        vm.expectRevert(CoverPool.NotSponsor.selector);
        pool.fundPool(1);
        vm.expectRevert(CoverPool.NotSponsor.selector);
        pool.setSalesPaused(true);
        vm.stopPrank();
    }

    function test_sponsorHandoff_oldSponsorLockedOut() public {
        uint256 id = _createDefault();
        address agent = makeAddr("agent");
        vm.prank(sponsor);
        pool.transferSponsorship(agent);
        vm.prank(agent);
        pool.acceptSponsorship();

        vm.startPrank(sponsor);
        vm.expectRevert(CoverPool.NotSponsor.selector);
        pool.fundPool(1);
        vm.expectRevert(CoverPool.NotSponsor.selector);
        pool.withdrawExcess(1);
        vm.expectRevert(CoverPool.NotSponsor.selector);
        pool.setSalesPaused(true);
        vm.expectRevert(CoverPool.NotSponsor.selector);
        pool.setSeriesPaused(id, true);
        vm.expectRevert(CoverPool.NotSponsor.selector);
        pool.createSeries(LOW, HIGH, RATE, saleEnd, obsStart, obsEnd, redeemEnd, CAP);
        vm.expectRevert(CoverPool.NotSponsor.selector);
        pool.transferSponsorship(sponsor);
        vm.expectRevert(CoverPool.NotSponsor.selector);
        pool.cancelSponsorshipTransfer();
        vm.stopPrank();
    }

    function test_sponsorHandoff_leversWorkForNewSponsor() public {
        address agent = makeAddr("agent");
        usdc.mint(agent, 100 * ONE);
        vm.prank(agent);
        usdc.approve(address(pool), type(uint256).max);

        vm.prank(sponsor);
        pool.transferSponsorship(agent);
        vm.prank(agent);
        pool.acceptSponsorship();

        vm.startPrank(agent);
        uint256 id = pool.createSeries(LOW, HIGH, RATE, saleEnd, obsStart, obsEnd, redeemEnd, CAP);
        pool.fundPool(10 * ONE);
        pool.setSalesPaused(true);
        pool.setSalesPaused(false);
        pool.setSeriesPaused(id, true);
        pool.setSeriesPaused(id, false);
        pool.withdrawExcess(10 * ONE);
        pool.transferSponsorship(sponsor); // and can hand back
        vm.stopPrank();
        assertEq(pool.pendingSponsor(), sponsor);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // buyProtectionFor (recipient minting; cover stays soulbound)
    // ─────────────────────────────────────────────────────────────────────────

    function test_buyFor_mintsToRecipient_pullsPremiumFromPayer() public {
        uint256 id = _createDefault();
        _fund(10 * ONE);
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
        _fund(10 * ONE);
        vm.expectRevert(CoverPool.ZeroAddress.selector);
        vm.prank(alice);
        pool.buyProtectionFor(id, ONE, type(uint256).max, address(0));
    }

    function test_buyFor_recipientRedeems_payerCannot() public {
        uint256 id = _createDefault();
        _fund(10 * ONE);
        vm.prank(alice);
        pool.buyProtectionFor(id, ONE, type(uint256).max, bob);
        _settleAt(id, T0, 9288); // 61%
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
        _fund(10 * ONE);
        vm.prank(alice);
        pool.buyProtectionFor(id, ONE, type(uint256).max, bob);
        vm.prank(bob);
        vm.expectRevert(CoverToken.TransfersDisabled.selector);
        token.safeTransferFrom(bob, alice, id, ONE, "");
    }

    function test_buyFor_nonReceiverContract_reverts_fundsUntouched() public {
        uint256 id = _createDefault();
        _fund(10 * ONE);
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
        _fund(10 * ONE);
        AcceptingRecipient holder = new AcceptingRecipient();
        vm.prank(alice);
        pool.buyProtectionFor(id, ONE, type(uint256).max, address(holder));
        assertEq(token.balanceOf(address(holder), id), ONE);
    }

    function test_buyFor_reentrancyBlocked() public {
        uint256 id = _createDefault();
        _fund(10 * ONE);
        ReentrantRecipient attacker = new ReentrantRecipient(pool, usdc);
        usdc.mint(address(attacker), 5 * ONE);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        attacker.attack(id, ONE, 0);
    }

    function test_buyFor_reentrancyBlocked_viaWrapper() public {
        uint256 id = _createDefault();
        _fund(10 * ONE);
        ReentrantRecipient attacker = new ReentrantRecipient(pool, usdc);
        usdc.mint(address(attacker), 5 * ONE);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        attacker.attack(id, ONE, 1);
    }

    function test_settle_reentrancyBlocked_fromMintCallback() public {
        uint256 id = _createDefault();
        _fund(10 * ONE);
        // a qualifying observation already exists; settling mid-purchase must still fail
        oracle.push(T0, 9288, bytes32("mid-buy"));
        ReentrantRecipient attacker = new ReentrantRecipient(pool, usdc);
        usdc.mint(address(attacker), 5 * ONE);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        attacker.attack(id, ONE, 2);
        assertFalse(pool.series(id).settled, "no settlement happened");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Per-series pause vs global pause
    // ─────────────────────────────────────────────────────────────────────────

    function test_setSeriesPaused_onlySponsor() public {
        uint256 id = _createDefault();
        vm.expectRevert(CoverPool.NotSponsor.selector);
        pool.setSeriesPaused(id, true);
    }

    function test_setSeriesPaused_unknownSeries_reverts() public {
        vm.prank(sponsor);
        vm.expectRevert(CoverPool.InvalidSeries.selector);
        pool.setSeriesPaused(0, true);
    }

    function test_seriesPause_blocksOnlyThatSeries() public {
        uint256 a = _createDefault();
        uint256 b = _createDefault();
        _fund(10 * ONE);
        vm.prank(sponsor);
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
        vm.prank(sponsor);
        pool.setSeriesPaused(a, false);
        _buy(alice, a, ONE);
    }

    function test_globalPause_blocksUnpausedSeries() public {
        uint256 a = _createDefault();
        uint256 b = _createDefault();
        _fund(10 * ONE);
        vm.prank(sponsor);
        pool.setSalesPaused(true);
        vm.expectRevert(CoverPool.SalesArePaused.selector);
        vm.prank(alice);
        pool.buyProtection(a, ONE, type(uint256).max);
        vm.expectRevert(CoverPool.SalesArePaused.selector);
        vm.prank(alice);
        pool.buyProtectionFor(b, ONE, type(uint256).max, bob);
    }

    function test_bothPauses_mustBothClear() public {
        uint256 id = _createDefault();
        _fund(10 * ONE);
        vm.startPrank(sponsor);
        pool.setSalesPaused(true);
        pool.setSeriesPaused(id, true);
        vm.stopPrank();
        vm.expectRevert(CoverPool.SalesArePaused.selector);
        vm.prank(alice);
        pool.buyProtection(id, ONE, type(uint256).max);
        // clearing only the global switch is not enough
        vm.prank(sponsor);
        pool.setSalesPaused(false);
        vm.expectRevert(CoverPool.SalesArePaused.selector);
        vm.prank(alice);
        pool.buyProtection(id, ONE, type(uint256).max);
        // clearing the series switch reopens the sale
        vm.prank(sponsor);
        pool.setSeriesPaused(id, false);
        _buy(alice, id, ONE);
    }

    function test_seriesPause_neverBlocksSettleOrRedeem() public {
        uint256 id = _createDefault();
        _fund(10 * ONE);
        _buy(alice, id, ONE);
        vm.startPrank(sponsor);
        pool.setSeriesPaused(id, true);
        pool.setSalesPaused(true);
        vm.stopPrank();
        _settleAt(id, T0, 9288); // settle ignores both switches
        vm.prank(alice);
        pool.redeem(id, ONE); // redeem ignores both switches
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
        uint256 funding = bound(uint256(fundingRaw), 0, 900 * ONE);
        uint256 id = _createDefault();
        if (funding > 0) _fund(funding);

        uint256 premium = (maxClaim * RATE) / 1e4;
        vm.prank(alice);
        try pool.buyProtection(id, maxClaim, premium) {
            assertGt(premium, 0, "zero-premium buys must revert");
            assertGe(usdc.balanceOf(address(pool)), pool.totalReserved(), "solvency after buy");
        } catch {
            // either the dust guard (premium rounds to zero) or the solvency guard
            assertTrue(
                premium == 0 || funding + premium < maxClaim, "only dust or insolvency may block a capacity-ok buy"
            );
            return;
        }

        _settleAt(id, T0, cents);
        uint256 owed = (maxClaim * pool.series(id).payoutRatioWad) / 1e18;
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        pool.redeem(id, maxClaim);
        assertEq(usdc.balanceOf(alice) - before, owed, "full claim paid");
        assertGe(usdc.balanceOf(address(pool)), pool.totalReserved(), "solvency after redeem");
    }

    /// @dev buyProtectionFor: for any recipient-minted purchase, the payer funds the
    ///      premium, the recipient holds exactly the claim, and solvency holds.
    function testFuzz_buyFor_payerRecipientSplit(uint96 maxClaimRaw, uint96 fundingRaw) public {
        uint256 maxClaim = bound(uint256(maxClaimRaw), 1, CAP);
        uint256 funding = bound(uint256(fundingRaw), 0, 900 * ONE);
        uint256 id = _createDefault();
        if (funding > 0) _fund(funding);

        uint256 premium = (maxClaim * RATE) / 1e4;
        uint256 alicePre = usdc.balanceOf(alice);
        vm.prank(alice);
        try pool.buyProtectionFor(id, maxClaim, premium, bob) {
            assertGt(premium, 0, "zero-premium buys must revert");
            assertEq(alicePre - usdc.balanceOf(alice), premium, "payer paid");
            assertEq(token.balanceOf(bob, id), maxClaim, "recipient holds");
            assertEq(token.balanceOf(alice, id), 0);
            assertGe(usdc.balanceOf(address(pool)), pool.totalReserved(), "solvency after buyFor");
        } catch {
            assertTrue(
                premium == 0 || funding + premium < maxClaim, "only dust or insolvency may block a capacity-ok buyFor"
            );
        }
    }

    /// @dev Sponsor can never withdraw into the reserve.
    function testFuzz_withdraw_neverBreaksSolvency(uint96 withdrawRaw) public {
        uint256 id = _createDefault();
        _fund(10 * ONE);
        _buy(alice, id, 4 * ONE);
        uint256 amt = bound(uint256(withdrawRaw), 0, 20 * ONE);
        uint256 free = pool.freeCapital();
        if (amt > free) {
            vm.expectRevert(abi.encodeWithSelector(CoverPool.InsufficientFreeCapital.selector, amt, free));
            vm.prank(sponsor);
            pool.withdrawExcess(amt);
        } else {
            vm.prank(sponsor);
            pool.withdrawExcess(amt);
            assertGe(usdc.balanceOf(address(pool)), pool.totalReserved());
        }
    }
}
