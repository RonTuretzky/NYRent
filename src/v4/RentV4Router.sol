// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {RentV4Factory} from "./RentV4Factory.sol";

/// @notice Single-pool RENT buy/sell and account-owned LP positions against the real v4 singleton.
/// @dev Does not custody user balances. Every debt is pulled only from the entrypoint caller and every
///      credit is taken directly to its recipient. Existing router balances/allowances cannot be swept.
contract RentV4Router is IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;

    struct SwapRequest {
        address market;
        bool buyRent;
        uint128 amountIn;
        uint128 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
        address recipient;
        uint256 deadline;
    }

    struct LiquidityRequest {
        address market;
        int24 tickLower;
        int24 tickUpper;
        int128 liquidityDelta;
        uint128 amount0Limit;
        uint128 amount1Limit;
        address recipient;
        uint256 deadline;
    }

    RentV4Factory public immutable factory;
    IPoolManager public immutable poolManager;
    mapping(bytes32 positionId => uint128 liquidity) public positions;
    bytes32 private _pendingCallback;

    error DeadlineExpired();
    error InvalidRecipient();
    error InvalidAmount();
    error Slippage();
    error UnauthorizedCallback();
    error InsufficientLiquidity();
    error CurrencySettlementMismatch();
    event SwapExecuted(
        address indexed caller,
        address indexed market,
        address indexed recipient,
        bool buyRent,
        uint256 amountSpent,
        uint256 amountOut
    );
    event LiquidityModified(
        address indexed owner,
        address indexed market,
        bytes32 indexed positionId,
        int24 tickLower,
        int24 tickUpper,
        int128 liquidityDelta,
        int128 amount0,
        int128 amount1
    );

    constructor(RentV4Factory factory_) {
        factory = factory_;
        poolManager = factory_.poolManager();
    }

    function positionId(address owner, address market, int24 tickLower, int24 tickUpper) public pure returns (bytes32) {
        return keccak256(abi.encode(owner, market, tickLower, tickUpper));
    }

    function liquidityOf(address owner, address market, int24 tickLower, int24 tickUpper)
        external
        view
        returns (uint128)
    {
        return positions[positionId(owner, market, tickLower, tickUpper)];
    }

    /// @notice A zero price limit uses the protocol's furthest permitted limit. A custom limit may partially fill.
    function swapExactInput(SwapRequest calldata request)
        external
        nonReentrant
        returns (uint256 amountSpent, uint256 amountOut)
    {
        _validate(request.recipient, request.deadline);
        if (request.amountIn == 0) revert InvalidAmount();
        bytes memory data = abi.encode(uint8(0), msg.sender, abi.encode(request));
        _pendingCallback = keccak256(data);
        (amountSpent, amountOut) = abi.decode(poolManager.unlock(data), (uint256, uint256));
        emit SwapExecuted(msg.sender, request.market, request.recipient, request.buyRent, amountSpent, amountOut);
    }

    /// @notice Positive delta: token0/1 limits are maximum payments. Negative/zero: minimum receipts.
    /// @dev Positions belong to msg.sender. An account can never remove another account's liquidity.
    function modifyLiquidity(LiquidityRequest calldata request) external nonReentrant returns (BalanceDelta delta) {
        _validate(request.recipient, request.deadline);
        bytes memory data = abi.encode(uint8(1), msg.sender, abi.encode(request));
        _pendingCallback = keccak256(data);
        delta = abi.decode(poolManager.unlock(data), (BalanceDelta));
    }

    function _validate(address recipient, uint256 deadline) internal view {
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (recipient == address(0) || recipient == address(this) || recipient == address(poolManager)) {
            revert InvalidRecipient();
        }
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager) || _pendingCallback == bytes32(0) || keccak256(data) != _pendingCallback)
        {
            revert UnauthorizedCallback();
        }
        // Consume authorization before calling any token. Entry points remain under nonReentrant.
        _pendingCallback = bytes32(0);
        (uint8 action, address payer, bytes memory encoded) = abi.decode(data, (uint8, address, bytes));
        if (action == 0) return _swap(payer, abi.decode(encoded, (SwapRequest)));
        if (action == 1) return _liquidity(payer, abi.decode(encoded, (LiquidityRequest)));
        revert UnauthorizedCallback();
    }

    function _swap(address payer, SwapRequest memory r) internal returns (bytes memory) {
        PoolKey memory key = factory.poolKey(r.market);
        bool zeroForOne = r.buyRent == (Currency.unwrap(key.currency1) == r.market);
        uint160 limit = r.sqrtPriceLimitX96 == 0
            ? (zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1)
            : r.sqrtPriceLimitX96;
        BalanceDelta delta = poolManager.swap(key, SwapParams(zeroForOne, -int256(uint256(r.amountIn)), limit), "");
        int128 input = zeroForOne ? delta.amount0() : delta.amount1();
        int128 output = zeroForOne ? delta.amount1() : delta.amount0();
        if (input > 0 || output < 0) revert InvalidAmount();
        uint256 spent = uint256(-int256(input));
        uint256 received = uint128(output);
        if (spent > r.amountIn || received < r.amountOutMinimum) revert Slippage();
        _settle(key.currency0, delta.amount0(), payer, r.recipient);
        _settle(key.currency1, delta.amount1(), payer, r.recipient);
        return abi.encode(spent, received);
    }

    function _liquidity(address payer, LiquidityRequest memory r) internal returns (bytes memory) {
        PoolKey memory key = factory.poolKey(r.market);
        bytes32 id = positionId(payer, r.market, r.tickLower, r.tickUpper);
        uint128 previous = positions[id];
        if (r.liquidityDelta > 0) {
            positions[id] = previous + uint128(r.liquidityDelta);
        } else {
            uint128 removed = uint128(uint256(-int256(r.liquidityDelta)));
            if (removed > previous || previous == 0) revert InsufficientLiquidity();
            positions[id] = previous - removed;
        }
        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            key, ModifyLiquidityParams(r.tickLower, r.tickUpper, r.liquidityDelta, bytes32(uint256(uint160(payer)))), ""
        );
        _checkLiquidityLimit(delta.amount0(), r.amount0Limit, r.liquidityDelta > 0);
        _checkLiquidityLimit(delta.amount1(), r.amount1Limit, r.liquidityDelta > 0);
        _settle(key.currency0, delta.amount0(), payer, r.recipient);
        _settle(key.currency1, delta.amount1(), payer, r.recipient);
        emit LiquidityModified(
            payer, r.market, id, r.tickLower, r.tickUpper, r.liquidityDelta, delta.amount0(), delta.amount1()
        );
        return abi.encode(delta);
    }

    function _checkLiquidityLimit(int128 amount, uint128 limit, bool adding) internal pure {
        if (adding) {
            if (amount < 0 && uint256(-int256(amount)) > limit) revert Slippage();
        } else if (amount < 0 || uint128(amount) < limit) {
            revert Slippage();
        }
    }

    function _settle(Currency currency, int128 delta, address payer, address recipient) internal {
        if (delta < 0) {
            uint256 amount = uint256(-int256(delta));
            poolManager.sync(currency);
            IERC20(Currency.unwrap(currency)).safeTransferFrom(payer, address(poolManager), amount);
            if (poolManager.settle() != amount) revert CurrencySettlementMismatch();
        } else if (delta > 0) {
            poolManager.take(currency, recipient, uint128(delta));
        }
    }
}
