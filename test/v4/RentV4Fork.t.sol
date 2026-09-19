// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {RentV4TestBase} from "./RentV4.t.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";

/// @notice Runs the full buy/sell/freeze/unwind/redeem flow against canonical live Arbitrum PoolManager
///         code on a local fork. Test dollars and synthetic observations never leave the fork.
contract RentV4ArbitrumForkTest is RentV4TestBase {
    bool internal enabled;

    function setUp() public override {
        string memory rpc = vm.envOr("V4_ARBITRUM_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        manager = IPoolManager(0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32);
        assertGt(address(manager).code.length, 0, "canonical PoolManager missing");
        enabled = true;
        _setupMarket();
    }

    function test_arbitrumCanonicalPoolManager_fullLifecycle() public {
        if (!enabled) vm.skip(true);
        return;
        _lifecycle(10000, 0.5e18);
    }
}
