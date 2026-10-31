// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ApartmentsCoverPool, IApartmentsRentOracle} from "../src/apartments/ApartmentsCoverPool.sol";
import {ApartmentsRentOracle} from "../src/apartments/ApartmentsRentOracle.sol";
import {CoverToken} from "../src/CoverToken.sol";
import {GoogleAlertKey} from "../src/gen/GoogleAlertKey.sol";

/// @notice Deploys the ownerless Apartments.com oracle, claim token and pool on Gnosis.
/// @dev    Env: PRIVATE_KEY or DEPLOYER_PRIVATE_KEY. CURRENCY overrides WXDAI for forks.
contract DeployApartments is Script {
    address internal constant WXDAI = 0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d;
    uint8 internal constant DECIMALS = 18;

    function run() external returns (ApartmentsRentOracle oracle, CoverToken token, ApartmentsCoverPool pool) {
        require(block.chainid == 100 || block.chainid == 31337, "gnosis only");
        uint256 pk = vm.envOr("PRIVATE_KEY", vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0)));
        require(pk != 0, "no deployer key");
        address currency = vm.envOr("CURRENCY", WXDAI);
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
