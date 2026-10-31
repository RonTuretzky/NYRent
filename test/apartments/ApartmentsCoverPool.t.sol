// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ApartmentsCoverPool, IApartmentsRentOracle} from "../../src/apartments/ApartmentsCoverPool.sol";
import {ApartmentsRentOracle} from "../../src/apartments/ApartmentsRentOracle.sol";
import {CoverToken} from "../../src/CoverToken.sol";
import {TestERC20} from "../utils/Helpers.sol";

contract MockRentOracle is IApartmentsRentOracle {
    uint64 public t;
    uint32 public cents;

    function set(uint64 t_, uint32 cents_) external {
        t = t_;
        cents = cents_;
    }

    function earliest(bytes32, uint32) external view returns (uint64, uint32, bytes32) {
        return (t, cents, bytes32(uint256(1)));
    }
}

abstract contract PoolBase is Test {
    string internal constant SLUG = "east-harlem-new-york-ny";
    uint32 internal constant MONTH = 202611;
    uint64 internal constant NOV_START = 1793491200;
    uint64 internal constant NOV_END = 1796083199;
    uint64 internal constant FINALIZE_AT = NOV_END + 1 + 7 days;
    uint64 internal constant REDEEM_END = FINALIZE_AT + 30 days;
    uint32 internal constant LOW = 300000;
    uint32 internal constant HIGH = 320000;
    uint16 internal constant RATE = 1000;
    uint128 internal constant CAPACITY = 100 ether;

    TestERC20 internal wxdai;
    CoverToken internal token;
    ApartmentsCoverPool internal pool;
    address internal creator = makeAddr("creator");
    address internal buyer = makeAddr("buyer");
    address internal stranger = makeAddr("stranger");

    function _deploy(IApartmentsRentOracle oracle) internal {
        wxdai = new TestERC20();
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        token = new CoverToken(predicted, 18);
        pool = new ApartmentsCoverPool(IERC20(address(wxdai)), token, oracle);
        assertEq(address(pool), predicted);
        wxdai.mint(creator, 1_000 ether);
        wxdai.mint(buyer, 1_000 ether);
        vm.prank(creator);
        wxdai.approve(address(pool), type(uint256).max);
        vm.prank(buyer);
        wxdai.approve(address(pool), type(uint256).max);
        vm.warp(NOV_START - 10 days);
    }

    function _create() internal returns (uint256) {
        vm.prank(creator);
        return pool.createSeries(SLUG, MONTH, LOW, HIGH, RATE, NOV_START, REDEEM_END, CAPACITY);
    }

    function _buy(uint256 id, uint256 amount) internal {
        vm.prank(buyer);
        pool.buyProtection(id, amount, type(uint256).max);
    }
}

contract ApartmentsCoverPoolTest is PoolBase {
    MockRentOracle internal mock;

    function setUp() public {
        mock = new MockRentOracle();
        _deploy(mock);
    }

    function test_anyoneCreatesAndEscrowsFullCapacity() public {
        uint256 id = _create();
        assertEq(wxdai.balanceOf(address(pool)), CAPACITY);
        ApartmentsCoverPool.Series memory s = pool.series(id);
        assertEq(s.creator, creator);
        assertEq(s.slugHash, keccak256(bytes(SLUG)));
        assertEq(pool.seriesSlug(id), SLUG);
        assertEq(s.finalizeAt, FINALIZE_AT);
    }

    function test_paramValidation() public {
        vm.startPrank(creator);
        vm.expectRevert(abi.encodeWithSelector(ApartmentsCoverPool.InvalidParams.selector, "slug"));
        pool.createSeries("East Harlem", MONTH, LOW, HIGH, RATE, NOV_START, REDEEM_END, CAPACITY);
        vm.expectRevert(abi.encodeWithSelector(ApartmentsCoverPool.InvalidParams.selector, "slug"));
        pool.createSeries("", MONTH, LOW, HIGH, RATE, NOV_START, REDEEM_END, CAPACITY);
        vm.expectRevert(abi.encodeWithSelector(ApartmentsCoverPool.InvalidParams.selector, "obsMonth"));
        pool.createSeries(SLUG, 202613, LOW, HIGH, RATE, NOV_START, REDEEM_END, CAPACITY);
        vm.expectRevert(abi.encodeWithSelector(ApartmentsCoverPool.InvalidParams.selector, "strikes"));
        pool.createSeries(SLUG, MONTH, HIGH, LOW, RATE, NOV_START, REDEEM_END, CAPACITY);
        vm.expectRevert(abi.encodeWithSelector(ApartmentsCoverPool.InvalidParams.selector, "premiumRate"));
        pool.createSeries(SLUG, MONTH, LOW, HIGH, 10001, NOV_START, REDEEM_END, CAPACITY);
        vm.expectRevert(abi.encodeWithSelector(ApartmentsCoverPool.InvalidParams.selector, "saleEnd"));
        pool.createSeries(SLUG, MONTH, LOW, HIGH, RATE, NOV_START + 1, REDEEM_END, CAPACITY);
        vm.expectRevert(abi.encodeWithSelector(ApartmentsCoverPool.InvalidParams.selector, "claimWindow"));
        pool.createSeries(SLUG, MONTH, LOW, HIGH, RATE, NOV_START, FINALIZE_AT + 14 days - 1, CAPACITY);
        vm.expectRevert(abi.encodeWithSelector(ApartmentsCoverPool.InvalidParams.selector, "capacity"));
        pool.createSeries(SLUG, MONTH, LOW, HIGH, RATE, NOV_START, REDEEM_END, 0);
        vm.stopPrank();
    }

    function test_cannotBuyOncePolicyMonthStarts() public {
        uint256 id = _create();
        vm.warp(NOV_START + 1);
        vm.prank(buyer);
        vm.expectRevert(ApartmentsCoverPool.SaleClosed.selector);
        pool.buyProtection(id, 1 ether, type(uint256).max);
    }

    function test_buyCappedByCapacityAndPremium() public {
        uint256 id = _create();
        vm.startPrank(buyer);
        vm.expectRevert(ApartmentsCoverPool.CapacityExceeded.selector);
        pool.buyProtection(id, CAPACITY + 1, type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(ApartmentsCoverPool.PremiumTooHigh.selector, 1 ether, 0.5 ether));
        pool.buyProtection(id, 10 ether, 0.5 ether);
        vm.stopPrank();
    }

    function test_cannotFinalizeBeforeSubmissionWindowCloses() public {
        uint256 id = _create();
        mock.set(NOV_START + 1, 310000);
        vm.warp(FINALIZE_AT - 1);
        vm.expectRevert(ApartmentsCoverPool.TooEarly.selector);
        pool.finalize(id);
    }

    function test_settledPartialPayout() public {
        uint256 id = _create();
        _buy(id, 10 ether);
        mock.set(NOV_START + 1, 310000);
        vm.warp(FINALIZE_AT);
        uint256 before = wxdai.balanceOf(buyer);
        vm.prank(buyer);
        pool.redeem(id, 10 ether); // finalizes implicitly
        assertTrue(pool.series(id).settled);
        assertEq(pool.series(id).payoutRatioWad, 0.5e18);
        assertEq(wxdai.balanceOf(buyer) - before, 5 ether);

        vm.warp(REDEEM_END + 1);
        uint256 creatorBefore = wxdai.balanceOf(creator);
        vm.prank(creator);
        pool.withdrawResidual(id);
        assertEq(wxdai.balanceOf(creator) - creatorBefore, CAPACITY + 1 ether - 5 ether);
        assertEq(wxdai.balanceOf(address(pool)), 0);
    }

    function test_rentAtOrBelowLowPaysNothingAboveHighPaysAll() public {
        uint256 a = _create();
        uint256 b = _create();
        _buy(a, 1 ether);
        _buy(b, 1 ether);
        mock.set(NOV_START + 1, LOW);
        vm.warp(FINALIZE_AT);
        pool.finalize(a);
        assertEq(pool.series(a).payoutRatioWad, 0);
        mock.set(NOV_START + 1, HIGH + 1);
        pool.finalize(b);
        assertEq(pool.series(b).payoutRatioWad, 1e18);
    }

    function test_noDataVoidsAndRefundsPremiumAndEscrow() public {
        uint256 id = _create();
        _buy(id, 10 ether);
        vm.warp(FINALIZE_AT);
        pool.finalize(id);
        assertTrue(pool.series(id).voided);

        uint256 before = wxdai.balanceOf(buyer);
        vm.prank(buyer);
        pool.redeem(id, 10 ether);
        assertEq(wxdai.balanceOf(buyer) - before, 1 ether);

        vm.warp(REDEEM_END + 1);
        uint256 creatorBefore = wxdai.balanceOf(creator);
        vm.prank(creator);
        pool.withdrawResidual(id);
        assertEq(wxdai.balanceOf(creator) - creatorBefore, CAPACITY);
        assertEq(wxdai.balanceOf(address(pool)), 0);
    }

    function test_voidCannotBeReopenedByLateEmail() public {
        uint256 id = _create();
        vm.warp(FINALIZE_AT);
        pool.finalize(id);
        mock.set(NOV_START + 1, HIGH);
        vm.expectRevert(ApartmentsCoverPool.AlreadyFinalized.selector);
        pool.finalize(id);
    }

    function test_creatorCannotExitEarly() public {
        uint256 id = _create();
        _buy(id, 1 ether);
        vm.startPrank(creator);
        vm.expectRevert(ApartmentsCoverPool.AlreadySold.selector);
        pool.cancelSeries(id);
        vm.expectRevert(ApartmentsCoverPool.RedeemWindowOpen.selector);
        pool.withdrawResidual(id);
        vm.stopPrank();
    }

    function test_cancelAndResidualShareOneExit() public {
        uint256 id = _create();
        vm.startPrank(creator);
        pool.cancelSeries(id);
        vm.expectRevert(ApartmentsCoverPool.SeriesClosed.selector);
        pool.cancelSeries(id);
        vm.warp(REDEEM_END + 1);
        vm.expectRevert(ApartmentsCoverPool.SeriesClosed.selector);
        pool.withdrawResidual(id);
        vm.stopPrank();
        assertEq(wxdai.balanceOf(address(pool)), 0);
    }

    function test_cancelledPolicyCannotFinalizeOrRedeem() public {
        uint256 id = _create();
        vm.prank(creator);
        pool.cancelSeries(id);
        vm.warp(FINALIZE_AT);
        vm.expectRevert(ApartmentsCoverPool.SeriesClosed.selector);
        pool.finalize(id);
        vm.prank(buyer);
        vm.expectRevert(ApartmentsCoverPool.SeriesClosed.selector);
        pool.redeem(id, 1);
    }

    function test_onlyCreatorLevers() public {
        uint256 id = _create();
        vm.startPrank(stranger);
        vm.expectRevert(ApartmentsCoverPool.NotCreator.selector);
        pool.setSeriesPaused(id, true);
        vm.expectRevert(ApartmentsCoverPool.NotCreator.selector);
        pool.addCapacity(id, 1);
        vm.expectRevert(ApartmentsCoverPool.NotCreator.selector);
        pool.cancelSeries(id);
        vm.expectRevert(ApartmentsCoverPool.NotCreator.selector);
        pool.withdrawResidual(id);
        vm.stopPrank();
    }

    function test_pauseStopsSalesNotRedemption() public {
        uint256 id = _create();
        _buy(id, 1 ether);
        vm.prank(creator);
        pool.setSeriesPaused(id, true);
        vm.prank(buyer);
        vm.expectRevert(ApartmentsCoverPool.SalesArePaused.selector);
        pool.buyProtection(id, 1 ether, type(uint256).max);
        mock.set(NOV_START + 1, HIGH);
        vm.warp(FINALIZE_AT);
        vm.prank(buyer);
        pool.redeem(id, 1 ether);
        assertEq(pool.series(id).paidOut, 1 ether);
    }

    function test_redeemWindowCloses() public {
        uint256 id = _create();
        _buy(id, 1 ether);
        vm.warp(REDEEM_END + 1);
        vm.prank(buyer);
        vm.expectRevert(ApartmentsCoverPool.RedeemWindowClosed.selector);
        pool.redeem(id, 1 ether);
    }

    function test_claimsAreSoulbound() public {
        uint256 id = _create();
        _buy(id, 1 ether);
        vm.prank(buyer);
        vm.expectRevert();
        token.safeTransferFrom(buyer, stranger, id, 1 ether, "");
    }

    function testFuzz_payoutNeverExceedsBacking(uint128 amount, uint32 cents, uint16 rate, bool voided) public {
        rate = uint16(bound(rate, 1, 10000));
        amount = uint128(bound(amount, 1e6, CAPACITY));
        vm.prank(creator);
        uint256 id = pool.createSeries(SLUG, MONTH, LOW, HIGH, rate, NOV_START, REDEEM_END, CAPACITY);
        _buy(id, amount);
        if (!voided) mock.set(NOV_START + 1, uint32(bound(cents, 1, type(uint32).max)));
        vm.warp(FINALIZE_AT);
        vm.prank(buyer);
        pool.redeem(id, amount);
        vm.warp(REDEEM_END + 1);
        vm.prank(creator);
        pool.withdrawResidual(id);
        assertEq(wxdai.balanceOf(address(pool)), 0);
    }
}

/// @notice The full circle through the real oracle with a test-key-signed email.
contract ApartmentsEndToEndTest is PoolBase {
    ApartmentsRentOracle internal oracle;

    function setUp() public {
        oracle = new ApartmentsRentOracle(vm.parseJsonBytes(vm.readFile("fixtures/testkey/meta.json"), ".modulus_hex"));
        _deploy(IApartmentsRentOracle(address(oracle)));
    }

    function _submit(string memory name) internal {
        string memory d = string.concat("fixtures/google-alert-synthetic/", name, "/");
        oracle.submitObservation(
            vm.readFileBinary(string.concat(d, "signed-headers.bin")),
            vm.readFileBinary(string.concat(d, "canon-body.bin")),
            vm.readFileBinary(string.concat(d, "sig.bin"))
        );
    }

    /// The later $3,500 email lands first; the earlier $3,010 email still decides.
    function test_earliestSignedEmailDecidesRegardlessOfSubmissionOrder() public {
        uint256 id = _create();
        _buy(id, 10 ether);
        vm.warp(1793620800 + 2 days);
        _submit("ok-later-different");
        _submit("ok-single");
        vm.warp(FINALIZE_AT);
        uint256 before = wxdai.balanceOf(buyer);
        vm.prank(buyer);
        pool.redeem(id, 10 ether);
        assertEq(pool.series(id).payoutRatioWad, 0.05e18); // (3010 - 3000) / (3200 - 3000)
        assertEq(wxdai.balanceOf(buyer) - before, 0.5 ether);
    }
}

contract PoolHandler is Test {
    ApartmentsCoverPool internal pool;
    TestERC20 internal wxdai;
    MockRentOracle internal mock;
    address internal immutable actor = makeAddr("actor");
    uint256[] public ids;
    uint64 internal constant NOV_START = 1793491200;
    uint64 internal constant FINALIZE_AT = 1796083200 + 7 days;

    constructor(ApartmentsCoverPool pool_, TestERC20 wxdai_, MockRentOracle mock_) {
        pool = pool_;
        wxdai = wxdai_;
        mock = mock_;
        wxdai.mint(actor, 1e30);
        vm.prank(actor);
        wxdai.approve(address(pool), type(uint256).max);
    }

    function count() external view returns (uint256) {
        return ids.length;
    }

    function create(uint128 capacity, uint16 rate) external {
        if (block.timestamp >= NOV_START) return;
        vm.prank(actor);
        ids.push(
            pool.createSeries(
                "mott-haven-bronx-ny",
                202611,
                100000,
                200000,
                uint16(bound(rate, 0, 10000)),
                NOV_START,
                FINALIZE_AT + 30 days,
                uint128(bound(capacity, 1 ether, 1e24))
            )
        );
    }

    function buy(uint256 seed, uint128 amount) external {
        if (ids.length == 0 || block.timestamp > NOV_START) return;
        uint256 id = ids[seed % ids.length];
        ApartmentsCoverPool.Series memory s = pool.series(id);
        if (s.cancelled || s.sold == s.escrow) return;
        vm.prank(actor);
        pool.buyProtection(id, bound(amount, 1, s.escrow - s.sold), type(uint256).max);
    }

    function cancel(uint256 seed) external {
        if (ids.length == 0) return;
        vm.prank(actor);
        try pool.cancelSeries(ids[seed % ids.length]) {} catch {}
    }

    function setRent(uint32 cents) external {
        mock.set(NOV_START + 1, cents);
    }

    function warp(uint32 by) external {
        vm.warp(block.timestamp + bound(by, 1 hours, 15 days));
    }

    function redeem(uint256 seed, uint128 amount) external {
        if (ids.length == 0) return;
        vm.prank(actor);
        try pool.redeem(ids[seed % ids.length], bound(amount, 1, 1e24)) {} catch {}
    }

    function residual(uint256 seed) external {
        if (ids.length == 0) return;
        vm.prank(actor);
        try pool.withdrawResidual(ids[seed % ids.length]) {} catch {}
    }
}

contract ApartmentsPoolInvariantTest is PoolBase {
    PoolHandler internal handler;

    function setUp() public {
        MockRentOracle mock = new MockRentOracle();
        _deploy(mock);
        handler = new PoolHandler(pool, wxdai, mock);
        targetContract(address(handler));
    }

    /// Pool balance is exactly the sum of per-policy books, and every book is solvent.
    function invariant_conservationAndSolvency() public view {
        uint256 books;
        for (uint256 i = 0; i < handler.count(); ++i) {
            ApartmentsCoverPool.Series memory s = pool.series(handler.ids(i));
            assertLe(s.paidOut, s.sold);
            if (!s.cancelled) assertLe(s.sold, s.escrow);
            if (!s.residualWithdrawn) books += uint256(s.escrow) + s.premiumsAccrued - s.paidOut;
        }
        assertEq(wxdai.balanceOf(address(pool)), books);
    }
}
