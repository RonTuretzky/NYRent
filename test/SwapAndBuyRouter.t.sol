// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CoverToken} from "../src/CoverToken.sol";
import {ICoverPool, ISwapRouter02, SwapAndBuyRouter} from "../src/SwapAndBuyRouter.sol";

/// @notice Mintable 6-decimals ERC-20 standing in for Arbitrum-native USDC.
contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin (test)", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Mintable WETH9 stand-in: `deposit()` wraps `msg.value` 1:1.
contract MockWETH9 is ERC20 {
    constructor() ERC20("Wrapped Ether (test)", "WETH") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }
}

/// @notice SwapRouter02 stand-in with a fixed exact-output price: consumes
///         `amountOut × amountInPerOut / 1e18` of the path's tokenIn and pays
///         `amountOut` of the path's tokenOut from pre-minted reserves. Reverts with
///         SwapRouter02's own "Too much requested" when the bound is exceeded.
contract MockSwapRouter02 is ISwapRouter02 {
    address internal immutable _weth9;

    /// @notice tokenIn wei consumed per tokenOut wei, 1e18-scaled.
    uint256 public amountInPerOut;

    constructor(address weth9_) {
        _weth9 = weth9_;
    }

    function setAmountInPerOut(uint256 value) external {
        amountInPerOut = value;
    }

    function WETH9() external view returns (address) {
        return _weth9;
    }

    function exactOutput(ExactOutputParams calldata params) external payable returns (uint256 amountIn) {
        address tokenOut = address(bytes20(params.path[:20]));
        address tokenIn = address(bytes20(params.path[params.path.length - 20:]));
        amountIn = (params.amountOut * amountInPerOut) / 1e18;
        require(amountIn <= params.amountInMaximum, "Too much requested");
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenOut).transfer(params.recipient, params.amountOut);
    }
}

/// @notice Pool stand-in for router unit tests: exposes the currency, quotes at a
///         settable rate, pulls the premium, and mints a real (soulbound) {CoverToken}
///         to the recipient — the exact `currency`/`quote`/`buyProtectionFor` surface
///         the router is built against.
contract MockCoverPool is ICoverPool {
    using SafeERC20 for IERC20;

    error SalesArePaused();
    error PremiumTooHigh(uint256 premium, uint256 maxPremium);

    IERC20 public immutable usdc;
    CoverToken public immutable token;

    uint16 public rateBps;
    bool public salesPaused;

    constructor(IERC20 usdc_, uint16 rateBps_) {
        usdc = usdc_;
        rateBps = rateBps_;
        token = new CoverToken(address(this), 6);
    }

    function currency() external view returns (address) {
        return address(usdc);
    }

    function setRateBps(uint16 value) external {
        rateBps = value;
    }

    function setSalesPaused(bool paused) external {
        salesPaused = paused;
    }

    function quote(uint256, uint256 maxClaim)
        external
        view
        returns (uint256 premium, uint16 rateBps_, uint256 capacityLeft, uint256 issuableNow)
    {
        premium = (maxClaim * rateBps) / 1e4;
        rateBps_ = rateBps;
        capacityLeft = type(uint128).max;
        issuableNow = type(uint128).max;
    }

    function buyProtectionFor(uint256 seriesId, uint256 maxClaim, uint256 maxPremium, address recipient) external {
        if (salesPaused) revert SalesArePaused();
        uint256 premium = (maxClaim * rateBps) / 1e4;
        if (premium > maxPremium) revert PremiumTooHigh(premium, maxPremium);
        usdc.safeTransferFrom(msg.sender, address(this), premium);
        token.mint(recipient, seriesId, maxClaim);
    }
}

/// @notice ERC-20 whose `transferFrom` re-enters {SwapAndBuyRouter.swapAndBuy}, to
///         prove the guard rejects reentry through the token pull.
contract ReentrantToken is ERC20 {
    SwapAndBuyRouter internal immutable _router;

    constructor(SwapAndBuyRouter router_) ERC20("Reentrant (test)", "REENT") {
        _router = router_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transferFrom(address, address, uint256) public override returns (bool) {
        _router.swapAndBuy(address(this), 1, "", 0, 1); // guard must trip before any check
        return true;
    }
}

/// @notice SwapAndBuyRouter unit matrix against mocks: pull/wrap, exact-output swap,
///         recipient minting, dust + stray-balance sweeps, path and native-value
///         validation, atomic reverts, and the reentrancy guard. The Arbitrum fork
///         suite in {RouterForkTest} proves the same flows against real Uniswap pools.
contract SwapAndBuyRouterTest is Test {
    uint16 internal constant RATE = 2850;
    uint256 internal constant SERIES = 7;
    uint256 internal constant MAX_CLAIM = 500e6; // 500 USDC of max claim (6 decimals)
    uint256 internal constant PREMIUM = 142_500_000; // MAX_CLAIM × 2850 / 1e4

    /// @dev 3.5e8 WETH-wei per USDC-wei ⇒ the 142.5-USDC premium costs ~0.0499 WETH.
    uint256 internal constant PRICE = 3.5e26;

    MockUSDC internal usdc;
    MockWETH9 internal weth;
    MockSwapRouter02 internal swapRouter;
    MockCoverPool internal pool;
    SwapAndBuyRouter internal router;

    address internal alice = makeAddr("alice");

    function setUp() public {
        usdc = new MockUSDC();
        weth = new MockWETH9();
        swapRouter = new MockSwapRouter02(address(weth));
        swapRouter.setAmountInPerOut(PRICE);
        pool = new MockCoverPool(usdc, RATE);
        router = new SwapAndBuyRouter(ISwapRouter02(address(swapRouter)), ICoverPool(address(pool)));

        usdc.mint(address(swapRouter), 1_000_000e6); // swap reserves
        weth.mint(alice, 10 ether);
        vm.prank(alice);
        weth.approve(address(router), type(uint256).max);
    }

    function _path() internal view returns (bytes memory) {
        return abi.encodePacked(address(usdc), uint24(500), address(weth));
    }

    function _assertRouterEmpty() internal view {
        assertEq(weth.balanceOf(address(router)), 0, "router weth");
        assertEq(usdc.balanceOf(address(router)), 0, "router usdc");
        assertEq(address(router).balance, 0, "router eth");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────────────────

    function test_constructor_readsWiringFromPoolAndSwapRouter() public view {
        assertEq(router.weth9(), address(weth));
        assertEq(address(router.swapRouter()), address(swapRouter));
        assertEq(address(router.pool()), address(pool));
        // the currency is read from pool.currency(), never passed as a parameter
        assertEq(address(router.usdc()), pool.currency());
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Happy paths
    // ─────────────────────────────────────────────────────────────────────────

    function test_swapAndBuy_mintsToCallerAndRefundsDust() public {
        uint256 expectedIn = (PREMIUM * PRICE) / 1e18;

        vm.expectEmit(true, true, true, true, address(router));
        emit SwapAndBuyRouter.SwappedAndBought(SERIES, alice, address(weth), expectedIn, PREMIUM, MAX_CLAIM);
        vm.prank(alice);
        uint256 amountIn = router.swapAndBuy(address(weth), 1 ether, _path(), SERIES, MAX_CLAIM);

        assertEq(amountIn, expectedIn);
        assertEq(pool.token().balanceOf(alice, SERIES), MAX_CLAIM, "cover minted to caller");
        assertEq(usdc.balanceOf(address(pool)), PREMIUM, "premium in pool");
        assertEq(weth.balanceOf(alice), 10 ether - expectedIn, "dust refunded");
        assertEq(weth.allowance(address(router), address(swapRouter)), 0, "swap allowance reset");
        _assertRouterEmpty();
    }

    function test_swapAndBuy_nativeEthWrapsAndRefundsWeth() public {
        address bob = makeAddr("bob");
        vm.deal(bob, 1 ether);
        uint256 expectedIn = (PREMIUM * PRICE) / 1e18;

        vm.prank(bob);
        uint256 amountIn = router.swapAndBuy{value: 1 ether}(address(weth), 1 ether, _path(), SERIES, MAX_CLAIM);

        assertEq(amountIn, expectedIn);
        assertEq(pool.token().balanceOf(bob, SERIES), MAX_CLAIM, "cover minted to caller");
        assertEq(bob.balance, 0, "eth fully wrapped");
        assertEq(weth.balanceOf(bob), 1 ether - expectedIn, "dust refunded in WETH");
        _assertRouterEmpty();
    }

    function test_swapAndBuy_zeroPremiumSkipsSwapAndRefundsAll() public {
        pool.setRateBps(0);

        vm.prank(alice);
        uint256 amountIn = router.swapAndBuy(address(weth), 1 ether, _path(), SERIES, MAX_CLAIM);

        assertEq(amountIn, 0, "no swap");
        assertEq(pool.token().balanceOf(alice, SERIES), MAX_CLAIM, "cover minted to caller");
        assertEq(usdc.balanceOf(address(pool)), 0, "no premium due");
        assertEq(weth.balanceOf(alice), 10 ether, "full refund");
        _assertRouterEmpty();
    }

    function test_swapAndBuy_sweepsStrayBalancesToCaller() public {
        weth.mint(address(router), 0.5 ether); // stranded donations
        usdc.mint(address(router), 25e6);
        uint256 expectedIn = (PREMIUM * PRICE) / 1e18;

        vm.prank(alice);
        router.swapAndBuy(address(weth), 1 ether, _path(), SERIES, MAX_CLAIM);

        assertEq(weth.balanceOf(alice), 10 ether - expectedIn + 0.5 ether, "dust + stray weth swept");
        assertEq(usdc.balanceOf(alice), 25e6, "stray usdc swept");
        _assertRouterEmpty();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Validation
    // ─────────────────────────────────────────────────────────────────────────

    function test_swapAndBuy_zeroAmountsRevert() public {
        vm.expectRevert(SwapAndBuyRouter.ZeroAmount.selector);
        vm.prank(alice);
        router.swapAndBuy(address(weth), 1 ether, _path(), SERIES, 0);

        vm.expectRevert(SwapAndBuyRouter.ZeroAmount.selector);
        vm.prank(alice);
        router.swapAndBuy(address(weth), 0, _path(), SERIES, MAX_CLAIM);
    }

    function test_swapAndBuy_pathValidation() public {
        vm.expectRevert(abi.encodeWithSelector(SwapAndBuyRouter.InvalidPath.selector, "length"));
        vm.prank(alice);
        router.swapAndBuy(address(weth), 1 ether, abi.encodePacked(address(usdc), uint24(500)), SERIES, MAX_CLAIM);

        vm.expectRevert(abi.encodeWithSelector(SwapAndBuyRouter.InvalidPath.selector, "length"));
        vm.prank(alice);
        router.swapAndBuy(address(weth), 1 ether, abi.encodePacked(_path(), uint8(1)), SERIES, MAX_CLAIM);

        bytes memory wrongOut = abi.encodePacked(address(weth), uint24(500), address(weth));
        vm.expectRevert(abi.encodeWithSelector(SwapAndBuyRouter.InvalidPath.selector, "tokenOut"));
        vm.prank(alice);
        router.swapAndBuy(address(weth), 1 ether, wrongOut, SERIES, MAX_CLAIM);

        bytes memory wrongIn = abi.encodePacked(address(usdc), uint24(500), address(usdc));
        vm.expectRevert(abi.encodeWithSelector(SwapAndBuyRouter.InvalidPath.selector, "tokenIn"));
        vm.prank(alice);
        router.swapAndBuy(address(weth), 1 ether, wrongIn, SERIES, MAX_CLAIM);
    }

    function test_swapAndBuy_nativeValidation() public {
        address bob = makeAddr("bob");
        vm.deal(bob, 2 ether);

        bytes memory usdcPath = abi.encodePacked(address(usdc), uint24(500), address(usdc));
        vm.expectRevert(SwapAndBuyRouter.NativeInputNotWeth.selector);
        vm.prank(bob);
        router.swapAndBuy{value: 1 ether}(address(usdc), 1 ether, usdcPath, SERIES, MAX_CLAIM);

        vm.expectRevert(abi.encodeWithSelector(SwapAndBuyRouter.NativeValueMismatch.selector, 1 ether, 2 ether));
        vm.prank(bob);
        router.swapAndBuy{value: 1 ether}(address(weth), 2 ether, _path(), SERIES, MAX_CLAIM);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Atomicity
    // ─────────────────────────────────────────────────────────────────────────

    function test_swapAndBuy_slippageRevertsAtomically() public {
        swapRouter.setAmountInPerOut(PRICE * 100); // premium now costs ~4.99 WETH > 1 max

        vm.expectRevert("Too much requested");
        vm.prank(alice);
        router.swapAndBuy(address(weth), 1 ether, _path(), SERIES, MAX_CLAIM);

        assertEq(weth.balanceOf(alice), 10 ether, "nothing spent");
        assertEq(pool.token().balanceOf(alice, SERIES), 0, "nothing minted");
        _assertRouterEmpty();
    }

    function test_swapAndBuy_pausedPoolRevertsWithoutSpending() public {
        pool.setSalesPaused(true);

        vm.expectRevert(MockCoverPool.SalesArePaused.selector);
        vm.prank(alice);
        router.swapAndBuy(address(weth), 1 ether, _path(), SERIES, MAX_CLAIM);

        assertEq(weth.balanceOf(alice), 10 ether, "nothing spent");
        assertEq(pool.token().balanceOf(alice, SERIES), 0, "nothing minted");
        _assertRouterEmpty();
    }

    function test_swapAndBuy_reentrancyGuard() public {
        ReentrantToken evil = new ReentrantToken(router);
        bytes memory path = abi.encodePacked(address(usdc), uint24(500), address(evil));

        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        vm.prank(alice);
        router.swapAndBuy(address(evil), 1 ether, path, SERIES, MAX_CLAIM);
    }
}
