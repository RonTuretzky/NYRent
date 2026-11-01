// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ApartmentsCoverPool, IApartmentsRentOracle} from "../src/apartments/ApartmentsCoverPool.sol";
import {ApartmentsRentOracle} from "../src/apartments/ApartmentsRentOracle.sol";
import {CoverToken} from "../src/CoverToken.sol";

/// @notice TEST-ONLY twin of DeployApartments for local forks: the oracle pins the
///         modulus passed in `MODULUS` (the committed fixtures/testkey key, so the
///         browser suite can record a synthetic email for a future month) and the
///         pool uses `CURRENCY`. Broadcast from an anvil-impersonated `DEPLOYER`
///         with `--unlocked --sender`; no private key is involved. Refuses real
///         Arbitrum: it is for anvil (31337) or a fork that reports 42161 locally.
contract DeployApartmentsFork is Script {
    uint8 internal constant DECIMALS = 6;

    function run() external returns (ApartmentsRentOracle oracle, CoverToken token, ApartmentsCoverPool pool) {
        bytes memory modulus = vm.envBytes("MODULUS");
        address currency = vm.envAddress("CURRENCY");
        address deployer = vm.envAddress("DEPLOYER");
        require(bytes(vm.envOr("FORK_RPC_URL", string(""))).length > 0, "set FORK_RPC_URL to a local fork");

        vm.startBroadcast(deployer);
        oracle = new ApartmentsRentOracle(modulus);
        address predictedPool = vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 1);
        token = new CoverToken(predictedPool, DECIMALS);
        pool = new ApartmentsCoverPool(IERC20(currency), token, IApartmentsRentOracle(address(oracle)));
        vm.stopBroadcast();

        require(address(pool) == predictedPool, "pool address mismatch");
        console.log("oracle", address(oracle));
        console.log("token", address(token));
        console.log("pool", address(pool));
    }
}
