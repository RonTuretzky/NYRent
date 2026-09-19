// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {HookMiner} from "@uniswap/v4-periphery/src/utils/HookMiner.sol";
import {CredailyRentOracle} from "../src/CredailyRentOracle.sol";
import {CredailyKey} from "../src/gen/CredailyKey.sol";
import {IObservationOracle} from "../src/interfaces/IObservationOracle.sol";
import {RentV4Factory} from "../src/v4/RentV4Factory.sol";
import {RentV4Hook} from "../src/v4/RentV4Hook.sol";
import {RentV4Router} from "../src/v4/RentV4Router.sol";
import {LocalWXDAI} from "./LocalWXDAI.sol";

/// @notice Deploys an empty, immutable v4 stack. A verified oracle baseline is needed before creating markets.
/// @dev No private key read from files or environment. Use a keystore/hardware wallet via forge --account.
///      Default forge script execution simulates; publication requires the operator's explicit --broadcast.
contract DeployV4 is Script {
    address public constant ARBITRUM_MANAGER = 0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32;
    address public constant ARBITRUM_USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;
    address public constant POLYGON_MANAGER = 0x67366782805870060151383F4BbFF9daB53e5cD6;
    address public constant POLYGON_USDC = 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359;
    uint160 private constant FLAGS = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
        | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG;

    error UnsupportedChain();
    error InvalidDeployment();

    function run() external returns (CredailyRentOracle oracle, RentV4Factory factory, RentV4Router router) {
        if (block.chainid != 31337 && block.chainid != 42161 && block.chainid != 137) revert UnsupportedChain();
        address deployer = vm.envAddress("DEPLOYER");
        if (deployer == address(0)) revert InvalidDeployment();
        IPoolManager manager;
        IERC20 currency;
        if (block.chainid == 42161 || block.chainid == 137) {
            manager = IPoolManager(block.chainid == 137 ? POLYGON_MANAGER : ARBITRUM_MANAGER);
            currency = IERC20(block.chainid == 137 ? POLYGON_USDC : ARBITRUM_USDC);
            if (
                address(manager).code.length == 0 || address(currency).code.length == 0
                    || IERC20Metadata(address(currency)).decimals() != 6
            ) revert InvalidDeployment();
        }
        address oracleAddress = vm.envOr("V4_ORACLE", address(0));
        if (oracleAddress != address(0)) {
            oracle = CredailyRentOracle(oracleAddress);
            if (oracle.MODULUS_HASH() != CredailyKey.MODULUS_HASH) revert InvalidDeployment();
        }
        vm.startBroadcast(deployer);
        if (block.chainid == 31337) {
            manager = IPoolManager(address(new PoolManager(address(0))));
            currency = IERC20(address(new LocalWXDAI()));
        }
        if (oracleAddress == address(0)) oracle = new CredailyRentOracle(CredailyKey.MODULUS);
        address predictedFactory = vm.computeCreateAddress(deployer, vm.getNonce(deployer));
        (address predictedHook, bytes32 salt) = HookMiner.find(
            predictedFactory, FLAGS, type(RentV4Hook).creationCode, abi.encode(manager, predictedFactory)
        );
        factory = new RentV4Factory(manager, currency, IObservationOracle(address(oracle)), salt);
        router = new RentV4Router(factory);
        vm.stopBroadcast();
        if (
            address(factory) != predictedFactory || address(factory.hook()) != predictedHook
                || address(router.poolManager()) != address(manager) || factory.marketCount() != 0
        ) revert InvalidDeployment();
        console.log("PoolManager:", address(manager));
        console.log("Currency:", address(currency));
        console.log("Oracle:", address(oracle));
        console.log("Factory:", address(factory));
        console.log("Hook:", address(factory.hook()));
        console.log("Router:", address(router));
        console.log("Markets: 0. Submit an authentic base observation, then create and fund a market.");
    }
}
