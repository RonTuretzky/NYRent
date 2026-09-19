// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {HookMiner} from "@uniswap/v4-periphery/src/utils/HookMiner.sol";
import {IObservationOracle} from "../../src/interfaces/IObservationOracle.sol";
import {CredailyRentOracle} from "../../src/CredailyRentOracle.sol";
import {CredailyKey} from "../../src/gen/CredailyKey.sol";
import {RentV4Market} from "../../src/v4/RentV4Market.sol";
import {RentV4Factory} from "../../src/v4/RentV4Factory.sol";
import {RentV4Hook} from "../../src/v4/RentV4Hook.sol";
import {RentV4Router} from "../../src/v4/RentV4Router.sol";
import {MockObservationOracle} from "../utils/Helpers.sol";

contract V4TestCurrency is ERC20 {
    uint8 internal immutable _decimals;

    constructor(uint8 decimals_) ERC20("Test dollars", "USD") {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }
}

abstract contract RentV4TestBase is Test {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;
    IPoolManager internal manager;
    V4TestCurrency internal currency;
    MockObservationOracle internal oracle;
    RentV4Factory internal factory;
    RentV4Hook internal hook;
    RentV4Router internal router;
    RentV4Market internal market;
    address internal alice = makeAddr("insurer alice");
    address internal bob = makeAddr("insurer bob");
    address internal buyer = makeAddr("renter");
    uint128 internal constant UNIT = 1e6;
    int128 internal constant SEED_LIQUIDITY = 1000e6;
    int24 internal constant LOWER = -887220;
    int24 internal constant UPPER = 887220;
    uint160 internal constant FLAGS = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
        | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG;

    function setUp() public virtual {
        vm.warp(1_790_000_000);
        manager = IPoolManager(address(new PoolManager(address(this))));
        _setupMarket();
    }

    function _setupMarket() internal {
        currency = new V4TestCurrency(6);
        oracle = new MockObservationOracle();
        oracle.push(uint64(block.timestamp - 1 days), 9288, bytes32("authenticated test base"));
        factory = _factory(manager, currency, oracle);
        hook = factory.hook();
        router = new RentV4Router(factory);
        market = RentV4Market(factory.createMarket(_terms(), uint160(1 << 96)));
        _fund(alice, 10_000 * UNIT);
        _fund(bob, 5_000 * UNIT);
        currency.mint(buyer, 10_000 * UNIT);
        vm.startPrank(buyer);
        currency.approve(address(router), type(uint256).max);
        market.approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    function _factory(IPoolManager m, IERC20 c, IObservationOracle o) internal returns (RentV4Factory result) {
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        (, bytes32 salt) = HookMiner.find(predicted, FLAGS, type(RentV4Hook).creationCode, abi.encode(m, predicted));
        result = new RentV4Factory(m, c, o, salt);
        assertEq(address(result), predicted);
        assertEq(uint160(address(result.hook())) & Hooks.ALL_HOOK_MASK, FLAGS);
    }

    function _terms() internal view returns (RentV4Market.Terms memory) {
        uint64 sale = uint64(block.timestamp + 7 days);
        return RentV4Market.Terms(0, 9288, 9500, 10500, sale, sale, sale + 30 days, sale + 60 days);
    }

    function _fund(address insurer, uint128 amount) internal {
        currency.mint(insurer, amount * 2);
        vm.startPrank(insurer);
        currency.approve(address(market), type(uint256).max);
        currency.approve(address(router), type(uint256).max);
        market.approve(address(router), type(uint256).max);
        market.depositAndMint(amount, insurer);
        vm.stopPrank();
    }

    function _liquidity(address owner, int128 amount) internal returns (BalanceDelta delta) {
        vm.prank(owner);
        return router.modifyLiquidity(
            RentV4Router.LiquidityRequest(
                address(market),
                LOWER,
                UPPER,
                amount,
                amount > 0 ? type(uint128).max : 0,
                amount > 0 ? type(uint128).max : 0,
                owner,
                block.timestamp
            )
        );
    }

    function _swap(address who, bool buy, uint128 amount) internal returns (uint256 spent, uint256 out) {
        vm.prank(who);
        return router.swapExactInput(RentV4Router.SwapRequest(address(market), buy, amount, 0, 0, who, block.timestamp));
    }

    function _settle(uint32 cents) internal {
        vm.warp(market.obsStart());
        uint256 index = oracle.push(uint64(block.timestamp), cents, bytes32("settlement"));
        market.settle(index);
    }

    function _redeemAll(address who) internal returns (uint256 paid) {
        uint256 amount = market.balanceOf(who);
        if (amount != 0) {
            vm.prank(who);
            paid = market.redeem(amount, who);
        }
    }

    function _lifecycle(uint32 cents, uint256 ratio) internal {
        _liquidity(alice, SEED_LIQUIDITY);
        (uint256 spent, uint256 bought) = _swap(buyer, true, 100 * UNIT);
        assertEq(spent, 100 * UNIT);
        assertGt(bought, 0);
        assertEq(market.balanceOf(buyer), bought);
        (, uint256 soldFor) = _swap(buyer, false, uint128(bought / 2));
        assertGt(soldFor, 0);
        assertEq(market.residualShares(buyer), 0);

        vm.warp(market.obsStart());
        vm.expectRevert();
        _swap(buyer, true, UNIT);
        vm.expectRevert();
        _liquidity(alice, -SEED_LIQUIDITY);
        vm.prank(buyer);
        vm.expectRevert(RentV4Market.TransfersLocked.selector);
        market.transfer(bob, 1);

        _settle(cents);
        assertEq(market.payoutRatioWad(), ratio);
        _liquidity(alice, -SEED_LIQUIDITY);
        assertEq(router.liquidityOf(alice, address(market), LOWER, UPPER), 0);
        uint256 paid = _redeemAll(alice) + _redeemAll(bob) + _redeemAll(buyer);
        assertEq(market.paidOut(), paid);
        // AMM integer rounding can leave < a few units in singleton after full LP removal.
        assertLe(market.totalSupply(), 3);
        vm.expectRevert();
        _swap(buyer, true, UNIT);

        vm.warp(market.redeemEnd() + 1);
        uint256 residual = market.totalDeposited() - paid;
        uint256 aliceEntitlement = residual * 2 / 3;
        uint256 bobEntitlement = residual / 3;
        vm.prank(bob);
        assertEq(market.withdrawResidual(bob), bobEntitlement);
        vm.prank(alice);
        assertEq(market.withdrawResidual(alice), aliceEntitlement);
        assertEq(currency.balanceOf(address(market)), residual - aliceEntitlement - bobEntitlement);
        assertEq(market.escrowAccounted(), currency.balanceOf(address(market)));
        assertLe(currency.balanceOf(address(market)), 1);
    }
}

contract RentV4LifecycleTest is RentV4TestBase {
    function test_realPoolManager_buySellFreezeSettleRedeemResidual_zero() public {
        _lifecycle(9500, 0);
    }

    function test_realPoolManager_buySellFreezeSettleRedeemResidual_half() public {
        _lifecycle(10000, 0.5e18);
    }

    function test_realPoolManager_buySellFreezeSettleRedeemResidual_full() public {
        _lifecycle(10500, 1e18);
    }

    function test_multipleInsurersOwnSeparateLpPositions() public {
        _liquidity(alice, SEED_LIQUIDITY);
        _liquidity(bob, SEED_LIQUIDITY / 2);
        _swap(buyer, true, 100 * UNIT);
        _liquidity(bob, -SEED_LIQUIDITY / 2);
        assertEq(router.liquidityOf(alice, address(market), LOWER, UPPER), uint128(SEED_LIQUIDITY));
        vm.expectRevert(RentV4Router.InsufficientLiquidity.selector);
        _liquidity(bob, -1);
        vm.expectRevert(RentV4Router.InsufficientLiquidity.selector);
        _liquidity(buyer, -SEED_LIQUIDITY);
        _liquidity(alice, -SEED_LIQUIDITY);
    }

    function test_noObservationExpiresAndReleasesAllEscrowAndLp() public {
        _liquidity(alice, SEED_LIQUIDITY);
        _swap(buyer, true, UNIT);
        vm.warp(market.redeemEnd());
        vm.expectRevert();
        _liquidity(alice, -SEED_LIQUIDITY);
        vm.expectRevert(RentV4Market.RedemptionStillOpen.selector);
        vm.prank(alice);
        market.withdrawResidual(alice);
        vm.warp(market.redeemEnd() + 1);
        _liquidity(alice, -SEED_LIQUIDITY);
        vm.prank(alice);
        assertEq(market.withdrawResidual(alice), 10_000 * UNIT);
        vm.prank(bob);
        assertEq(market.withdrawResidual(bob), 5_000 * UNIT);
        assertEq(currency.balanceOf(address(market)), 0);
        vm.prank(buyer);
        market.transfer(bob, 1);
        vm.expectRevert(RentV4Market.NotSettled.selector);
        vm.prank(buyer);
        market.redeem(1, buyer);
        vm.expectRevert();
        _swap(buyer, true, UNIT);
    }

    function test_exactCutoffAndGapBeforeObservation() public {
        RentV4Market.Terms memory terms = _terms();
        terms.obsStart += 1 days;
        RentV4Market gap = RentV4Market(factory.createMarket(terms, uint160(1 << 96)));
        currency.mint(address(this), 10 * UNIT);
        currency.approve(address(gap), 10 * UNIT);
        gap.depositAndMint(10 * UNIT, address(this));
        vm.warp(gap.saleEnd() - 1);
        assertTrue(gap.tradingOpen());
        vm.warp(gap.saleEnd());
        assertFalse(gap.tradingOpen());
        assertTrue(gap.transfersOpen());
        gap.transfer(buyer, UNIT);
        vm.expectRevert(RentV4Market.TradingClosed.selector);
        gap.depositAndMint(1, address(this));
        vm.warp(gap.obsStart());
        vm.expectRevert(RentV4Market.TransfersLocked.selector);
        gap.transfer(buyer, 1);
    }

    function test_donationsAndRoundingDoNotChangeInsurerEntitlements() public {
        currency.mint(address(market), 123 * UNIT);
        _settle(10000);
        vm.prank(alice);
        market.redeem(1, alice); // zero payout rounding
        vm.prank(alice);
        market.transfer(buyer, 7);
        vm.prank(buyer);
        assertEq(market.redeem(7, buyer), 3);
        vm.warp(market.redeemEnd() + 1);
        uint256 aliceExpected = (15_000 * UNIT - 3) * 2 / 3;
        uint256 bobExpected = (15_000 * UNIT - 3) / 3;
        vm.prank(alice);
        assertEq(market.withdrawResidual(alice), aliceExpected);
        vm.prank(bob);
        assertEq(market.withdrawResidual(bob), bobExpected);
        assertGe(currency.balanceOf(address(market)), 123 * UNIT);
        vm.expectRevert(RentV4Market.NoResidual.selector);
        vm.prank(buyer);
        market.withdrawResidual(buyer);
    }

    function test_settlementOneShotAndExactRedemptionDeadline() public {
        _settle(10000);
        vm.expectRevert(RentV4Market.AlreadySettled.selector);
        market.settle(1);
        vm.warp(market.redeemEnd());
        vm.prank(alice);
        assertEq(market.redeem(2, alice), 1);
        vm.warp(market.redeemEnd() + 1);
        vm.expectRevert(RentV4Market.RedemptionClosed.selector);
        vm.prank(alice);
        market.redeem(2, alice);
    }

    function test_lateSettlementDoesNotReopenClaims() public {
        uint256 index = oracle.push(market.obsStart(), 10500, bytes32("late"));
        vm.warp(market.redeemEnd() + 1);
        vm.prank(alice);
        market.withdrawResidual(alice);
        market.settle(index);
        vm.expectRevert(RentV4Market.RedemptionClosed.selector);
        vm.prank(alice);
        market.redeem(UNIT, alice);
        assertFalse(market.tradingOpen());
    }

    function test_rejectsFutureAndOutOfWindowObservations() public {
        vm.expectRevert(RentV4Market.ObservationOutOfWindow.selector);
        market.settle(0);
        uint256 future = oracle.push(market.obsStart(), 10000, bytes32("future"));
        vm.expectRevert(RentV4Market.ObservationInFuture.selector);
        market.settle(future);
        vm.warp(market.obsStart());
        market.settle(future);
    }

    function test_onlyCollateralMintsAndResidualStaysWithPayer() public {
        vm.prank(alice);
        market.depositAndMint(UNIT, buyer);
        assertEq(market.balanceOf(buyer), UNIT);
        assertEq(market.residualShares(buyer), 0);
        assertEq(market.residualShares(alice), 10_001 * UNIT);
        (bool ok,) = address(market).call(abi.encodeWithSignature("mint(address,uint256)", buyer, UNIT));
        assertFalse(ok);
        assertEq(currency.balanceOf(address(market)), market.totalSupply());
    }

    function testFuzz_redemptionAndResidualConserveCollateral(uint96 amount_, uint32 cents_, uint96 redeem_) public {
        uint256 amount = bound(amount_, 1, 1e24);
        uint32 cents = uint32(bound(cents_, 1, 20000));
        uint256 redeemed = bound(redeem_, 1, amount);
        currency.mint(address(this), amount);
        currency.approve(address(market), amount);
        market.depositAndMint(amount, address(this));
        _settle(cents);
        uint256 payout = market.redeem(redeemed, address(this));
        assertEq(payout, redeemed * market.payoutRatioWad() / 1e18);
        assertLe(market.totalSupply(), currency.balanceOf(address(market)));
        uint256 before = currency.balanceOf(address(market));
        vm.warp(market.redeemEnd() + 1);
        uint256 expected = before * amount / market.totalDeposited();
        assertEq(market.withdrawResidual(address(this)), expected);
        vm.prank(bob);
        market.withdrawResidual(bob);
        vm.prank(alice);
        market.withdrawResidual(alice);
        assertLe(currency.balanceOf(address(market)), 2);
        assertEq(market.paidOut() + market.residualPaid() + market.escrowAccounted(), market.totalDeposited());
    }
}

contract RentV4SecurityTest is RentV4TestBase {
    function test_zeroDeltaFeeCollectionRespectsObservationLock() public {
        _liquidity(alice, SEED_LIQUIDITY);
        _swap(buyer, true, 100 * UNIT);
        uint256 before = currency.balanceOf(alice);
        _liquidity(alice, 0);
        assertGt(currency.balanceOf(alice), before);
        vm.warp(market.obsStart());
        vm.expectRevert();
        _liquidity(alice, 0);
        _settle(10000);
        _liquidity(alice, 0);
        assertEq(router.liquidityOf(alice, address(market), LOWER, UPPER), uint128(SEED_LIQUIDITY));
    }

    function test_partialFillPaysOnlyConsumedInput() public {
        _liquidity(alice, SEED_LIQUIDITY);
        PoolKey memory key = factory.poolKey(address(market));
        bool zeroForOne = Currency.unwrap(key.currency1) == address(market);
        uint160 limit = TickMath.getSqrtPriceAtTick(zeroForOne ? int24(-100) : int24(100));
        uint256 before = currency.balanceOf(buyer);
        vm.prank(buyer);
        (uint256 spent, uint256 received) = router.swapExactInput(
            RentV4Router.SwapRequest(address(market), true, 100 * UNIT, 1, limit, buyer, block.timestamp)
        );
        assertLt(spent, 100 * UNIT);
        assertGt(spent, 0);
        assertEq(before - currency.balanceOf(buyer), spent);
        assertEq(market.balanceOf(buyer), received);
        assertEq(currency.balanceOf(address(router)), 0);
    }

    function test_bothCurrencyOrderingsSupportBuySell() public {
        bool rentFirst;
        bool rentSecond;
        // Pool currency ordering comes from actual fresh deployed addresses, never a mocked AMM.
        for (uint256 i; i < 64 && !(rentFirst && rentSecond); ++i) {
            RentV4Market candidate = RentV4Market(factory.createMarket(_terms(), uint160(1 << 96)));
            PoolKey memory key = factory.poolKey(address(candidate));
            bool first = Currency.unwrap(key.currency0) == address(candidate);
            if (first ? rentFirst : rentSecond) continue;
            currency.mint(address(this), 10_000 * UNIT);
            currency.approve(address(candidate), type(uint256).max);
            currency.approve(address(router), type(uint256).max);
            candidate.approve(address(router), type(uint256).max);
            candidate.depositAndMint(5_000 * UNIT, address(this));
            router.modifyLiquidity(
                RentV4Router.LiquidityRequest(
                    address(candidate),
                    LOWER,
                    UPPER,
                    SEED_LIQUIDITY,
                    type(uint128).max,
                    type(uint128).max,
                    address(this),
                    block.timestamp
                )
            );
            (, uint256 bought) = router.swapExactInput(
                RentV4Router.SwapRequest(address(candidate), true, UNIT, 1, 0, address(this), block.timestamp)
            );
            (, uint256 sold) = router.swapExactInput(
                RentV4Router.SwapRequest(
                    address(candidate), false, uint128(bought), 1, 0, address(this), block.timestamp
                )
            );
            assertGt(sold, 0);
            assertLt(sold, UNIT);
            if (first) rentFirst = true;
            else rentSecond = true;
        }
        assertTrue(rentFirst && rentSecond, "both actual token address orderings exercised");
    }

    function test_factoryAuthenticatesBaseAndImmutableTerms() public {
        RentV4Market.Terms memory terms = _terms();
        terms.baseRentCents++;
        vm.expectRevert(RentV4Market.InvalidTerms.selector);
        factory.createMarket(terms, uint160(1 << 96));
        terms = _terms();
        terms.saleEnd = terms.obsStart + 1;
        vm.expectRevert(RentV4Market.InvalidTerms.selector);
        factory.createMarket(terms, uint160(1 << 96));
        terms = _terms();
        terms.redeemEnd = terms.obsEnd + 7 days - 1;
        vm.expectRevert(RentV4Market.InvalidTerms.selector);
        factory.createMarket(terms, uint160(1 << 96));
        assertEq(market.baseObservationIndex(), 0);
        assertEq(market.baseEmailId(), bytes32("authenticated test base"));
    }

    function test_permissionlessCreateAndAuthenticatedPoolManagerCallbacks() public {
        vm.prank(buyer);
        address next = factory.createMarket(_terms(), uint160(1 << 96));
        assertTrue(factory.isMarket(next));
        PoolKey memory key = factory.poolKey(address(market));
        vm.expectRevert();
        hook.beforeInitialize(address(factory), key, uint160(1 << 96));
        vm.expectRevert(RentV4Hook.OnlyFactory.selector);
        hook.registerMarket(key, market);
        vm.prank(address(manager));
        vm.expectRevert(RentV4Hook.OnlyFactory.selector);
        hook.beforeInitialize(buyer, key, uint160(1 << 96));
        key.tickSpacing = 10;
        vm.prank(address(manager));
        vm.expectRevert(RentV4Hook.UnknownPool.selector);
        hook.beforeSwap(address(router), key, SwapParams(true, -1, 1), "");
        vm.expectRevert();
        manager.initialize(key, uint160(1 << 96));
    }

    function test_wrongCreate2PermissionBitsRevert() public {
        address expected = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        bytes memory code = abi.encodePacked(type(RentV4Hook).creationCode, abi.encode(manager, expected));
        bytes32 salt;
        while (uint160(HookMiner.computeAddress(expected, uint256(salt), code)) & Hooks.ALL_HOOK_MASK == FLAGS) {
            salt = bytes32(uint256(salt) + 1);
        }
        vm.expectRevert();
        new RentV4Factory(manager, currency, oracle, salt);
    }

    function test_routerRejectsFakeCallbacksAndNeverSweepsDonations() public {
        currency.mint(address(router), 500 * UNIT);
        vm.expectRevert(RentV4Router.UnauthorizedCallback.selector);
        router.unlockCallback(abi.encode(alice));
        vm.prank(address(manager));
        vm.expectRevert(RentV4Router.UnauthorizedCallback.selector);
        router.unlockCallback(abi.encode(alice));
        _liquidity(alice, SEED_LIQUIDITY);
        _swap(buyer, true, UNIT);
        assertEq(currency.balanceOf(address(router)), 500 * UNIT);
        assertEq(market.balanceOf(address(router)), 0);
    }

    function test_routerDeadlineAndSwapSlippageAreAtomic() public {
        _liquidity(alice, SEED_LIQUIDITY);
        uint256 before = currency.balanceOf(buyer);
        vm.prank(buyer);
        vm.expectRevert(RentV4Router.Slippage.selector);
        router.swapExactInput(
            RentV4Router.SwapRequest(address(market), true, UNIT, 1000 * UNIT, 0, buyer, block.timestamp)
        );
        assertEq(currency.balanceOf(buyer), before);
        vm.prank(buyer);
        vm.expectRevert(RentV4Router.DeadlineExpired.selector);
        router.swapExactInput(RentV4Router.SwapRequest(address(market), true, UNIT, 0, 0, buyer, block.timestamp - 1));
    }

    function test_liquidityMaxMinAndOwnershipAreAtomic() public {
        vm.prank(alice);
        vm.expectRevert(RentV4Router.Slippage.selector);
        router.modifyLiquidity(
            RentV4Router.LiquidityRequest(address(market), LOWER, UPPER, SEED_LIQUIDITY, 0, 0, alice, block.timestamp)
        );
        assertEq(router.liquidityOf(alice, address(market), LOWER, UPPER), 0);
        _liquidity(alice, SEED_LIQUIDITY);
        vm.prank(alice);
        vm.expectRevert(RentV4Router.Slippage.selector);
        router.modifyLiquidity(
            RentV4Router.LiquidityRequest(
                address(market),
                LOWER,
                UPPER,
                -SEED_LIQUIDITY,
                type(uint128).max,
                type(uint128).max,
                alice,
                block.timestamp
            )
        );
        assertEq(router.liquidityOf(alice, address(market), LOWER, UPPER), uint128(SEED_LIQUIDITY));
    }

    function test_swapAndLpDoNotSpendUnrelatedPayerApprovals() public {
        _liquidity(alice, SEED_LIQUIDITY);
        address attacker = makeAddr("attacker");
        uint256 aliceBefore = currency.balanceOf(alice);
        vm.expectRevert();
        _swap(attacker, true, UNIT);
        assertEq(currency.balanceOf(alice), aliceBefore);
        vm.expectRevert(RentV4Router.InsufficientLiquidity.selector);
        _liquidity(attacker, -SEED_LIQUIDITY);
    }

    function test_dynamicFeeIsBoundedDeterministicAndAuthenticated() public {
        assertEq(hook.currentFee(market), 3000);
        vm.warp(market.saleEnd() - 1);
        uint24 fee = hook.currentFee(market);
        assertGe(fee, 9999);
        assertLe(fee, 10000);
        PoolKey memory key = factory.poolKey(address(market));
        vm.prank(address(manager));
        (,, uint24 overrideFee) = hook.beforeSwap(address(router), key, SwapParams(true, -1, 1), "");
        assertEq(overrideFee, fee | LPFeeLibrary.OVERRIDE_FEE_FLAG);
        vm.warp(market.saleEnd());
        vm.prank(address(manager));
        vm.expectRevert(RentV4Hook.TradingClosed.selector);
        hook.beforeSwap(address(router), key, SwapParams(true, -1, 1), "");
    }

    function test_18DecimalCollateralMatchesRentUnits() public {
        V4TestCurrency eighteen = new V4TestCurrency(18);
        RentV4Factory f = _factory(manager, eighteen, oracle);
        RentV4Market m = RentV4Market(f.createMarket(_terms(), uint160(1 << 96)));
        assertEq(m.decimals(), 18);
        eighteen.mint(address(this), 3 ether);
        eighteen.approve(address(m), 3 ether);
        m.depositAndMint(3 ether, address(this));
        vm.warp(m.obsStart());
        uint256 index = oracle.push(m.obsStart(), 10000, bytes32("half"));
        m.settle(index);
        assertEq(m.redeem(3 ether, address(this)), 1.5 ether);
        vm.warp(m.redeemEnd() + 1);
        assertEq(m.withdrawResidual(address(this)), 1.5 ether);
        assertEq(eighteen.balanceOf(address(m)), 0);
    }

    function test_realDkimBaselineVerifiedAndCannotBeReusedAsFutureSettlement() public {
        vm.warp(1789642464);
        CredailyRentOracle signedOracle = new CredailyRentOracle(CredailyKey.MODULUS);
        signedOracle.submitObservation(
            vm.readFileBinary("fixtures/credaily-2026-09-17/signed-headers.bin"),
            vm.readFileBinary("fixtures/credaily-2026-09-17/canon-body.bin"),
            vm.readFileBinary("fixtures/credaily-2026-09-17/sig.bin")
        );
        RentV4Factory f = _factory(manager, currency, IObservationOracle(address(signedOracle)));
        RentV4Market m = RentV4Market(f.createMarket(_terms(), uint160(1 << 96)));
        assertEq(m.baseRentCents(), 9288);
        assertEq(m.baseObservationT(), 1789642464);
        assertEq(m.baseEmailId(), sha256(vm.readFileBinary("fixtures/credaily-2026-09-17/canon-body.bin")));
        vm.expectRevert(RentV4Market.ObservationOutOfWindow.selector);
        m.settle(0);
    }
}
