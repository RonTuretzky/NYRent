// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {RentV4TestBase} from "./RentV4.t.sol";
import {RentV4Market} from "../../src/v4/RentV4Market.sol";
import {RentV4Factory} from "../../src/v4/RentV4Factory.sol";
import {RentV4Router} from "../../src/v4/RentV4Router.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";

contract AdversarialCurrency is ERC20 {
    bool public chargeFee;
    address public callbackTarget;
    bytes internal callbackData;
    bool public callbackSucceeded;
    bytes4 public callbackError;
    constructor() ERC20("Adversarial test dollar", "BAD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setFee(bool value) external {
        chargeFee = value;
    }

    function setCallback(address target, bytes calldata data) external {
        callbackTarget = target;
        callbackData = data;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        super.transferFrom(from, to, amount);
        if (chargeFee) _burn(to, 1);
        _callback();
        return true;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        super.transfer(to, amount);
        _callback();
        return true;
    }

    function _callback() internal {
        if (callbackTarget == address(0)) return;
        bytes memory data;
        (callbackSucceeded, data) = callbackTarget.call(callbackData);
        if (data.length >= 4) callbackError = bytes4(data);
    }
}

contract RentV4AdversarialTest is RentV4TestBase {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    function test_feeOnTransferDepositCannotMintUnbackedRent() public {
        AdversarialCurrency c = new AdversarialCurrency();
        RentV4Market m = new RentV4Market(c, oracle, 6, _terms());
        c.mint(address(this), UNIT);
        c.approve(address(m), UNIT);
        c.setFee(true);
        vm.expectRevert(RentV4Market.UnsupportedCurrency.selector);
        m.depositAndMint(UNIT, address(this));
        assertEq(m.totalSupply(), 0);
        assertEq(m.totalDeposited(), 0);
        assertEq(m.residualShares(address(this)), 0);
        assertEq(c.balanceOf(address(m)), 0);
        assertEq(c.balanceOf(address(this)), UNIT);
    }

    function test_currencyCallbacksCannotReenterDepositRedeemOrResidual() public {
        AdversarialCurrency c = new AdversarialCurrency();
        RentV4Market m = new RentV4Market(c, oracle, 6, _terms());
        c.mint(address(this), UNIT);
        c.approve(address(m), UNIT);
        c.setCallback(address(m), abi.encodeCall(m.depositAndMint, (1, address(this))));
        m.depositAndMint(UNIT, address(this));
        assertFalse(c.callbackSucceeded());
        assertEq(c.callbackError(), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        vm.warp(m.obsStart());
        m.settle(oracle.push(m.obsStart(), 10000, bytes32("half")));
        c.setCallback(address(m), abi.encodeCall(m.redeem, (1, address(this))));
        m.redeem(UNIT, address(this));
        assertFalse(c.callbackSucceeded());
        assertEq(c.callbackError(), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        vm.warp(m.redeemEnd() + 1);
        c.setCallback(address(m), abi.encodeCall(m.withdrawResidual, (address(this))));
        m.withdrawResidual(address(this));
        assertFalse(c.callbackSucceeded());
        assertEq(c.callbackError(), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(c.balanceOf(address(this)), UNIT);
    }

    function test_routerTokenCallbackCannotReplaceAuthorizedPayer() public {
        AdversarialCurrency c = new AdversarialCurrency();
        RentV4Factory f = _factory(manager, c, oracle);
        RentV4Router r = new RentV4Router(f);
        RentV4Market m = RentV4Market(f.createMarket(_terms(), uint160(1 << 96)));
        c.mint(address(this), 10000 * UNIT);
        c.approve(address(m), type(uint256).max);
        c.approve(address(r), type(uint256).max);
        m.approve(address(r), type(uint256).max);
        m.depositAndMint(5000 * UNIT, address(this));
        r.modifyLiquidity(
            RentV4Router.LiquidityRequest(
                address(m),
                LOWER,
                UPPER,
                SEED_LIQUIDITY,
                type(uint128).max,
                type(uint128).max,
                address(this),
                block.timestamp
            )
        );
        RentV4Router.SwapRequest memory request =
            RentV4Router.SwapRequest(address(m), true, UNIT, 1, 0, address(this), block.timestamp);
        c.setCallback(address(r), abi.encodeCall(r.swapExactInput, (request)));
        (uint256 spent,) = r.swapExactInput(request);
        assertEq(spent, UNIT);
        assertFalse(c.callbackSucceeded());
        assertEq(c.callbackError(), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(c.balanceOf(address(r)), 0);
        assertEq(m.balanceOf(address(r)), 0);
    }

    function test_routerRejectsFeeOnTransferDebtAtomically() public {
        AdversarialCurrency c = new AdversarialCurrency();
        RentV4Factory f = _factory(manager, c, oracle);
        RentV4Router r = new RentV4Router(f);
        RentV4Market m = RentV4Market(f.createMarket(_terms(), uint160(1 << 96)));
        c.mint(address(this), 10000 * UNIT);
        c.approve(address(m), type(uint256).max);
        c.approve(address(r), type(uint256).max);
        m.approve(address(r), type(uint256).max);
        m.depositAndMint(5000 * UNIT, address(this));
        r.modifyLiquidity(
            RentV4Router.LiquidityRequest(
                address(m),
                LOWER,
                UPPER,
                SEED_LIQUIDITY,
                type(uint128).max,
                type(uint128).max,
                address(this),
                block.timestamp
            )
        );
        c.setFee(true);
        uint256 before = c.balanceOf(address(this));
        vm.expectRevert(RentV4Router.CurrencySettlementMismatch.selector);
        r.swapExactInput(RentV4Router.SwapRequest(address(m), true, UNIT, 1, 0, address(this), block.timestamp));
        assertEq(c.balanceOf(address(this)), before);
    }

    function test_frontendFullRangeConstantsMatchUpstreamAndLimits() public {
        uint160 lower = TickMath.getSqrtPriceAtTick(LOWER);
        uint160 upper = TickMath.getSqrtPriceAtTick(UPPER);
        assertEq(lower, 4306310044);
        assertEq(upper, 1457652066949847389969617340386294118487833376468);
        PoolKey memory key = factory.poolKey(address(market));
        (uint160 price,,,) = manager.getSlot0(key.toId());
        uint128 max0 = 100 * UNIT;
        uint128 max1 = 200 * UNIT;
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(price, lower, upper, max0 - 1, max1 - 1);
        liquidity = liquidity * 99 / 100;
        vm.prank(alice);
        router.modifyLiquidity(
            RentV4Router.LiquidityRequest(
                address(market), LOWER, UPPER, int128(liquidity), max0, max1, alice, block.timestamp
            )
        );
        assertEq(router.liquidityOf(alice, address(market), LOWER, UPPER), liquidity);
    }
}
