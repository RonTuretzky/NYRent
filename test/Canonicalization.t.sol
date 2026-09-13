// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {DkimVerifier} from "../contracts/DkimVerifier.sol";
import {B} from "../contracts/Bytes.sol";

contract CanonicalizationTest {
    DkimVerifier verifier = new DkimVerifier();

    function testFuzzRelaxedBodyIdempotent(bytes memory seed) public view {
        uint256 len = seed.length > 256 ? 256 : seed.length;
        bytes memory raw = new bytes(len * 2);
        uint256 n;
        for (uint256 i; i < len; ++i) {
            uint256 c = uint8(seed[i]) % 5;
            if (c == 0) {
                raw[n++] = 0x0d;
                raw[n++] = 0x0a;
            } else if (c == 1) {
                raw[n++] = 0x09;
            } else if (c == 2) {
                raw[n++] = 0x20;
            } else {
                raw[n++] = bytes1(uint8(97 + c));
            }
        }
        assembly ("memory-safe") { mstore(raw, n) }
        bytes memory once = verifier.canonicalBody(raw);
        require(B.eq(once, verifier.canonicalBody(once)), "not idempotent");
    }

    function testRFCRelaxedWhitespaceExample() public view {
        require(B.eq(verifier.canonicalBody(" C \tD \t E\r\n\r\n\r\n"), " C D E\r\n"), "canonicalization");
        require(verifier.canonicalBody(" \r\n\t\r\n").length == 0, "empty hash input");
    }
}
