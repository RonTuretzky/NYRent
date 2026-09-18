// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CredailyRentOracle} from "../src/CredailyRentOracle.sol";
import {CredailyKey} from "../src/gen/CredailyKey.sol";
import {Dkim} from "../src/lib/Dkim.sol";

/// @notice Negative-path matrix for {CredailyRentOracle.submitObservation}:
///         tampered variants of the REAL fixture against the real-modulus oracle,
///         plus the full synthetic matrix (fixtures/synthetic/, signed with the
///         committed TEST-ONLY key) against a test-modulus oracle. The synthetic
///         fixtures were generated AND internally verified by
///         scripts/make-synthetic-fixtures.py; expectations here mirror its
///         manifest.json.
contract TamperEmailTest is Test {
    /// @dev == manifest.json testNow == the real email's t=; every synthetic case
    ///      was built relative to this clock.
    uint64 internal constant TEST_NOW = 1789642464;

    bytes internal realHeaders;
    bytes internal realBody;
    bytes internal realSig;

    CredailyRentOracle internal realOracle; // pinned to the real CRE Daily modulus
    CredailyRentOracle internal testOracle; // pinned to the TEST-ONLY modulus

    function setUp() public {
        vm.warp(TEST_NOW);
        realHeaders = vm.readFileBinary("fixtures/credaily-2026-09-17/signed-headers.bin");
        realBody = vm.readFileBinary("fixtures/credaily-2026-09-17/canon-body.bin");
        realSig = vm.readFileBinary("fixtures/credaily-2026-09-17/sig.bin");

        realOracle = new CredailyRentOracle(CredailyKey.MODULUS);
        bytes memory testModulus = vm.parseJsonBytes(vm.readFile("fixtures/testkey/meta.json"), ".modulus_hex");
        testOracle = new CredailyRentOracle(testModulus);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────────

    function _load(string memory name) internal view returns (bytes memory h, bytes memory b, bytes memory s) {
        string memory dir = string.concat("fixtures/synthetic/", name, "/");
        h = vm.readFileBinary(string.concat(dir, "signed-headers.bin"));
        b = vm.readFileBinary(string.concat(dir, "canon-body.bin"));
        s = vm.readFileBinary(string.concat(dir, "sig.bin"));
    }

    function _submit(string memory name) internal {
        (bytes memory h, bytes memory b, bytes memory s) = _load(name);
        testOracle.submitObservation(h, b, s);
    }

    function _expectOk(string memory name, uint32 cents) internal {
        uint256 index = testOracle.observationCount();
        _submit(name);
        (, uint32 got,) = testOracle.observations(index);
        assertEq(got, cents, name);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Real fixture, tampered in-memory (real-modulus oracle)
    // ─────────────────────────────────────────────────────────────────────────

    function test_real_bodyByteFlip_reverts_BadBodyHash() public {
        bytes memory b = realBody;
        b[b.length / 2] ^= 0x01;
        vm.expectRevert(CredailyRentOracle.BadBodyHash.selector);
        realOracle.submitObservation(realHeaders, b, realSig);
    }

    function test_real_truncatedBody_reverts_BadBodyHash() public {
        bytes memory b = realBody;
        // shorten by hacking the length word — contents identical, hash different
        assembly ("memory-safe") {
            mstore(b, sub(mload(b), 1))
        }
        vm.expectRevert(CredailyRentOracle.BadBodyHash.selector);
        realOracle.submitObservation(realHeaders, b, realSig);
    }

    function test_real_headerByteFlip_reverts_BadSignature() public {
        bytes memory h = realHeaders;
        h[10] ^= 0x01; // inside the content-type line, tag policy untouched
        vm.expectRevert(CredailyRentOracle.BadSignature.selector);
        realOracle.submitObservation(h, realBody, realSig);
    }

    function test_real_sigByteFlip_reverts_BadSignature() public {
        bytes memory s = realSig;
        s[0] ^= 0x01;
        vm.expectRevert(CredailyRentOracle.BadSignature.selector);
        realOracle.submitObservation(realHeaders, realBody, s);
    }

    function test_real_wrongSigLength_reverts() public {
        bytes memory s = new bytes(255);
        vm.expectRevert(abi.encodeWithSelector(Dkim.BadLength.selector, "sig"));
        realOracle.submitObservation(realHeaders, realBody, s);
    }

    function test_real_futureClock_reverts_BadTimestamp() public {
        // the email's own t= must not be > now + 1 day: rewind the chain clock
        vm.warp(TEST_NOW - 2 days);
        vm.expectRevert(CredailyRentOracle.BadTimestamp.selector);
        realOracle.submitObservation(realHeaders, realBody, realSig);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Synthetic matrix — positive branches (test-modulus oracle)
    // ─────────────────────────────────────────────────────────────────────────

    function test_syn_okBasic_9288() public {
        _expectOk("ok-basic", 9288);
    }

    function test_syn_okValue_100_00() public {
        _expectOk("ok-value-100-00", 10000);
    }

    function test_syn_okValue_9_99() public {
        _expectOk("ok-value-9-99", 999);
    }

    function test_syn_okValue_1234_56() public {
        _expectOk("ok-value-1234-56", 123456);
    }

    function test_syn_okQpEscapedValue_9288() public {
        _expectOk("ok-qp-escaped-value", 9288);
    }

    function test_syn_replay_reverts_AlreadyRecorded() public {
        _submit("ok-basic");
        vm.expectRevert(CredailyRentOracle.AlreadyRecorded.selector);
        _submit("ok-basic");
    }

    function test_syn_okBasic_againstRealKey_reverts_BadSignature() public {
        (bytes memory h, bytes memory b, bytes memory s) = _load("ok-basic");
        vm.expectRevert(CredailyRentOracle.BadSignature.selector);
        realOracle.submitObservation(h, b, s);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Synthetic matrix — tag policy branches
    // ─────────────────────────────────────────────────────────────────────────

    function _expectPolicy(string memory name, string memory tag) internal {
        vm.expectRevert(abi.encodeWithSelector(CredailyRentOracle.BadTagPolicy.selector, tag));
        _submit(name);
    }

    function test_syn_wrongDomain() public {
        _expectPolicy("wrong-domain", "d");
    }

    function test_syn_wrongSelector() public {
        _expectPolicy("wrong-selector", "s");
    }

    function test_syn_wrongVersion() public {
        _expectPolicy("wrong-version", "v");
    }

    function test_syn_wrongAlgo() public {
        _expectPolicy("wrong-algo", "a");
    }

    function test_syn_wrongCanon() public {
        _expectPolicy("wrong-canon", "c");
    }

    function test_syn_lTagPresent() public {
        _expectPolicy("has-l-tag", "l");
    }

    function test_syn_nonEmptyB() public {
        _expectPolicy("nonempty-b", "b");
    }

    function test_syn_missingFrom() public {
        vm.expectRevert(CredailyRentOracle.MissingFrom.selector);
        _submit("missing-from");
    }

    function test_syn_futureT() public {
        vm.expectRevert(CredailyRentOracle.BadTimestamp.selector);
        _submit("future-t");
    }

    function test_syn_missingT() public {
        vm.expectRevert(CredailyRentOracle.BadTimestamp.selector);
        _submit("missing-t");
    }

    function test_syn_duplicateDTag() public {
        vm.expectRevert(abi.encodeWithSelector(Dkim.DuplicateTag.selector, "d"));
        _submit("duplicate-d-tag");
    }

    function test_syn_trailingCrlf() public {
        vm.expectRevert(CredailyRentOracle.MissingDkimLine.selector);
        _submit("trailing-crlf");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Synthetic matrix — crypto branches
    // ─────────────────────────────────────────────────────────────────────────

    function test_syn_tamperedBody() public {
        vm.expectRevert(CredailyRentOracle.BadBodyHash.selector);
        _submit("tampered-body");
    }

    function test_syn_tamperedSig() public {
        vm.expectRevert(CredailyRentOracle.BadSignature.selector);
        _submit("tampered-sig");
    }

    function test_syn_tamperedHeaders() public {
        vm.expectRevert(CredailyRentOracle.BadSignature.selector);
        _submit("tampered-headers");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Synthetic matrix — extraction branches
    // ─────────────────────────────────────────────────────────────────────────

    function test_syn_duplicateAnchor() public {
        vm.expectRevert(abi.encodeWithSelector(CredailyRentOracle.AnchorNotUnique.selector, 2));
        _submit("duplicate-anchor");
    }

    function test_syn_zeroValue() public {
        vm.expectRevert(CredailyRentOracle.SnapshotNotFound.selector);
        _submit("zero-value");
    }

    function test_syn_valueOverflow() public {
        vm.expectRevert(Dkim.ValueOverflow.selector);
        _submit("value-overflow");
    }

    function test_syn_noLabel() public {
        vm.expectRevert(CredailyRentOracle.SnapshotNotFound.selector);
        _submit("no-label");
    }

    function test_syn_labelTooFar() public {
        vm.expectRevert(CredailyRentOracle.SnapshotNotFound.selector);
        _submit("label-too-far");
    }

    function test_syn_badSuffix() public {
        vm.expectRevert(CredailyRentOracle.SnapshotNotFound.selector);
        _submit("bad-suffix");
    }
}
