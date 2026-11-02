// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IApartmentsRentOracle} from "../../src/apartments/ApartmentsCoverPool.sol";
import {ApartmentsCoverPoolV2} from "../../src/apartments/ApartmentsCoverPoolV2.sol";
import {ApartmentsRentOracle} from "../../src/apartments/ApartmentsRentOracle.sol";
import {CoverToken} from "../../src/CoverToken.sol";
import {GoogleAlertKey} from "../../src/gen/GoogleAlertKey.sol";
import {TestERC20} from "../utils/Helpers.sol";

contract SlugMonthOracle is IApartmentsRentOracle {
    mapping(bytes32 => mapping(uint32 => uint64)) public ts;
    mapping(bytes32 => mapping(uint32 => uint32)) public cs;

    function set(string memory slug, uint32 month, uint64 t, uint32 cents) external {
        ts[keccak256(bytes(slug))][month] = t;
        cs[keccak256(bytes(slug))][month] = cents;
    }

    function earliest(bytes32 slugHash, uint32 month) external view returns (uint64, uint32, bytes32) {
        return (ts[slugHash][month], cs[slugHash][month], bytes32(uint256(1)));
    }
}

contract ApartmentsCoverPoolV2Test is Test {
    string internal constant SLUG = "east-harlem-new-york-ny";
    uint32 internal constant MONTH = 202611;
    uint64 internal constant NOV_START = 1793491200;
    uint64 internal constant NOV_END = 1796083199;
    uint64 internal constant FINALIZE_AT = NOV_END + 1 + 2 days;
    uint64 internal constant REDEEM_END = FINALIZE_AT + 30 days;
    uint64 internal constant MID_NOV = NOV_START + 5 days;
    uint128 internal constant CAPACITY = 100e6;

    TestERC20 internal usdc;
    CoverToken internal token;
    ApartmentsCoverPoolV2 internal pool;
    SlugMonthOracle internal oracle;
    address internal creator = makeAddr("creator");
    address internal buyer = makeAddr("buyer");

    function setUp() public {
        usdc = new TestERC20();
        oracle = new SlugMonthOracle();
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        token = new CoverToken(predicted, 6);
        pool = new ApartmentsCoverPoolV2(IERC20(address(usdc)), token, oracle);
        assertEq(address(pool), predicted);
        usdc.mint(creator, 1_000e6);
        usdc.mint(buyer, 1_000e6);
        vm.prank(creator);
        usdc.approve(address(pool), type(uint256).max);
        vm.prank(buyer);
        usdc.approve(address(pool), type(uint256).max);
        vm.warp(MID_NOV);
    }

    function _create(uint64 saleEnd) internal returns (uint256) {
        vm.prank(creator);
        return pool.createSeries(SLUG, MONTH, 300000, 320000, 1000, saleEnd, REDEEM_END, CAPACITY);
    }

    function _buy(uint256 id, uint256 amount) internal {
        vm.prank(buyer);
        pool.buyProtection(id, amount, type(uint256).max);
    }

    function test_graceIsTwoDays() public view {
        assertEq(pool.SUBMISSION_GRACE(), 2 days);
    }

    function test_createsAndSellsDuringThePolicyMonth() public {
        uint256 id = _create(MID_NOV + 1 days);
        _buy(id, 10e6);
        assertEq(pool.series(id).sold, 10e6);
        assertEq(pool.series(id).finalizeAt, FINALIZE_AT);
    }

    function test_saleWindowBounds() public {
        vm.startPrank(creator);
        vm.expectRevert(abi.encodeWithSelector(ApartmentsCoverPoolV2.InvalidParams.selector, "saleEnd"));
        pool.createSeries(SLUG, MONTH, 300000, 320000, 1000, NOV_END + 1, REDEEM_END, CAPACITY);
        vm.expectRevert(abi.encodeWithSelector(ApartmentsCoverPoolV2.InvalidParams.selector, "saleEnd"));
        pool.createSeries(SLUG, MONTH, 300000, 320000, 1000, MID_NOV, REDEEM_END, CAPACITY);
        // The last second of the month is allowed.
        pool.createSeries(SLUG, MONTH, 300000, 320000, 1000, NOV_END, REDEEM_END, CAPACITY);
        // A month that already ended cannot be opened.
        vm.expectRevert(abi.encodeWithSelector(ApartmentsCoverPoolV2.InvalidParams.selector, "saleEnd"));
        pool.createSeries(SLUG, 202610, 300000, 320000, 1000, MID_NOV + 1, REDEEM_END, CAPACITY);
        vm.stopPrank();
    }

    function test_claimWindowCountsFromTheShorterGrace() public {
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(ApartmentsCoverPoolV2.InvalidParams.selector, "claimWindow"));
        pool.createSeries(SLUG, MONTH, 300000, 320000, 1000, NOV_END, FINALIZE_AT + 14 days - 1, CAPACITY);
        vm.prank(creator);
        pool.createSeries(SLUG, MONTH, 300000, 320000, 1000, NOV_END, FINALIZE_AT + 14 days, CAPACITY);
    }

    function test_cannotCreateOnceTheMonthIsRecorded() public {
        oracle.set(SLUG, MONTH, MID_NOV - 1 days, 310000);
        vm.prank(creator);
        vm.expectRevert(ApartmentsCoverPoolV2.RentAlreadyRecorded.selector);
        pool.createSeries(SLUG, MONTH, 300000, 320000, 1000, NOV_END, REDEEM_END, CAPACITY);
        // Another page or month is unaffected.
        vm.prank(creator);
        pool.createSeries("mott-haven-bronx-ny", MONTH, 300000, 320000, 1000, NOV_END, REDEEM_END, CAPACITY);
    }

    function test_salesStopWhenTheMonthIsRecorded() public {
        uint256 id = _create(NOV_END);
        _buy(id, 10e6);
        oracle.set(SLUG, MONTH, MID_NOV + 1 hours, 310000);
        (,,, uint256 issuable) = pool.quote(id, 1e6);
        assertEq(issuable, 0);
        vm.prank(buyer);
        vm.expectRevert(ApartmentsCoverPoolV2.RentAlreadyRecorded.selector);
        pool.buyProtection(id, 1e6, type(uint256).max);
    }

    function test_recordStopsTopUpsButNotCancel() public {
        uint256 id = _create(NOV_END);
        oracle.set(SLUG, MONTH, MID_NOV + 1 hours, 310000);
        vm.startPrank(creator);
        vm.expectRevert(ApartmentsCoverPoolV2.RentAlreadyRecorded.selector);
        pool.addCapacity(id, 1e6);
        pool.cancelSeries(id);
        vm.stopPrank();
        assertEq(usdc.balanceOf(creator), 1_000e6);
        assertEq(usdc.balanceOf(address(pool)), 0);
    }

    function test_settlesTwoDaysAfterMonthEnd() public {
        uint256 id = _create(NOV_END);
        _buy(id, 10e6);
        oracle.set(SLUG, MONTH, MID_NOV + 1 days, 310000);
        vm.warp(FINALIZE_AT - 1);
        vm.expectRevert(ApartmentsCoverPoolV2.TooEarly.selector);
        pool.finalize(id);
        vm.warp(FINALIZE_AT);
        uint256 before = usdc.balanceOf(buyer);
        vm.prank(buyer);
        pool.redeem(id, 10e6);
        assertEq(pool.series(id).payoutRatioWad, 0.5e18);
        assertEq(usdc.balanceOf(buyer) - before, 5e6);
        vm.warp(REDEEM_END + 1);
        vm.prank(creator);
        pool.withdrawResidual(id);
        assertEq(usdc.balanceOf(address(pool)), 0);
    }

    function test_noEmailVoids() public {
        uint256 id = _create(NOV_END);
        _buy(id, 10e6);
        vm.warp(FINALIZE_AT);
        vm.prank(buyer);
        pool.redeem(id, 10e6);
        assertTrue(pool.series(id).voided);
        vm.warp(REDEEM_END + 1);
        vm.prank(creator);
        pool.withdrawResidual(id);
        assertEq(usdc.balanceOf(address(pool)), 0);
        assertEq(usdc.balanceOf(buyer), 1_000e6);
        assertEq(usdc.balanceOf(creator), 1_000e6);
    }

    function testFuzz_booksBalance(uint128 amount, uint32 cents, uint16 rate, bool voided, uint32 saleOffset) public {
        rate = uint16(bound(rate, 1, 10000));
        amount = uint128(bound(amount, 1e4, CAPACITY));
        uint64 saleEnd = uint64(bound(saleOffset, MID_NOV + 1, NOV_END));
        vm.prank(creator);
        uint256 id = pool.createSeries(SLUG, MONTH, 300000, 320000, rate, saleEnd, REDEEM_END, CAPACITY);
        _buy(id, amount);
        if (!voided) oracle.set(SLUG, MONTH, MID_NOV + 1, uint32(bound(cents, 1, type(uint32).max)));
        vm.warp(FINALIZE_AT);
        vm.prank(buyer);
        pool.redeem(id, amount);
        vm.warp(REDEEM_END + 1);
        vm.prank(creator);
        pool.withdrawResidual(id);
        assertEq(usdc.balanceOf(address(pool)), 0);
        assertEq(usdc.balanceOf(buyer) + usdc.balanceOf(creator), 2_000e6);
    }
}

contract V2Handler is Test {
    ApartmentsCoverPoolV2 internal pool;
    TestERC20 internal usdc;
    SlugMonthOracle internal oracle;
    address internal immutable actor = makeAddr("v2-actor");
    uint256[] public ids;
    uint64 internal constant NOV_START = 1793491200;
    uint64 internal constant NOV_END = 1796083199;
    uint64 internal constant FINALIZE_AT = NOV_END + 1 + 2 days;

    constructor(ApartmentsCoverPoolV2 pool_, TestERC20 usdc_, SlugMonthOracle oracle_) {
        pool = pool_;
        usdc = usdc_;
        oracle = oracle_;
        usdc.mint(actor, 1e30);
        vm.prank(actor);
        usdc.approve(address(pool), type(uint256).max);
    }

    function count() external view returns (uint256) {
        return ids.length;
    }

    function create(uint128 capacity, uint16 rate, uint32 saleOffset) external {
        if (block.timestamp >= NOV_END) return;
        uint64 saleEnd = uint64(bound(saleOffset, block.timestamp + 1, NOV_END));
        vm.prank(actor);
        try pool.createSeries(
            "mott-haven-bronx-ny",
            202611,
            100000,
            200000,
            uint16(bound(rate, 0, 10000)),
            saleEnd,
            FINALIZE_AT + 30 days,
            uint128(bound(capacity, 1e6, 1e24))
        ) returns (
            uint256 id
        ) {
            ids.push(id);
        } catch {}
    }

    function buy(uint256 seed, uint128 amount) external {
        if (ids.length == 0) return;
        uint256 id = ids[seed % ids.length];
        ApartmentsCoverPoolV2.Series memory s = pool.series(id);
        if (s.cancelled || s.sold == s.escrow) return;
        vm.prank(actor);
        try pool.buyProtection(id, bound(amount, 1, s.escrow - s.sold), type(uint256).max) {} catch {}
    }

    function topUp(uint256 seed, uint128 amount) external {
        if (ids.length == 0) return;
        vm.prank(actor);
        try pool.addCapacity(ids[seed % ids.length], uint128(bound(amount, 1, 1e24))) {} catch {}
    }

    function cancel(uint256 seed) external {
        if (ids.length == 0) return;
        vm.prank(actor);
        try pool.cancelSeries(ids[seed % ids.length]) {} catch {}
    }

    function record(uint32 cents) external {
        if (block.timestamp < NOV_START || block.timestamp > NOV_END) return;
        (uint64 t,) = (oracle.ts(keccak256("mott-haven-bronx-ny"), 202611), 0);
        if (t == 0) {
            oracle.set("mott-haven-bronx-ny", 202611, uint64(block.timestamp), uint32(bound(cents, 1, 400000)));
        }
    }

    function warp(uint32 by) external {
        vm.warp(block.timestamp + bound(by, 1 hours, 6 days));
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

contract ApartmentsCoverPoolV2InvariantTest is Test {
    V2Handler internal handler;
    ApartmentsCoverPoolV2 internal pool;
    TestERC20 internal usdc;

    function setUp() public {
        usdc = new TestERC20();
        SlugMonthOracle oracle = new SlugMonthOracle();
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        CoverToken token = new CoverToken(predicted, 6);
        pool = new ApartmentsCoverPoolV2(IERC20(address(usdc)), token, oracle);
        vm.warp(1793491200 - 3 days);
        handler = new V2Handler(pool, usdc, oracle);
        targetContract(address(handler));
    }

    /// Pool balance equals the sum of open books, and every book stays solvent.
    function invariant_conservationAndSolvency() public view {
        uint256 books;
        for (uint256 i = 0; i < handler.count(); ++i) {
            ApartmentsCoverPoolV2.Series memory s = pool.series(handler.ids(i));
            assertLe(s.paidOut, s.sold);
            if (!s.cancelled) assertLe(s.sold, s.escrow);
            if (!s.residualWithdrawn) books += uint256(s.escrow) + s.premiumsAccrued - s.paidOut;
        }
        assertEq(usdc.balanceOf(address(pool)), books);
    }
}

/// @notice V2 on a fork of Arbitrum One, wired to the DEPLOYED oracle and real USDC,
///         settled by a real Google-signed email. Policy opened and sold inside October.
///         Needs ARBITRUM_FORK_RPC and fixtures/private; skips otherwise.
contract ApartmentsCoverPoolV2LiveForkTest is Test {
    ApartmentsRentOracle internal constant ORACLE = ApartmentsRentOracle(0x235281E05c1F155068A73BF48B43ac1C79a9c855);
    IERC20 internal constant USDC = IERC20(0xaf88d065e77c8cC2239327C5EDb3A432268e5831);
    string internal constant DIR = "fixtures/private/google-alerts/";
    string internal constant SLUG = "east-harlem-new-york-ny";
    uint64 internal constant OCT_START = 1790812800;
    uint64 internal constant OCT_END = 1793491199;

    function test_inMonthPolicySettlesFromRealEmail() public {
        string memory rpc = vm.envOr("ARBITRUM_FORK_RPC", string(""));
        string memory manifestPath = string.concat(DIR, "manifest.json");
        if (bytes(rpc).length == 0 || !vm.exists(manifestPath)) return vm.skip(true);
        vm.createSelectFork(rpc);
        assertEq(ORACLE.MODULUS_HASH(), keccak256(GoogleAlertKey.MODULUS));

        address deployer = makeAddr("v2-deployer");
        vm.startPrank(deployer);
        address predicted = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 1);
        CoverToken token = new CoverToken(predicted, 6);
        ApartmentsCoverPoolV2 pool = new ApartmentsCoverPoolV2(USDC, token, IApartmentsRentOracle(address(ORACLE)));
        vm.stopPrank();

        address creator = makeAddr("v2-creator");
        address buyer = makeAddr("v2-buyer");
        deal(address(USDC), creator, 100e6);
        deal(address(USDC), buyer, 10e6);
        uint64 finalizeAt = OCT_END + 1 + 2 days;

        // Five days into October, sales run until the 7th.
        vm.warp(OCT_START + 5 days);
        vm.startPrank(creator);
        USDC.approve(address(pool), type(uint256).max);
        uint256 id =
            pool.createSeries(SLUG, 202610, 290000, 300000, 1000, OCT_START + 7 days, finalizeAt + 30 days, 100e6);
        vm.stopPrank();
        vm.startPrank(buyer);
        USDC.approve(address(pool), type(uint256).max);
        pool.buyProtection(id, 100e6, 10e6);
        vm.stopPrank();

        (uint256 i, uint64 t) = _eastHarlemEmail();
        vm.warp(t + 1 hours);
        string memory d = string.concat(DIR, vm.toString(i), "/");
        ORACLE.submitObservation(
            vm.readFileBinary(string.concat(d, "signed-headers.bin")),
            vm.readFileBinary(string.concat(d, "canon-body.bin")),
            vm.readFileBinary(string.concat(d, "sig.bin"))
        );

        vm.warp(finalizeAt);
        vm.prank(buyer);
        pool.redeem(id, 100e6);
        assertEq(pool.series(id).payoutRatioWad, 0.52e18);
        assertEq(USDC.balanceOf(buyer), 52e6);
        vm.warp(finalizeAt + 30 days + 1);
        vm.prank(creator);
        pool.withdrawResidual(id);
        assertEq(USDC.balanceOf(creator), 100e6 + 10e6 - 52e6);
        assertEq(USDC.balanceOf(address(pool)), 0);
    }

    function _eastHarlemEmail() internal view returns (uint256, uint64) {
        string memory manifest = vm.readFile(string.concat(DIR, "manifest.json"));
        uint256 count = vm.parseJsonUint(manifest, ".count");
        for (uint256 i = 0; i < count; ++i) {
            string memory e = string.concat(".emails[", vm.toString(i), "]");
            uint256 n = vm.parseJsonUint(manifest, string.concat(e, ".resultCount"));
            for (uint256 j = 0; j < n; ++j) {
                string memory slug =
                    vm.parseJsonString(manifest, string.concat(e, ".results[", vm.toString(j), "].slug"));
                if (keccak256(bytes(slug)) == keccak256(bytes(SLUG))) {
                    return (i, uint64(vm.parseJsonUint(manifest, string.concat(e, ".t"))));
                }
            }
        }
        revert("no archived email for the page");
    }
}
