// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IObservationOracle} from "../interfaces/IObservationOracle.sol";
import {RentV4Market} from "./RentV4Market.sol";
import {RentV4Hook} from "./RentV4Hook.sol";

/// @notice Anyone can create a market and choose immutable terms and the initial AMM price.
/// @dev The factory fixes currency/oracle/PoolManager once; no roles, ownership or upgrade mechanism.
contract RentV4Factory is ReentrancyGuard {
    using PoolIdLibrary for PoolKey;
    IPoolManager public immutable poolManager;
    IERC20 public immutable currency;
    IObservationOracle public immutable oracle;
    RentV4Hook public immutable hook;
    uint8 public immutable currencyDecimals;
    int24 public constant TICK_SPACING = 60;
    address[] public markets;
    mapping(address market => bool registered) public isMarket;
    error InvalidConfiguration();
    error UnknownMarket();
    event MarketCreated(
        uint256 indexed marketIndex,
        address indexed market,
        address indexed creator,
        PoolId poolId,
        uint160 sqrtPriceX96
    );

    /// @param hookSalt Must mine the hook permissions against this factory's predicted CREATE address.
    constructor(IPoolManager manager_, IERC20 currency_, IObservationOracle oracle_, bytes32 hookSalt) {
        if (
            address(manager_).code.length == 0 || address(currency_).code.length == 0
                || address(oracle_).code.length == 0
        ) revert InvalidConfiguration();
        uint8 decimals_ = IERC20Metadata(address(currency_)).decimals();
        if (decimals_ != 6 && decimals_ != 18) revert InvalidConfiguration();
        poolManager = manager_;
        currency = currency_;
        oracle = oracle_;
        currencyDecimals = decimals_;
        hook = new RentV4Hook{salt: hookSalt}(manager_, address(this));
    }

    function marketCount() external view returns (uint256) {
        return markets.length;
    }

    function poolKey(address market) public view returns (PoolKey memory key) {
        if (!isMarket[market]) revert UnknownMarket();
        address token0 = address(currency) < market ? address(currency) : market;
        address token1 = address(currency) < market ? market : address(currency);
        return PoolKey(
            Currency.wrap(token0),
            Currency.wrap(token1),
            LPFeeLibrary.DYNAMIC_FEE_FLAG,
            TICK_SPACING,
            IHooks(address(hook))
        );
    }

    /// @notice Creation does not mint unbacked inventory. Anyone may then depositAndMint and provide LP capital.
    function createMarket(RentV4Market.Terms calldata terms, uint160 sqrtPriceX96)
        external
        nonReentrant
        returns (address market)
    {
        market = address(new RentV4Market(currency, oracle, currencyDecimals, terms));
        isMarket[market] = true;
        markets.push(market);
        PoolKey memory key = poolKey(market);
        hook.registerMarket(key, RentV4Market(market));
        poolManager.initialize(key, sqrtPriceX96);
        emit MarketCreated(markets.length - 1, market, msg.sender, key.toId(), sqrtPriceX96);
    }
}
