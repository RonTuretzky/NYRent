// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CredailyRentOracle} from "../src/CredailyRentOracle.sol";
import {CredailyKey} from "../src/gen/CredailyKey.sol";
import {ChunkedObservationSubmitter} from "../src/ChunkedObservationSubmitter.sol";

contract ChunkedObservationSubmitterTest is Test {
    ChunkedObservationSubmitter internal helper;
    CredailyRentOracle internal oracle;
    bytes internal body;
    bytes internal headers;
    bytes internal sig;
    bytes32 internal bodyHash;
    address[] internal chunks;

    function setUp() public {
        helper = new ChunkedObservationSubmitter();
        oracle = new CredailyRentOracle(CredailyKey.MODULUS);
        body = vm.readFileBinary("fixtures/credaily-2026-09-17/canon-body.bin");
        headers = vm.readFileBinary("fixtures/credaily-2026-09-17/signed-headers.bin");
        sig = vm.readFileBinary("fixtures/credaily-2026-09-17/sig.bin");
        bodyHash = sha256(body);
        vm.warp(1789642464);
        bytes memory realBody = body;
        for (uint256 start; start < realBody.length; start += 24000) {
            uint256 length = realBody.length - start;
            if (length > 24000) length = 24000;
            bytes memory part = new bytes(length);
            for (uint256 i; i < length; ++i) {
                part[i] = realBody[start + i];
            }
            chunks.push(helper.store(part));
        }
    }

    function test_realEmailAuthenticatesIdentically() public {
        assertEq(chunks.length, 5);
        helper.submit(oracle, chunks, bodyHash, headers, sig, "");
        (uint64 t, uint32 cents, bytes32 emailId) = oracle.observations(0);
        assertEq(t, 1789642464);
        assertEq(cents, 9288);
        assertEq(emailId, sha256(body));
        vm.expectRevert(CredailyRentOracle.AlreadyRecorded.selector);
        helper.submit(oracle, chunks, bodyHash, headers, sig, "");
    }

    function test_hybridTransportUsesOneStoredChunkAndFitsAdmission() public {
        address[] memory prefix = new address[](1);
        prefix[0] = chunks[0];
        bytes memory wholeBody = body;
        bytes memory tail = new bytes(wholeBody.length - 24000);
        for (uint256 i; i < tail.length; ++i) {
            tail[i] = wholeBody[i + 24000];
        }
        bytes memory callData = abi.encodeCall(helper.submit, (oracle, prefix, bodyHash, headers, sig, tail));
        assertLt(callData.length, 90000, "below 95KB tx admission with signature headroom");
        helper.submit(oracle, prefix, bodyHash, headers, sig, tail);
        (, uint32 cents, bytes32 id) = oracle.observations(0);
        assertEq(cents, 9288);
        assertEq(id, bodyHash);
    }

    function test_reorderingAndMissingChunksReject() public {
        address first = chunks[0];
        chunks[0] = chunks[1];
        chunks[1] = first;
        vm.expectRevert(ChunkedObservationSubmitter.BodyHashMismatch.selector);
        helper.submit(oracle, chunks, bodyHash, headers, sig, "");
        chunks.pop();
        vm.expectRevert(ChunkedObservationSubmitter.BodyHashMismatch.selector);
        helper.submit(oracle, chunks, bodyHash, headers, sig, "");
        assertEq(oracle.observationCount(), 0);
    }

    function test_helperCannotBypassSignature() public {
        bytes memory badSig = sig;
        badSig[0] = bytes1(uint8(badSig[0]) ^ 1);
        vm.expectRevert(CredailyRentOracle.BadSignature.selector);
        helper.submit(oracle, chunks, bodyHash, headers, badSig, "");
        assertEq(oracle.observationCount(), 0);
    }

    function test_invalidAddressesAndSizesReject() public {
        vm.expectRevert(ChunkedObservationSubmitter.InvalidChunk.selector);
        helper.store("");
        vm.expectRevert(ChunkedObservationSubmitter.InvalidChunk.selector);
        helper.store(new bytes(24001));
        chunks[0] = address(0x1234);
        vm.expectRevert(ChunkedObservationSubmitter.InvalidChunk.selector);
        helper.submit(oracle, chunks, bodyHash, headers, sig, "");
    }

    function testFuzz_chunkBytesPreserved(bytes memory data) public {
        vm.assume(data.length > 0 && data.length <= 24000);
        address chunk = helper.store(data);
        bytes memory code = chunk.code;
        assertEq(code, bytes.concat(hex"00", data));
    }
}
