// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CredailyKey} from "../src/gen/CredailyKey.sol";
import {Dkim} from "../src/lib/Dkim.sol";
import {DkimHarness} from "./utils/Helpers.sol";

/// @notice Unit tests for the {Dkim} library plus DIFFERENTIAL tests: the
///         assembly-accelerated extractSnapshot must agree byte-for-byte with the
///         straightforward reference port (test/utils/Helpers.sol) on the real
///         fixture, every synthetic fixture, and fuzz-composed QP bodies.
contract DkimTest is Test {
    DkimHarness internal h;
    bytes internal realHeaders;
    bytes internal realBody;
    bytes internal realSig;

    function setUp() public {
        h = new DkimHarness();
        realHeaders = vm.readFileBinary("fixtures/credaily-2026-09-17/signed-headers.bin");
        realBody = vm.readFileBinary("fixtures/credaily-2026-09-17/canon-body.bin");
        realSig = vm.readFileBinary("fixtures/credaily-2026-09-17/sig.bin");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // rsaVerify
    // ─────────────────────────────────────────────────────────────────────────

    function test_rsaVerify_realSignature() public view {
        assertTrue(h.rsaVerify(realSig, sha256(realHeaders), CredailyKey.MODULUS));
    }

    function test_rsaVerify_wrongDigest() public view {
        assertFalse(h.rsaVerify(realSig, sha256("nope"), CredailyKey.MODULUS));
    }

    function test_rsaVerify_flippedSig() public view {
        bytes memory s = realSig;
        s[128] ^= 0x40;
        assertFalse(h.rsaVerify(s, sha256(realHeaders), CredailyKey.MODULUS));
    }

    function test_rsaVerify_badLengths() public {
        vm.expectRevert(abi.encodeWithSelector(Dkim.BadLength.selector, "sig"));
        h.rsaVerify(new bytes(257), bytes32(0), CredailyKey.MODULUS);
        vm.expectRevert(abi.encodeWithSelector(Dkim.BadLength.selector, "modulus"));
        h.rsaVerify(new bytes(256), bytes32(0), new bytes(255));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // base64Encode32
    // ─────────────────────────────────────────────────────────────────────────

    function test_base64Encode32_realBodyHash() public view {
        // ground truth from meta.json: bh of the verified email
        assertEq(h.base64Encode32(sha256(realBody)), "XO8VsgH6yzZkDP1Z0WZojXMdOoa4j1i17epBk4K5SOE=");
    }

    function test_base64Encode32_knownVectors() public view {
        assertEq(h.base64Encode32(bytes32(0)), "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
        // sha256("") — canonical vector
        assertEq(h.base64Encode32(sha256("")), "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // parseDkimTags
    // ─────────────────────────────────────────────────────────────────────────

    function _realDkimLine() internal view returns (bytes memory line) {
        // trailing line of the signed header block = after the last CRLF
        bytes memory hdrs = realHeaders;
        uint256 start = 0;
        for (uint256 i = hdrs.length; i >= 2; --i) {
            if (hdrs[i - 2] == "\r" && hdrs[i - 1] == "\n") {
                start = i;
                break;
            }
        }
        line = new bytes(hdrs.length - start);
        for (uint256 i = 0; i < line.length; ++i) {
            line[i] = hdrs[start + i];
        }
    }

    function test_parseDkimTags_realLine() public view {
        Dkim.DkimTags memory tags = h.parseDkimTags(_realDkimLine());
        assertEq(tags.v, "1");
        assertEq(tags.a, "rsa-sha256");
        assertEq(tags.c, "relaxed/relaxed");
        assertEq(tags.d, "newyork.credaily.com");
        assertEq(tags.s, "b37");
        assertEq(tags.t, 1789642464);
        assertEq(tags.bhB64, "XO8VsgH6yzZkDP1Z0WZojXMdOoa4j1i17epBk4K5SOE=");
        assertFalse(tags.hasL);
        assertTrue(tags.bEmpty);
    }

    function test_parseDkimTags_duplicateReverts() public {
        vm.expectRevert(abi.encodeWithSelector(Dkim.DuplicateTag.selector, "s"));
        h.parseDkimTags("dkim-signature:v=1; s=a; s=b; b=");
    }

    function test_parseDkimTags_missingEqualsReverts() public {
        vm.expectRevert(Dkim.MalformedTag.selector);
        h.parseDkimTags("dkim-signature:v=1; garbage; b=");
    }

    function test_parseDkimTags_wrongPrefixReverts() public {
        vm.expectRevert(Dkim.MalformedTag.selector);
        h.parseDkimTags("x-signature:v=1; b=");
    }

    function test_parseDkimTags_badTimestampReverts() public {
        vm.expectRevert(Dkim.BadTimestampTag.selector);
        h.parseDkimTags("dkim-signature:v=1; t=12x4; b=");
    }

    function test_parseDkimTags_unknownTagsIgnored() public view {
        Dkim.DkimTags memory tags = h.parseDkimTags("dkim-signature:v=1; z=whatever; h=from:to; i=@x.com; t=5; b=");
        assertEq(tags.v, "1");
        assertEq(tags.t, 5);
        assertTrue(tags.bEmpty);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // extractSnapshot: goldens + differential vs the reference port
    // ─────────────────────────────────────────────────────────────────────────

    function _assertSameExtraction(bytes memory body) internal view {
        (bool okA, bytes memory retA) = address(h).staticcall(abi.encodeCall(DkimHarness.extractSnapshot, (body)));
        (bool okB, bytes memory retB) =
            address(h).staticcall(abi.encodeCall(DkimHarness.extractSnapshotReference, (body)));
        assertEq(okA, okB, "success mismatch");
        assertEq(retA, retB, "output mismatch");
    }

    function test_extract_realBody_golden() public view {
        (uint256 cents, uint256 anchors) = h.extractSnapshot(realBody);
        assertEq(cents, 9288);
        assertEq(anchors, 1);
        _assertSameExtraction(realBody);
    }

    function test_extract_allSyntheticFixtures_matchReference() public view {
        string[26] memory names = [
            "ok-basic",
            "ok-value-100-00",
            "ok-value-9-99",
            "ok-value-1234-56",
            "ok-qp-escaped-value",
            "wrong-domain",
            "wrong-selector",
            "wrong-version",
            "wrong-algo",
            "wrong-canon",
            "has-l-tag",
            "nonempty-b",
            "missing-from",
            "future-t",
            "missing-t",
            "duplicate-d-tag",
            "trailing-crlf",
            "tampered-body",
            "tampered-sig",
            "tampered-headers",
            "duplicate-anchor",
            "zero-value",
            "value-overflow",
            "no-label",
            "label-too-far",
            "bad-suffix"
        ];
        for (uint256 i = 0; i < names.length; ++i) {
            bytes memory body = vm.readFileBinary(string.concat("fixtures/synthetic/", names[i], "/canon-body.bin"));
            _assertSameExtraction(body);
        }
    }

    function test_extract_edgeBodies() public view {
        _assertSameExtraction("");
        _assertSameExtraction("=");
        _assertSameExtraction("==");
        _assertSameExtraction("=\r\n");
        _assertSameExtraction("=4");
        _assertSameExtraction("=4D");
        _assertSameExtraction("=4d");
        _assertSameExtraction("M");
        _assertSameExtraction("Manhattan Office Rent");
        _assertSameExtraction("MManhattan Office Rent Avg Effective $1.00 / SF");
        _assertSameExtraction("Manhattan Office Rent Avg Effective $92.88 / SF");
        _assertSameExtraction("Manhattan Office Rent Avg Effective $ 92.88  / SF"); // double space breaks suffix
        _assertSameExtraction("Manhattan Office Rent Avg Effective =2492.88 =2F SF");
        _assertSameExtraction("Manhatta=6E Office Rent Avg Effective $92.88 / SF"); // =6E → 'n'
        _assertSameExtraction("=4Danhattan Office Rent Avg Effective $92.88 / SF"); // =4D → 'M'
    }

    /// @dev Fuzz raw bytes straight through both implementations.
    function testFuzz_extract_rawBytes_matchReference(bytes memory raw) public view {
        if (raw.length > 2048) return;
        _assertSameExtraction(raw);
    }

    /// @dev Fuzz STRUCTURED bodies: each seed byte appends one token drawn from a
    ///      dictionary of grammar fragments (anchor, label, money pieces, QP escapes,
    ///      soft breaks, near-miss text), hitting the interesting machine paths far
    ///      more often than raw bytes would.
    function testFuzz_extract_structured_matchReference(bytes memory seed) public view {
        if (seed.length > 48) return;
        bytes memory body;
        for (uint256 i = 0; i < seed.length; ++i) {
            uint8 c = uint8(seed[i]) % 16;
            if (c == 0) body = bytes.concat(body, "Manhattan Office Rent");
            else if (c == 1) body = bytes.concat(body, "Avg Effective");
            else if (c == 2) body = bytes.concat(body, "$");
            else if (c == 3) body = bytes.concat(body, "92.88");
            else if (c == 4) body = bytes.concat(body, " / SF");
            else if (c == 5) body = bytes.concat(body, "=\r\n");
            else if (c == 6) body = bytes.concat(body, "=4D");
            else if (c == 7) body = bytes.concat(body, "=3D");
            else if (c == 8) body = bytes.concat(body, "M");
            else if (c == 9) body = bytes.concat(body, " ");
            else if (c == 10) body = bytes.concat(body, "Manhattan Office Ren");
            else if (c == 11) body = bytes.concat(body, "=2492.=\r\n88 =2F SF");
            else if (c == 12) body = bytes.concat(body, "0");
            else if (c == 13) body = bytes.concat(body, ".");
            else if (c == 14) body = bytes.concat(body, "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
            else body = bytes.concat(body, "=");
        }
        _assertSameExtraction(body);
    }
}
