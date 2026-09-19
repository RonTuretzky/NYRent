// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {RentV4Market} from "./RentV4Market.sol";

/// @notice Immutable, noncustodial v4 gates for the factory's authenticated market pools.
/// @dev Factory registers and initializes atomically. All lifecycle callbacks authenticate PoolManager
///      via upstream BaseHook, then the complete PoolKey via its PoolId. No public fee setter exists.
contract RentV4Hook is BaseHook {
    using PoolIdLibrary for PoolKey;
    uint160 public constant FLAGS = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
        | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG;
    uint24 public constant BASE_FEE = 3_000; // 0.30%, in v4's millionths
    uint24 public constant MAX_FEE = 10_000; // 1.00% immediately before trading closes
    address public immutable factory;
    mapping(PoolId id => RentV4Market market) public marketForPool;

    error OnlyFactory();
    error UnknownPool();
    error InvalidRegistration();
    error TradingClosed();
    error LiquidityLocked();

    constructor(IPoolManager manager_, address factory_) BaseHook(manager_) {
        if (factory_ == address(0)) revert InvalidRegistration();
        factory = factory_;
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory p) {
        p.beforeInitialize = true;
        p.beforeAddLiquidity = true;
        p.beforeRemoveLiquidity = true;
        p.beforeSwap = true;
    }

    function registerMarket(PoolKey calldata key, RentV4Market market) external {
        if (msg.sender != factory) revert OnlyFactory();
        PoolId id = key.toId();
        if (
            address(marketForPool[id]) != address(0) || address(key.hooks) != address(this)
                || key.fee != LPFeeLibrary.DYNAMIC_FEE_FLAG || market.factory() != factory
        ) revert InvalidRegistration();
        marketForPool[id] = market;
    }

    /// @notice Fixed linear calendar fee. LPs receive the fee; it does not produce escrow yield.
    function currentFee(RentV4Market market) public view returns (uint24) {
        uint256 end = market.saleEnd();
        if (block.timestamp >= end) return MAX_FEE;
        uint256 start = market.createdAt();
        return BASE_FEE + uint24((MAX_FEE - BASE_FEE) * (block.timestamp - start) / (end - start));
    }

    function _market(PoolKey calldata key) internal view returns (RentV4Market market) {
        market = marketForPool[key.toId()];
        if (address(market) == address(0)) revert UnknownPool();
    }

    function _beforeInitialize(address sender, PoolKey calldata key, uint160) internal view override returns (bytes4) {
        if (sender != factory) revert OnlyFactory();
        if (!_market(key).tradingOpen()) revert TradingClosed();
        return IHooks.beforeInitialize.selector;
    }

    function _beforeAddLiquidity(address, PoolKey calldata key, ModifyLiquidityParams calldata, bytes calldata)
        internal
        view
        override
        returns (bytes4)
    {
        if (!_market(key).tradingOpen()) revert TradingClosed();
        return IHooks.beforeAddLiquidity.selector;
    }

    function _beforeRemoveLiquidity(address, PoolKey calldata key, ModifyLiquidityParams calldata, bytes calldata)
        internal
        view
        override
        returns (bytes4)
    {
        if (!_market(key).liquidityRemovalOpen()) revert LiquidityLocked();
        return IHooks.beforeRemoveLiquidity.selector;
    }

    function _beforeSwap(address, PoolKey calldata key, SwapParams calldata, bytes calldata)
        internal
        view
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        RentV4Market market = _market(key);
        if (!market.tradingOpen()) revert TradingClosed();
        return (
            IHooks.beforeSwap.selector,
            BeforeSwapDeltaLibrary.ZERO_DELTA,
            currentFee(market) | LPFeeLibrary.OVERRIDE_FEE_FLAG
        );
    }
}
