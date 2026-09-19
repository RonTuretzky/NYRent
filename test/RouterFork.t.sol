// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CoverToken} from "../src/CoverToken.sol";
import {CredailyRentOracle} from "../src/CredailyRentOracle.sol";
import {CredailyKey} from "../src/gen/CredailyKey.sol";
import {IObservationOracle} from "../src/interfaces/IObservationOracle.sol";
import {CoverPool} from "../src/CoverPool.sol";
import {ICoverPool, ISwapRouter02, IWETH9, SwapAndBuyRouter} from "../src/SwapAndBuyRouter.sol";

/// @notice SwapAndBuyRouter proof against a LIVE Arbitrum One fork: the full fixture
///         (pinned-key {CredailyRentOracle} → {CoverToken} → {CoverPool} on native
///         USDC) plus the real Uniswap SwapRouter02, WETH and ARB. Buys cover paying in
///         WETH (ERC-20 and native ETH) and in ARB through real pools, proves the
///         failure legs revert atomically, and runs the real-email full lifecycle
///         (oracle → settle at ratio 0.61 → redeem → residual) on Nitro. Skips itself
///         when no network is available: `setUp` probes `ARBITRUM_RPC_URL` (default:
///         the public arb1 endpoint) and every test is gated on the fork having been
///         created.
contract RouterForkTest is Test {
    // ─────────────────────────────────────────────────────────────────────────
    // Arbitrum One constants
    // ─────────────────────────────────────────────────────────────────────────

    string internal constant DEFAULT_RPC = "https://arb1.arbitrum.io/rpc";

    /// @notice Native (Circle-issued) USDC, 6 decimals (verified in {Deploy}).
    address internal constant USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;

    /// @notice Canonical WETH9 (`SwapRouter02.WETH9()`).
    address internal constant WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;

    /// @notice ARB governance token.
    address internal constant ARB = 0x912CE59144191C1204E64559FE8253a0e49E6548;

    /// @notice Canonical Uniswap SwapRouter02 (verified in {Deploy}).
    address internal constant SWAP_ROUTER_02 = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;

    // ─────────────────────────────────────────────────────────────────────────
    // Fixture parameters (6-decimals USDC units)
    // ─────────────────────────────────────────────────────────────────────────

    uint32 internal constant LOW = 8800;
    uint32 internal constant HIGH = 9600;
    uint16 internal constant RATE = 2850;
    uint128 internal constant CAP = 50_000e6; // escrowed 1:1 by the creator
    uint256 internal constant MAX_CLAIM = 500e6; // 500 USDC of max claim
    uint256 internal constant PREMIUM = 142_500_000; // MAX_CLAIM × 2850 / 1e4

    // ground truth from fixtures/credaily-2026-09-17/meta.json (VERIFIED locally)
    uint64 internal constant REAL_T = 1_789_642_464;
    uint32 internal constant REAL_CENTS = 9288;

    bool internal forked;

    CredailyRentOracle internal oracle;
    CoverToken internal token;
    CoverPool internal pool;
    SwapAndBuyRouter internal router;
    uint256 internal seriesId;

    address internal creator = makeAddr("creator");
    address internal buyer = makeAddr("buyer");

    function setUp() public {
        try vm.createSelectFork(vm.envOr("ARBITRUM_RPC_URL", string(DEFAULT_RPC))) {
            forked = true;
        } catch {
            return; // no network — every test skips via onlyForked
        }
        assertEq(block.chainid, 42_161, "not Arbitrum One");

        // The same pinned-key oracle bytecode as Gnosis, deployed fresh on the fork.
        oracle = new CredailyRentOracle(CredailyKey.MODULUS);

        uint64 nonce = vm.getNonce(address(this));
        address predictedPool = vm.computeCreateAddress(address(this), nonce + 1);
        token = new CoverToken(predictedPool, 6);
        pool = new CoverPool(IERC20(USDC), token, IObservationOracle(address(oracle)));
        assertEq(address(pool), predictedPool);

        router = new SwapAndBuyRouter(ISwapRouter02(SWAP_ROUTER_02), ICoverPool(address(pool)));

        deal(USDC, creator, CAP);
        vm.startPrank(creator);
        IERC20(USDC).approve(address(pool), type(uint256).max);
        seriesId = pool.createSeries(
            LOW,
            HIGH,
            RATE,
            uint64(block.timestamp + 30 days), // saleEnd: open now, ≤ obsStart
            uint64(block.timestamp + 30 days),
            uint64(block.timestamp + 60 days),
            uint64(block.timestamp + 90 days),
            CAP // pulled from the creator as the series escrow
        );
        vm.stopPrank();
    }

    modifier onlyForked() {
        vm.skip(!forked, "Arbitrum fork unavailable (set ARBITRUM_RPC_URL or allow network)");
        _;
    }

    /// @dev Exact-output paths are encoded in REVERSE: USDC (output) first, tokenIn last.
    function _wethPath() internal pure returns (bytes memory) {
        return abi.encodePacked(USDC, uint24(500), WETH);
    }

    function _arbPath() internal pure returns (bytes memory) {
        return abi.encodePacked(USDC, uint24(500), WETH, uint24(500), ARB);
    }

    function _wrap(address who, uint256 amount) internal {
        vm.deal(who, amount);
        vm.prank(who);
        IWETH9(WETH).deposit{value: amount}();
        vm.prank(who);
        IERC20(WETH).approve(address(router), amount);
    }

    function _assertRouterEmpty() internal view {
        assertEq(IERC20(WETH).balanceOf(address(router)), 0, "router weth");
        assertEq(IERC20(ARB).balanceOf(address(router)), 0, "router arb");
        assertEq(IERC20(USDC).balanceOf(address(router)), 0, "router usdc");
        assertEq(address(router).balance, 0, "router eth");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Wiring
    // ─────────────────────────────────────────────────────────────────────────

    function test_fork_routerReadsCanonicalWiring() public onlyForked {
        assertEq(router.weth9(), WETH);
        assertEq(address(router.swapRouter()), SWAP_ROUTER_02);
        assertEq(address(router.pool()), address(pool));
        assertEq(address(router.usdc()), USDC, "currency read from pool.currency()");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Happy paths through real Uniswap pools
    // ─────────────────────────────────────────────────────────────────────────

    function test_fork_swapAndBuyWithWeth() public onlyForked {
        _wrap(buyer, 1 ether);

        vm.prank(buyer);
        uint256 amountIn = router.swapAndBuy(WETH, 1 ether, _wethPath(), seriesId, MAX_CLAIM);

        assertGt(amountIn, 0, "swap consumed nothing");
        assertLt(amountIn, 1 ether, "no dust to refund");
        assertEq(token.balanceOf(buyer, seriesId), MAX_CLAIM, "cover minted to buyer");
        assertEq(IERC20(USDC).balanceOf(address(pool)), uint256(CAP) + PREMIUM, "premium in pool");
        assertEq(IERC20(WETH).balanceOf(buyer), 1 ether - amountIn, "dust refunded");
        assertEq(pool.series(seriesId).sold, uint128(MAX_CLAIM), "sold accounted");
        assertEq(IERC20(WETH).allowance(address(router), SWAP_ROUTER_02), 0, "swap allowance reset");
        _assertRouterEmpty();
    }

    function test_fork_swapAndBuyWithNativeEth() public onlyForked {
        vm.deal(buyer, 1 ether);

        vm.prank(buyer);
        uint256 amountIn = router.swapAndBuy{value: 1 ether}(WETH, 1 ether, _wethPath(), seriesId, MAX_CLAIM);

        assertGt(amountIn, 0, "swap consumed nothing");
        assertEq(buyer.balance, 0, "eth fully wrapped");
        assertEq(token.balanceOf(buyer, seriesId), MAX_CLAIM, "cover minted to buyer");
        assertEq(IERC20(USDC).balanceOf(address(pool)), uint256(CAP) + PREMIUM, "premium in pool");
        assertEq(IERC20(WETH).balanceOf(buyer), 1 ether - amountIn, "dust refunded in WETH");
        _assertRouterEmpty();
    }

    function test_fork_swapAndBuyWithArbMultihop() public onlyForked {
        deal(ARB, buyer, 5_000e18);
        vm.prank(buyer);
        IERC20(ARB).approve(address(router), 5_000e18);

        vm.prank(buyer);
        uint256 amountIn = router.swapAndBuy(ARB, 5_000e18, _arbPath(), seriesId, MAX_CLAIM);

        assertGt(amountIn, 0, "swap consumed nothing");
        assertLt(amountIn, 5_000e18, "no dust to refund");
        assertEq(token.balanceOf(buyer, seriesId), MAX_CLAIM, "cover minted to buyer");
        assertEq(IERC20(USDC).balanceOf(address(pool)), uint256(CAP) + PREMIUM, "premium in pool");
        assertEq(IERC20(ARB).balanceOf(buyer), 5_000e18 - amountIn, "dust refunded");
        _assertRouterEmpty();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Failure paths
    // ─────────────────────────────────────────────────────────────────────────

    function test_fork_slippageRevertsAtomically() public onlyForked {
        _wrap(buyer, 1 ether);
        bytes memory path = _wethPath();

        // 1e13 wei of WETH cannot buy a 142.5 USDC premium on any real pool.
        vm.prank(buyer);
        vm.expectRevert();
        router.swapAndBuy(WETH, 1e13, path, seriesId, MAX_CLAIM);

        assertEq(IERC20(WETH).balanceOf(buyer), 1 ether, "nothing spent");
        assertEq(token.balanceOf(buyer, seriesId), 0, "nothing minted");
        assertEq(pool.series(seriesId).sold, 0, "nothing sold");
        assertEq(IERC20(USDC).balanceOf(address(pool)), CAP, "no premium taken");
        _assertRouterEmpty();
    }

    function test_fork_pausedSeriesRevertsWithoutSpending() public onlyForked {
        vm.prank(creator);
        pool.setSeriesPaused(seriesId, true);
        _wrap(buyer, 1 ether);
        bytes memory path = _wethPath();

        vm.prank(buyer);
        vm.expectRevert(CoverPool.SalesArePaused.selector);
        router.swapAndBuy(WETH, 1 ether, path, seriesId, MAX_CLAIM);

        assertEq(IERC20(WETH).balanceOf(buyer), 1 ether, "nothing spent");
        assertEq(token.balanceOf(buyer, seriesId), 0, "nothing minted");
        assertEq(IERC20(USDC).balanceOf(address(pool)), CAP, "no premium taken");
        _assertRouterEmpty();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Real email on Nitro: oracle bytecode + full lifecycle
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice The pinned-key DKIM verification (RSA-2048 via modexp 0x05) runs on
    ///         Arbitrum Nitro: the real 2026-09-17 CRE Daily email verifies end to end
    ///         on the fork, with the same provenance V1 asserted on Gnosis.
    function test_fork_oracleVerifiesRealEmailOnArbitrum() public onlyForked {
        bytes memory headers = vm.readFileBinary("fixtures/credaily-2026-09-17/signed-headers.bin");
        bytes memory body = vm.readFileBinary("fixtures/credaily-2026-09-17/canon-body.bin");
        bytes memory sig = vm.readFileBinary("fixtures/credaily-2026-09-17/sig.bin");

        oracle.submitObservation(headers, body, sig);

        assertEq(oracle.observationCount(), 1);
        (uint64 t, uint32 cents, bytes32 emailId) = oracle.observations(0);
        assertEq(t, REAL_T, "t");
        assertEq(cents, REAL_CENTS, "cents");
        assertEq(emailId, sha256(body), "emailId == bh32");
        assertTrue(oracle.recorded(emailId));
    }

    /// @notice Full real-email lifecycle against the pool on the Arbitrum fork, in
    ///         6-dec USDC units: a series created BEFORE the fixture's signed `t`
    ///         (saleEnd ≤ obsStart is on-chain now), buy → oracle submit → settle at
    ///         ratio 0.61e18 → redeem 61% → creator residual withdrawal. Mirrors the
    ///         (mock-currency) unit lifecycle in
    ///         {RealEmailTest.test_fullLifecycle_ratio61_buyRedeemResidual}.
    function test_fork_fullLifecycle_realEmail_ratio61() public onlyForked {
        bytes memory headers = vm.readFileBinary("fixtures/credaily-2026-09-17/signed-headers.bin");
        bytes memory body = vm.readFileBinary("fixtures/credaily-2026-09-17/canon-body.bin");
        bytes memory sig = vm.readFileBinary("fixtures/credaily-2026-09-17/sig.bin");

        // Rewind the fork clock to before the fixture's signed t: the series must be
        // created (and bought) before its observation window opens.
        vm.warp(REAL_T - 2 days);
        uint64 obsStartReal = REAL_T - 1 days;
        uint64 redeemEndReal = REAL_T + 30 days;
        deal(USDC, creator, CAP);
        vm.startPrank(creator);
        IERC20(USDC).approve(address(pool), CAP);
        uint256 realSeries = pool.createSeries(
            LOW,
            HIGH,
            RATE,
            obsStartReal, // saleEnd == obsStart: open now, shut before the email lands
            obsStartReal,
            REAL_T + 1 days,
            redeemEndReal,
            CAP
        );
        vm.stopPrank();

        // buyer takes 500 USDC of max claim during the sale (premium 28.5%)
        deal(USDC, buyer, PREMIUM);
        vm.startPrank(buyer);
        IERC20(USDC).approve(address(pool), PREMIUM);
        pool.buyProtection(realSeries, MAX_CLAIM, PREMIUM);
        vm.stopPrank();
        assertEq(token.balanceOf(buyer, realSeries), MAX_CLAIM);
        assertEq(pool.series(realSeries).sold, uint128(MAX_CLAIM), "sold accounted");

        // the real email settles the series: (9288-8800)/(9600-8800) = 0.61
        vm.warp(REAL_T); // the email's own signing time
        oracle.submitObservation(headers, body, sig);
        pool.settle(realSeries, 0);
        CoverPool.Series memory s = pool.series(realSeries);
        assertTrue(s.settled);
        assertEq(s.payoutRatioWad, 0.61e18, "ratio");
        assertEq(s.observationT, REAL_T);
        assertEq(s.emailId, sha256(body));

        // second settle attempt: one-shot
        vm.expectRevert(CoverPool.AlreadySettled.selector);
        pool.settle(realSeries, 0);

        // redeem pays 61% in 6-dec units
        uint256 owed = (MAX_CLAIM * 0.61e18) / 1e18; // 305 USDC
        vm.prank(buyer);
        pool.redeem(realSeries, MAX_CLAIM);
        assertEq(IERC20(USDC).balanceOf(buyer), owed, "payout = 61%");
        assertEq(token.balanceOf(buyer, realSeries), 0);
        assertEq(pool.series(realSeries).paidOut, owed, "fully redeemed");

        // creator residual: escrow + premium − payout, once the claim window shuts
        vm.warp(redeemEndReal + 1);
        vm.prank(creator);
        pool.withdrawResidual(realSeries);
        assertEq(IERC20(USDC).balanceOf(creator), uint256(CAP) + PREMIUM - owed, "residual math");
        assertEq(IERC20(USDC).balanceOf(address(pool)), CAP, "only the setUp series escrow remains");
    }
}
