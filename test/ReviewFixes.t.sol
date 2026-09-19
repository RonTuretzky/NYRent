// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CoverPool} from "../src/CoverPool.sol";
import {CoverToken} from "../src/CoverToken.sol";
import {CredailyRentOracle} from "../src/CredailyRentOracle.sol";
import {CredailyKey} from "../src/gen/CredailyKey.sol";
import {Dkim} from "../src/lib/Dkim.sol";
import {IObservationOracle} from "../src/interfaces/IObservationOracle.sol";
import {MockObservationOracle, TestERC20} from "./utils/Helpers.sol";

/// @notice Regression tests for the three confirmed contract findings of the
///         adversarial review: (1) RSA signature representatives >= n rejected,
///         (2) from-line needle must be the line SUFFIX (display names can't match),
///         (3) CoverPool reentrancy guard.
contract ReviewFixesTest is Test {
    bytes internal headers;
    bytes internal body;
    bytes internal sig;

    function setUp() public {
        headers = vm.readFileBinary("fixtures/credaily-2026-09-17/signed-headers.bin");
        body = vm.readFileBinary("fixtures/credaily-2026-09-17/canon-body.bin");
        sig = vm.readFileBinary("fixtures/credaily-2026-09-17/sig.bin");
        vm.warp(1_789_700_000); // just after the fixture's t
    }

    // ── Finding: rsaVerify accepted non-canonical representatives (s >= n) ──

    function test_RsaRejectsRepresentativeSPlusN() public {
        CredailyRentOracle oracle = new CredailyRentOracle(CredailyKey.MODULUS);

        // s' = s + n as a 256-byte big-endian value (no carry out — verified below).
        bytes memory modulus = CredailyKey.MODULUS;
        bytes memory sPrime = new bytes(256);
        uint256 carry;
        for (uint256 i = 256; i > 0; --i) {
            uint256 sum = uint256(uint8(sig[i - 1])) + uint256(uint8(modulus[i - 1])) + carry;
            sPrime[i - 1] = bytes1(uint8(sum & 0xff));
            carry = sum >> 8;
        }
        assertEq(carry, 0, "s+n must fit 256 bytes for this vector");

        // The forged representative must now be rejected outright.
        vm.expectRevert(CredailyRentOracle.BadSignature.selector);
        oracle.submitObservation(headers, body, sPrime);

        // The canonical signature still verifies end to end.
        oracle.submitObservation(headers, body, sig);
        (, uint32 cents,) = oracle.observations(0);
        assertEq(cents, 9288);
    }

    // ── Finding: from-needle matched anywhere in the line (display names) ──

    function _dummySig() internal pure returns (bytes memory s256) {
        s256 = new bytes(256);
        s256[255] = 0x02; // < n, so the representative check passes and RSA runs
    }

    function test_FromNeedleInDisplayNameRejected() public {
        CredailyRentOracle oracle = new CredailyRentOracle(CredailyKey.MODULUS);
        bytes memory tiny = bytes("hello\r\n");
        bytes memory block_ = abi.encodePacked(
            "from:\"x <mail@newyork.credaily.com>\" <other@newyork.credaily.com>\r\n",
            "dkim-signature:v=1; a=rsa-sha256; c=relaxed/relaxed; d=newyork.credaily.com; s=b37; bh=",
            Dkim.base64Encode32(sha256(tiny)),
            "; t=1789642464; b="
        );
        vm.expectRevert(CredailyRentOracle.MissingFrom.selector);
        oracle.submitObservation(block_, tiny, _dummySig());
    }

    function test_FromNeedleAsSuffixReachesSignatureCheck() public {
        CredailyRentOracle oracle = new CredailyRentOracle(CredailyKey.MODULUS);
        bytes memory tiny = bytes("hello\r\n");
        bytes memory block_ = abi.encodePacked(
            "from:CRE Daily New York <mail@newyork.credaily.com>\r\n",
            "dkim-signature:v=1; a=rsa-sha256; c=relaxed/relaxed; d=newyork.credaily.com; s=b37; bh=",
            Dkim.base64Encode32(sha256(tiny)),
            "; t=1789642464; b="
        );
        // from-line, dkim tags, bh and timestamp all pass; the dummy signature is
        // what fails — proving the suffix rule admits the canonical form.
        vm.expectRevert(CredailyRentOracle.BadSignature.selector);
        oracle.submitObservation(block_, tiny, _dummySig());
    }

    // ── Finding: no reentrancy guard on CoverPool ──

    function _reentrancyFixture() internal returns (CoverPool pool, TestERC20 wxdai) {
        wxdai = new TestERC20();
        MockObservationOracle mockOracle = new MockObservationOracle();
        address sponsor = makeAddr("sponsor");

        uint64 nonce = vm.getNonce(address(this));
        address predictedPool = vm.computeCreateAddress(address(this), nonce + 1);
        CoverToken token = new CoverToken(predictedPool, wxdai.decimals());
        pool = new CoverPool(wxdai, token, IObservationOracle(address(mockOracle)), sponsor);
        assertEq(address(pool), predictedPool);

        uint64 t0 = uint64(block.timestamp);
        vm.startPrank(sponsor);
        wxdai.mint(sponsor, 10 ether);
        wxdai.approve(address(pool), type(uint256).max);
        pool.fundPool(10 ether);
        pool.createSeries(8800, 9600, 2850, t0 + 10 days, t0, t0 + 10 days, t0 + 40 days, 10 ether);
        vm.stopPrank();
    }

    function test_BuyProtectionReentrancyBlocked() public {
        (CoverPool pool, TestERC20 wxdai) = _reentrancyFixture();
        ReentrantBuyer attacker = new ReentrantBuyer(pool, wxdai);
        wxdai.mint(address(attacker), 5 ether);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        attacker.attack(0, 1 ether, false);
    }

    function test_BuyProtectionForReentrancyBlocked() public {
        (CoverPool pool, TestERC20 wxdai) = _reentrancyFixture();
        ReentrantBuyer attacker = new ReentrantBuyer(pool, wxdai);
        wxdai.mint(address(attacker), 5 ether);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        attacker.attack(0, 1 ether, true);
    }
}

/// @dev Reenters the pool from the ERC-1155 mint acceptance callback, through either
///      purchase entrypoint ({CoverPool.buyProtection} or {CoverPool.buyProtectionFor}).
contract ReentrantBuyer {
    CoverPool internal immutable pool;
    TestERC20 internal immutable wxdai;
    bool internal viaBuyFor;
    bool internal reentered;

    constructor(CoverPool pool_, TestERC20 wxdai_) {
        pool = pool_;
        wxdai = wxdai_;
    }

    function attack(uint256 seriesId, uint256 maxClaim, bool viaBuyFor_) external {
        viaBuyFor = viaBuyFor_;
        wxdai.approve(address(pool), type(uint256).max);
        if (viaBuyFor_) pool.buyProtectionFor(seriesId, maxClaim, type(uint256).max, address(this));
        else pool.buyProtection(seriesId, maxClaim, type(uint256).max);
    }

    function onERC1155Received(address, address, uint256 seriesId, uint256, bytes calldata) external returns (bytes4) {
        if (!reentered) {
            reentered = true;
            // must revert: reentrant on either entrypoint
            if (viaBuyFor) pool.buyProtectionFor(seriesId, 1, type(uint256).max, address(this));
            else pool.buyProtection(seriesId, 1, type(uint256).max);
        }
        return this.onERC1155Received.selector;
    }
}
