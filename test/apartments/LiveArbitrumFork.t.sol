// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ApartmentsCoverPool} from "../../src/apartments/ApartmentsCoverPool.sol";
import {ApartmentsRentOracle} from "../../src/apartments/ApartmentsRentOracle.sol";
import {CoverToken} from "../../src/CoverToken.sol";
import {GoogleAlertKey} from "../../src/gen/GoogleAlertKey.sol";

/// @notice Runs a whole policy on the DEPLOYED Arbitrum One contracts and real USDC, on a
///         local fork, settled by a real Google-signed email from the private archive. The
///         clock is moved back before October 2026 so that month's email qualifies. Needs
///         ARBITRUM_FORK_RPC and fixtures/private; skips otherwise, as in CI.
contract LiveArbitrumForkTest is Test {
    ApartmentsCoverPool internal constant POOL = ApartmentsCoverPool(0xa59b195135D5220c82d2C19270CadC392585F30A);
    ApartmentsRentOracle internal constant ORACLE = ApartmentsRentOracle(0x235281E05c1F155068A73BF48B43ac1C79a9c855);
    CoverToken internal constant TOKEN = CoverToken(0x67214a5dA4C99aA11Bd709cf22aAAF98972C5471);
    IERC20 internal constant USDC = IERC20(0xaf88d065e77c8cC2239327C5EDb3A432268e5831);

    string internal constant DIR = "fixtures/private/google-alerts/";
    string internal constant SLUG = "east-harlem-new-york-ny";
    uint32 internal constant MONTH = 202610;
    uint64 internal constant OCT_START = 1790812800;
    uint64 internal constant OCT_END = 1793491199;
    uint64 internal constant FINALIZE_AT = OCT_END + 1 + 7 days;
    uint64 internal constant REDEEM_END = FINALIZE_AT + 30 days;

    address internal creator = makeAddr("live-creator");
    address internal buyer = makeAddr("live-buyer");
    uint256 internal id;
    uint256 internal baseline;

    function setUp() public {
        string memory rpc = vm.envOr("ARBITRUM_FORK_RPC", string(""));
        string memory manifest = string.concat(DIR, "manifest.json");
        if (bytes(rpc).length == 0 || !vm.exists(manifest)) return vm.skip(true);
        vm.createSelectFork(rpc);
        assertEq(address(POOL.oracle()), address(ORACLE));
        assertEq(address(POOL.token()), address(TOKEN));
        assertEq(address(POOL.currency()), address(USDC));
        assertEq(TOKEN.pool(), address(POOL));
        assertEq(ORACLE.MODULUS_HASH(), keccak256(GoogleAlertKey.MODULUS));

        baseline = USDC.balanceOf(address(POOL));
        deal(address(USDC), creator, 1_000e6);
        deal(address(USDC), buyer, 100e6);
        vm.warp(OCT_START - 5 days);
        vm.startPrank(creator);
        USDC.approve(address(POOL), type(uint256).max);
        id = POOL.createSeries(SLUG, MONTH, 290000, 300000, 1000, OCT_START, REDEEM_END, 1_000e6);
        vm.stopPrank();
        vm.startPrank(buyer);
        USDC.approve(address(POOL), type(uint256).max);
        POOL.buyProtection(id, 100e6, 10e6);
        vm.stopPrank();
    }

    /// Index and signature time of the first archived email carrying `SLUG`.
    function _realEmail() internal view returns (uint256, uint64, uint256) {
        string memory manifest = vm.readFile(string.concat(DIR, "manifest.json"));
        uint256 count = vm.parseJsonUint(manifest, ".count");
        for (uint256 i = 0; i < count; ++i) {
            string memory e = string.concat(".emails[", vm.toString(i), "]");
            uint256 n = vm.parseJsonUint(manifest, string.concat(e, ".resultCount"));
            for (uint256 j = 0; j < n; ++j) {
                string memory r = string.concat(e, ".results[", vm.toString(j), "]");
                if (keccak256(bytes(vm.parseJsonString(manifest, string.concat(r, ".slug")))) == keccak256(bytes(SLUG)))
                {
                    return (
                        i,
                        uint64(vm.parseJsonUint(manifest, string.concat(e, ".t"))),
                        vm.parseJsonUint(manifest, string.concat(r, ".cents"))
                    );
                }
            }
        }
        revert("no archived email for the page");
    }

    function _submitReal(uint256 i) internal {
        string memory d = string.concat(DIR, vm.toString(i), "/");
        ORACLE.submitObservation(
            vm.readFileBinary(string.concat(d, "signed-headers.bin")),
            vm.readFileBinary(string.concat(d, "canon-body.bin")),
            vm.readFileBinary(string.concat(d, "sig.bin"))
        );
    }

    /// $2,952 between strikes of $2,900 and $3,000 pays 52% of each claim.
    function test_realEmailSettlesLivePolicy() public {
        (uint256 i, uint64 t, uint256 cents) = _realEmail();
        assertEq(cents, 295200);
        vm.warp(t + 1 hours);
        _submitReal(i);
        (uint64 gotT, uint32 gotCents,) = ORACLE.earliest(keccak256(bytes(SLUG)), MONTH);
        assertEq(gotT, t);
        assertEq(gotCents, 295200);

        vm.warp(FINALIZE_AT);
        vm.prank(buyer);
        POOL.redeem(id, 100e6);
        assertTrue(POOL.series(id).settled);
        assertEq(POOL.series(id).payoutRatioWad, 0.52e18);
        assertEq(USDC.balanceOf(buyer), 90e6 + 52e6);

        vm.warp(REDEEM_END + 1);
        vm.prank(creator);
        POOL.withdrawResidual(id);
        assertEq(USDC.balanceOf(creator), 1_000e6 + 10e6 - 52e6);
        assertEq(USDC.balanceOf(address(POOL)), baseline);
    }

    function test_noEmailVoidsLivePolicy() public {
        vm.warp(FINALIZE_AT);
        vm.prank(buyer);
        POOL.redeem(id, 100e6);
        assertTrue(POOL.series(id).voided);
        assertEq(USDC.balanceOf(buyer), 100e6);

        vm.warp(REDEEM_END + 1);
        vm.prank(creator);
        POOL.withdrawResidual(id);
        assertEq(USDC.balanceOf(creator), 1_000e6);
        assertEq(USDC.balanceOf(address(POOL)), baseline);
    }
}
