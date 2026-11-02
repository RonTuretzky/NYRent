// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IApartmentsRentOracle} from "../src/apartments/ApartmentsCoverPool.sol";
import {ApartmentsCoverPoolV2} from "../src/apartments/ApartmentsCoverPoolV2.sol";
import {ApartmentsRentOracle} from "../src/apartments/ApartmentsRentOracle.sol";
import {CoverToken} from "../src/CoverToken.sol";
import {GoogleAlertKey} from "../src/gen/GoogleAlertKey.sol";

/// @notice Deploys a V2 claim token and pool on Arbitrum One against the existing oracle.
/// @dev    Env: PRIVATE_KEY or DEPLOYER_PRIVATE_KEY. ORACLE and CURRENCY override for forks.
contract DeployApartmentsV2 is Script {
    address internal constant ORACLE = 0x235281E05c1F155068A73BF48B43ac1C79a9c855;
    address internal constant NATIVE_USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;
    uint8 internal constant DECIMALS = 6;

    function run() external returns (CoverToken token, ApartmentsCoverPoolV2 pool) {
        require(block.chainid == 42161 || block.chainid == 31337, "arbitrum only");
        uint256 pk = vm.envOr("PRIVATE_KEY", vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0)));
        require(pk != 0, "no deployer key");
        address oracle = vm.envOr("ORACLE", ORACLE);
        address currency = vm.envOr("CURRENCY", NATIVE_USDC);
        // Overrides are for forks only: mainnet always uses the live oracle and native USDC.
        if (block.chainid == 42161) require(oracle == ORACLE && currency == NATIVE_USDC, "mainnet overrides");
        require(ApartmentsRentOracle(oracle).MODULUS_HASH() == keccak256(GoogleAlertKey.MODULUS), "oracle key");
        address deployer = vm.addr(pk);

        vm.startBroadcast(pk);
        address predictedPool = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 1);
        token = new CoverToken(predictedPool, DECIMALS);
        pool = new ApartmentsCoverPoolV2(IERC20(currency), token, IApartmentsRentOracle(oracle));
        vm.stopBroadcast();

        require(address(pool) == predictedPool, "pool address mismatch");
        require(address(pool.oracle()) == oracle, "oracle mismatch");
        console.log("token", address(token));
        console.log("pool", address(pool));
    }
}
