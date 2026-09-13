// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {RSA} from "@openzeppelin/contracts/utils/cryptography/RSA.sol";
import {B} from "./Bytes.sol";

/// @notice Verifies the exact signed RFC6376 relaxed header/body representation.
/// The untrusted client only constructs a witness. No extracted price is accepted here.
contract DkimVerifier {
    struct Identity {
        bytes domain;
        bytes selector;
        bytes from;
        bytes contentType;
        bytes encoding;
        bytes listId;
        uint256 signedAt;
    }
    error InvalidDKIM();
    error UnsupportedDKIM();
    error BodyHashMismatch();
    error BadSignature();

    function inspect(bytes memory headers, bytes memory body) public view returns (Identity memory who) {
        if (headers.length == 0 || headers.length > 16384 || body.length > 65536) {
            revert UnsupportedDKIM();
        }
        bytes[] memory names = new bytes[](64);
        bytes[] memory values = new bytes[](64);
        uint256 count;
        uint256 p;
        bytes memory dkim;
        while (p < headers.length) {
            uint256 end = B.find(headers, "\r\n", p);
            bool last = end == type(uint256).max;
            if (last) {
                end = headers.length;
            }
            bytes memory line = B.slice(headers, p, end - p);
            uint256 colon = B.find(line, ":", 0);
            if (colon == 0 || colon == type(uint256).max || count == 64) {
                revert InvalidDKIM();
            }
            bytes memory name = B.slice(line, 0, colon);
            bytes memory value = B.slice(line, colon + 1, line.length - colon - 1);
            for (uint256 i; i < name.length; ++i) {
                if (!((name[i] >= 0x61 && name[i] <= 0x7a) || name[i] == 0x2d)) {
                    revert InvalidDKIM();
                }
            }
            // Relaxed header form has no tabs/folds, or leading/trailing/duplicate spaces.
            for (uint256 i; i < value.length; ++i) {
                if (value[i] == 0x0a || value[i] == 0x0d || value[i] == 0x09 || value[i] == 0x00) {
                    revert InvalidDKIM();
                }
                if (value[i] == 0x20 && (i == 0 || i + 1 == value.length || value[i - 1] == 0x20)) {
                    revert InvalidDKIM();
                }
            }
            if (B.eq(name, "dkim-signature")) {
                if (!last) {
                    revert InvalidDKIM();
                }
                dkim = value;
                break;
            }
            if (last) {
                revert InvalidDKIM();
            }
            for (uint256 i; i < count; ++i) {
                if (B.eq(names[i], name)) {
                    revert UnsupportedDKIM();
                }
            }
            names[count] = name;
            values[count++] = value;
            p = end + 2;
        }
        B.TagSet memory dt = B.parseTags(dkim);
        if (
            dkim.length == 0 || !B.eq(B.must(dt, "v"), "1") || !B.eq(B.must(dt, "a"), "rsa-sha256")
                || !B.eq(B.must(dt, "c"), "relaxed/relaxed")
        ) {
            revert UnsupportedDKIM();
        }
        (, bool has) = B.get(dt, "l");
        if (has) {
            revert UnsupportedDKIM();
        }
        if (B.must(dt, "b").length != 0) {
            revert InvalidDKIM();
        }
        who.domain = B.must(dt, "d");
        who.selector = B.must(dt, "s");
        B.dns(who.domain);
        B.dns(who.selector);
        who.signedAt = B.uintDec(B.must(dt, "t"));
        if (who.signedAt > block.timestamp) {
            revert InvalidDKIM();
        }
        (bytes memory expiry, bool exp) = B.get(dt, "x");
        if (exp && (B.uintDec(expiry) <= block.timestamp || B.uintDec(expiry) <= who.signedAt)) {
            revert InvalidDKIM();
        }
        // Serialized fields must follow the authenticated h= list. Absent oversigned fields are allowed.
        bytes memory hs = B.must(dt, "h");
        uint256 hi;
        uint256 used;
        while (hi < hs.length) {
            uint256 he = B.find(hs, ":", hi);
            if (he == type(uint256).max) {
                he = hs.length;
            }
            bytes memory name = B.lower(B.trim(B.slice(hs, hi, he - hi)));
            hi = he + 1;
            if (used < count && B.eq(name, names[used])) {
                ++used;
            } else {
                // A missing field contributes zero bytes under RFC6376. It cannot be used for identity.
                for (uint256 j = used; j < count; ++j) {
                    if (B.eq(name, names[j])) {
                        revert InvalidDKIM();
                    }
                }
            }
        }
        if (used != count) {
            revert InvalidDKIM();
        }
        bool foundFrom;
        bool foundType;
        bool foundEncoding;
        for (uint256 i; i < count; ++i) {
            if (B.eq(names[i], "from")) {
                who.from = values[i];
                foundFrom = true;
            }
            if (B.eq(names[i], "content-type")) {
                who.contentType = values[i];
                foundType = true;
            }
            if (B.eq(names[i], "content-transfer-encoding")) {
                who.encoding = values[i];
                foundEncoding = true;
            }
            if (B.eq(names[i], "list-id")) {
                who.listId = values[i];
            }
        }
        if (!foundFrom || !foundType || !foundEncoding) {
            revert UnsupportedDKIM();
        }
        // Authenticate the complete canonical body. No l= partial signing or unsigned body suffix.
        if (!B.eq(body, canonicalBody(body))) {
            revert InvalidDKIM();
        }
        bytes memory bh = B.b64(B.must(dt, "bh"));
        if (bh.length != 32 || bytes32(bh) != sha256(body)) {
            revert BodyHashMismatch();
        }
    }

    function verifySignature(bytes memory headers, bytes memory signature, bytes memory modulus) external view {
        if (!RSA.pkcs1Sha256(sha256(headers), signature, hex"010001", modulus)) {
            revert BadSignature();
        }
    }

    function verify(bytes memory headers, bytes memory body, bytes memory signature, bytes memory modulus)
        external
        view
        returns (Identity memory who)
    {
        who = inspect(headers, body);
        if (!RSA.pkcs1Sha256(sha256(headers), signature, hex"010001", modulus)) {
            revert BadSignature();
        }
    }

    function canonicalBody(bytes memory data) public pure returns (bytes memory out) {
        out = new bytes(data.length + 2);
        uint256 n;
        bool space;
        uint256 lastContent;
        for (uint256 i; i < data.length; ++i) {
            bytes1 c = data[i];
            if (c == 0x20 || c == 0x09) {
                space = true;
                continue;
            }
            if (c == 0x0d) {
                if (i + 1 >= data.length || data[++i] != 0x0a) {
                    revert InvalidDKIM();
                }
                space = false;
                out[n++] = 0x0d;
                out[n++] = 0x0a;
                continue;
            }
            if (c == 0x0a || c == 0x00) {
                revert InvalidDKIM();
            }
            if (space) {
                out[n++] = 0x20;
                space = false;
            }
            out[n++] = c;
            lastContent = n;
        }
        // relaxed empty body hashes an empty string, unlike simple canonicalization.
        n = lastContent;
        if (n != 0) {
            out[n++] = 0x0d;
            out[n++] = 0x0a;
        }
        assembly ("memory-safe") { mstore(out, n) }
    }
}
