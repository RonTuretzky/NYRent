// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ApartmentsCoverPool, IApartmentsRentOracle} from "../src/apartments/ApartmentsCoverPool.sol";
import {ApartmentsRentOracle} from "../src/apartments/ApartmentsRentOracle.sol";
import {CoverToken} from "../src/CoverToken.sol";
import {GoogleAlertKey} from "../src/gen/GoogleAlertKey.sol";

/// @notice Deploys the ownerless Apartments.com oracle, claim token and pool on Arbitrum One.
/// @dev    Env: PRIVATE_KEY or DEPLOYER_PRIVATE_KEY. CURRENCY overrides native USDC for forks.
contract DeployApartments is Script {
    address internal constant NATIVE_USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;
    uint8 internal constant DECIMALS = 6;

    function run() external returns (ApartmentsRentOracle oracle, CoverToken token, ApartmentsCoverPool pool) {
        require(block.chainid == 42161 || block.chainid == 31337, "arbitrum only");
        uint256 pk = vm.envOr("PRIVATE_KEY", vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0)));
        require(pk != 0, "no deployer key");
        address currency = vm.envOr("CURRENCY", NATIVE_USDC);
        address deployer = vm.addr(pk);

        vm.startBroadcast(pk);
        oracle = new ApartmentsRentOracle(GoogleAlertKey.MODULUS);
        address predictedPool = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 1);
        token = new CoverToken(predictedPool, DECIMALS);
        pool = new ApartmentsCoverPool(IERC20(currency), token, IApartmentsRentOracle(address(oracle)));
        vm.stopBroadcast();

        require(address(pool) == predictedPool, "pool address mismatch");
        require(oracle.MODULUS_HASH() == keccak256(GoogleAlertKey.MODULUS), "modulus mismatch");
        console.log("oracle", address(oracle));
        console.log("token", address(token));
        console.log("pool", address(pool));
    }
}
