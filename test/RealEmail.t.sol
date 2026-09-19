// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {CoverPool} from "../src/CoverPool.sol";
import {CoverToken} from "../src/CoverToken.sol";
import {CredailyRentOracle} from "../src/CredailyRentOracle.sol";
import {CredailyKey} from "../src/gen/CredailyKey.sol";
import {IObservationOracle} from "../src/interfaces/IObservationOracle.sol";
import {DkimHarness, TestERC20} from "./utils/Helpers.sol";

/// @notice End-to-end against the REAL CRE Daily email fixture
///         (fixtures/credaily-2026-09-17/): submitObservation on the real-modulus
///         oracle, demo-series settlement at ratio 0.61e18, the full permissionless
///         circle (creator escrows → buy → settle → redeem at 61% → residual
///         withdrawal) with exact amounts, and the settlement gas number.
contract RealEmailTest is Test {
    // ground truth from fixtures/credaily-2026-09-17/meta.json (VERIFIED locally)
    uint64 internal constant REAL_T = 1789642464;
    uint32 internal constant REAL_CENTS = 9288;

    // demo series (SPEC §2.5)
    uint32 internal constant STRIKE_LOW = 8800;
    uint32 internal constant STRIKE_HIGH = 9600;
    uint16 internal constant RATE_BPS = 2850;
    uint64 internal constant OBS_START = 1_788_220_800; // 2026-09-01 00:00 UTC
    uint64 internal constant OBS_END = 1_790_812_740; // 2026-09-30 23:59 UTC
    uint64 internal constant SALE_END = OBS_START; // saleEnd ≤ obsStart: on-chain invariant
    uint64 internal constant REDEEM_END = OBS_END + 90 days;
    uint128 internal constant CAPACITY = 0.02 ether;

    // the series must exist before the observation window opens
    uint64 internal constant CREATE_T = OBS_START - 7 days;

    bytes internal headers;
    bytes internal body;
    bytes internal sig;

    CredailyRentOracle internal oracle;
    TestERC20 internal wxdai;
    CoverToken internal token;
    CoverPool internal pool;

    address internal creator = makeAddr("creator");
    address internal buyer = makeAddr("buyer");

    function setUp() public {
        headers = vm.readFileBinary("fixtures/credaily-2026-09-17/signed-headers.bin");
        body = vm.readFileBinary("fixtures/credaily-2026-09-17/canon-body.bin");
        sig = vm.readFileBinary("fixtures/credaily-2026-09-17/sig.bin");

        vm.warp(CREATE_T); // before the sale closes; tests warp to REAL_T to observe

        oracle = new CredailyRentOracle(CredailyKey.MODULUS);
        wxdai = new TestERC20();

        uint64 nonce = vm.getNonce(address(this));
        address predictedPool = vm.computeCreateAddress(address(this), nonce + 1);
        token = new CoverToken(predictedPool, wxdai.decimals());
        pool = new CoverPool(wxdai, token, IObservationOracle(address(oracle)));
        assertEq(address(pool), predictedPool, "CREATE precompute");

        wxdai.mint(creator, 1 ether);
        wxdai.mint(buyer, 1 ether);
        vm.prank(creator);
        wxdai.approve(address(pool), type(uint256).max);
        vm.prank(buyer);
        wxdai.approve(address(pool), type(uint256).max);

        // the creator escrows the full capacity at creation — permissionless, no roles
        vm.prank(creator);
        pool.createSeries(STRIKE_LOW, STRIKE_HIGH, RATE_BPS, SALE_END, OBS_START, OBS_END, REDEEM_END, CAPACITY);
        assertEq(wxdai.balanceOf(address(pool)), CAPACITY, "escrow pulled at creation");
    }

    function _submitReal() internal returns (uint256 gasUsed) {
        // memory locals so the measured window prices the CALL, not test-side SLOADs
        bytes memory h = headers;
        bytes memory b = body;
        bytes memory s = sig;
        uint256 g0 = gasleft();
        oracle.submitObservation(h, b, s);
        gasUsed = g0 - gasleft();
    }

    function test_submitObservation_realEmail() public {
        vm.warp(REAL_T); // the email's own signing time
        vm.expectEmit(true, true, true, true);
        emit CredailyRentOracle.ObservationRecorded(0, REAL_T, REAL_CENTS, sha256(body), address(this));
        uint256 gasUsed = _submitReal();
        console.log("submitObservation gas (102,197 B real body):", gasUsed);

        assertEq(oracle.observationCount(), 1);
        (uint64 t, uint32 cents, bytes32 emailId) = oracle.observations(0);
        assertEq(t, REAL_T, "t");
        assertEq(cents, REAL_CENTS, "cents");
        assertEq(emailId, sha256(body), "emailId == bh32");
        assertTrue(oracle.recorded(emailId));
    }

    function test_extractSnapshot_realBody_gasAndValue() public {
        DkimHarness h = new DkimHarness();
        // memory local: reading the storage `body` var inside the measured window
        // would bill ~6.7M of cold SLOADs to the harness call
        bytes memory realBody = vm.readFileBinary("fixtures/credaily-2026-09-17/canon-body.bin");
        uint256 g0 = gasleft();
        (uint256 cents, uint256 anchors) = h.extractSnapshot(realBody);
        uint256 gasUsed = g0 - gasleft();
        console.log("extractSnapshot gas (102,197 B real body):", gasUsed);
        assertEq(cents, 9288);
        assertEq(anchors, 1);
        assertLt(gasUsed, 3_000_000, "SPEC target: < 3M gas for the 102 KB fixture");
    }

    function test_fullLifecycle_ratio61_buyRedeemResidual() public {
        // buyer takes 0.01 WXDAI of max claim during the sale (premium 28.5%)
        uint256 maxClaim = 0.01 ether;
        uint256 premium = (maxClaim * RATE_BPS) / 1e4;
        vm.prank(buyer);
        pool.buyProtection(0, maxClaim, premium);
        assertEq(token.balanceOf(buyer, 0), maxClaim);
        assertEq(wxdai.balanceOf(address(pool)), CAPACITY + premium);
        CoverPool.Series memory s = pool.series(0);
        assertEq(s.sold, maxClaim, "sold accounted");
        assertEq(s.premiumsAccrued, premium, "premium in the series bucket");

        // the real email settles the series: (9288-8800)/(9600-8800) = 0.61
        vm.warp(REAL_T); // the email's own signing time
        _submitReal();
        pool.settle(0, 0);
        s = pool.series(0);
        assertTrue(s.settled);
        assertEq(s.payoutRatioWad, 0.61e18, "ratio");
        assertEq(s.observationT, REAL_T);
        assertEq(s.emailId, sha256(body));

        // second settle attempt: one-shot
        vm.expectRevert(CoverPool.AlreadySettled.selector);
        pool.settle(0, 0);

        // redeem pays 61%
        uint256 owed = (maxClaim * 0.61e18) / 1e18;
        uint256 before = wxdai.balanceOf(buyer);
        vm.prank(buyer);
        pool.redeem(0, maxClaim);
        assertEq(wxdai.balanceOf(buyer) - before, owed, "payout = 61%");
        assertEq(token.balanceOf(buyer, 0), 0);
        assertEq(pool.series(0).paidOut, owed);

        // the residual is locked until the claim window shuts
        vm.expectRevert(CoverPool.RedeemWindowOpen.selector);
        vm.prank(creator);
        pool.withdrawResidual(0);

        // after redeemEnd the creator collects escrow + premium − payout, one-shot
        vm.warp(REDEEM_END + 1);
        uint256 creatorBefore = wxdai.balanceOf(creator);
        vm.prank(creator);
        pool.withdrawResidual(0);
        assertEq(wxdai.balanceOf(creator) - creatorBefore, CAPACITY + premium - owed, "residual math");
        assertEq(wxdai.balanceOf(address(pool)), 0, "pool fully drained");
        vm.expectRevert(CoverPool.ResidualAlreadyWithdrawn.selector);
        vm.prank(creator);
        pool.withdrawResidual(0);

        // full circle: the creator ends up ±premium/payout, the buyer mirrors it
        assertEq(wxdai.balanceOf(creator), 1 ether + premium - owed, "creator net = premium - payout");
        assertEq(wxdai.balanceOf(buyer), 1 ether - premium + owed, "buyer net = payout - premium");
    }

    function test_replay_reverts() public {
        vm.warp(REAL_T);
        _submitReal();
        vm.expectRevert(CredailyRentOracle.AlreadyRecorded.selector);
        oracle.submitObservation(headers, body, sig);
    }

    function test_oracleViews() public view {
        assertEq(oracle.MODULUS_HASH(), CredailyKey.MODULUS_HASH);
        assertEq(keccak256(oracle.modulus()), CredailyKey.MODULUS_HASH);
        assertEq(oracle.DOMAIN(), "newyork.credaily.com");
        assertEq(oracle.SELECTOR(), "b37");
    }
}
