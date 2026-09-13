// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {DNSSECImpl} from "@ensdomains/ens-contracts/contracts/dnssec-oracle/DNSSECImpl.sol";
import {DNSSEC} from "@ensdomains/ens-contracts/contracts/dnssec-oracle/DNSSEC.sol";
import {RRUtils} from "@ensdomains/ens-contracts/contracts/dnssec-oracle/RRUtils.sol";
import {Algorithm} from "@ensdomains/ens-contracts/contracts/dnssec-oracle/algorithms/Algorithm.sol";
import {RSASHA256Algorithm} from "@ensdomains/ens-contracts/contracts/dnssec-oracle/algorithms/RSASHA256Algorithm.sol";
import {SHA256Digest} from "@ensdomains/ens-contracts/contracts/dnssec-oracle/digests/SHA256Digest.sol";
import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {B} from "./Bytes.sol";

contract DNSP256 is Algorithm {
    function verify(bytes calldata key, bytes calldata data, bytes calldata sig) external view override returns (bool) {
        if (key.length != 68 || sig.length != 64) {
            return false;
        }
        bytes32 r = bytes32(sig[:32]);
        bytes32 s = bytes32(sig[32:]);
        uint256 order = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551;
        if (uint256(s) > order / 2 && uint256(s) < order) {
            s = bytes32(order - uint256(s));
        }
        return P256.verifySolidity(sha256(data), r, s, bytes32(key[4:36]), bytes32(key[36:68]));
    }
}

/// @dev ENS DNSSEC validation code, permanently frozen before construction returns.
/// The ENS contract name contains 'oracle'; no reporter or network call is involved.
contract FrozenDNSSEC is DNSSECImpl {
    constructor(bytes memory rootDS) DNSSECImpl(rootDS) {
        require(rootDS.length > 0, "empty root");
        setAlgorithm(8, new RSASHA256Algorithm());
        setAlgorithm(13, new DNSP256());
        setDigest(2, new SHA256Digest());
        setOwner(address(0));
    }
}

contract KeyProof {
    using RRUtils for *;
    FrozenDNSSEC public immutable dnssec;
    bytes32 public immutable anchorHash;
    error BadKeyProof();

    constructor(FrozenDNSSEC verifier) {
        require(verifier.owner() == address(0), "mutable verifier");
        dnssec = verifier;
        anchorHash = keccak256(verifier.anchors());
    }

    /// @notice Verify fresh DNSSEC chains, including up to three CNAME hops, and return the DKIM RSA modulus.
    function modulus(bytes memory domain, bytes memory selector, DNSSEC.RRSetWithSignature[][] calldata chains)
        external
        view
        returns (bytes memory)
    {
        if (chains.length == 0 || chains.length > 4) {
            revert BadKeyProof();
        }
        bytes memory name = B.dns(bytes.concat(selector, "._domainkey.", domain));
        for (uint256 c; c < chains.length; ++c) {
            if (chains[c].length == 0 || chains[c].length > 16) {
                revert BadKeyProof();
            }
            (bytes memory records,) = dnssec.verifyRRSet(chains[c]);
            RRUtils.RRIterator memory it = records.iterateRRs(0);
            if (it.done() || !B.eq(it.name(), name) || it.class != 1) {
                revert BadKeyProof();
            }
            uint16 kind = it.dnstype;
            bytes memory data = it.rdata();
            it.next();
            // Multiple keys/TXT records for a selector fail closed.
            if (!it.done()) {
                revert BadKeyProof();
            }
            if (kind == 5) {
                if (c + 1 == chains.length || data.length < 2) {
                    revert BadKeyProof();
                }
                name = data;
            } else if (kind == 16) {
                if (c + 1 != chains.length) {
                    revert BadKeyProof();
                }
                return parseKey(txt(data));
            } else {
                revert BadKeyProof();
            }
        }
        revert BadKeyProof();
    }

    function txt(bytes memory data) private pure returns (bytes memory r) {
        uint256 pos;
        while (pos < data.length) {
            uint256 n = uint8(data[pos++]);
            r = bytes.concat(r, B.slice(data, pos, n));
            pos += n;
        }
    }

    function parseKey(bytes memory data) public pure returns (bytes memory n) {
        B.TagSet memory kt = B.parseTags(data);
        (bytes memory v, bool has) = B.get(kt, "v");
        if (has && !B.eq(v, "DKIM1")) {
            revert BadKeyProof();
        }
        (v, has) = B.get(kt, "k");
        if (has && !B.eq(v, "rsa")) {
            revert BadKeyProof();
        }
        (v, has) = B.get(kt, "h");
        if (has && !B.eq(v, "sha256")) {
            revert BadKeyProof();
        }
        (v, has) = B.get(kt, "s");
        if (has && !B.eq(v, "email") && !B.eq(v, "*")) {
            revert BadKeyProof();
        }
        // Test-mode and identity-restricted keys are unsupported, never silently relaxed.
        (, has) = B.get(kt, "t");
        if (has) {
            revert BadKeyProof();
        }
        (, has) = B.get(kt, "g");
        if (has) {
            revert BadKeyProof();
        }
        bytes memory der = B.b64(B.must(kt, "p"));
        (uint256 p, uint256 end) = tlv(der, 0, 0x30);
        if (end != der.length) {
            revert BadKeyProof();
        }
        (uint256 alg, uint256 algEnd) = tlv(der, p, 0x30);
        if (!B.eq(B.slice(der, alg, algEnd - alg), hex"06092a864886f70d0101010500")) {
            revert BadKeyProof();
        }
        (p, end) = tlv(der, algEnd, 0x03);
        if (end != der.length || der[p++] != 0x00) {
            revert BadKeyProof();
        }
        (p, end) = tlv(der, p, 0x30);
        if (end != der.length) {
            revert BadKeyProof();
        }
        (uint256 ns, uint256 ne) = tlv(der, p, 0x02);
        if (der[ns] != 0x00 || ns + 1 >= ne || uint8(der[ns + 1]) < 128) {
            revert BadKeyProof();
        }
        ++ns;
        n = B.slice(der, ns, ne - ns);
        if (
            (n.length != 256 && n.length != 384 && n.length != 512) || uint8(n[0]) < 128
                || uint8(n[n.length - 1]) % 2 != 1
        ) {
            revert BadKeyProof();
        }
        (uint256 es, uint256 ee) = tlv(der, ne, 0x02);
        if (ee != der.length || !B.eq(B.slice(der, es, ee - es), hex"010001")) {
            revert BadKeyProof();
        }
    }

    function tlv(bytes memory d, uint256 p, bytes1 tag) private pure returns (uint256 start, uint256 end) {
        if (p + 2 > d.length || d[p++] != tag) {
            revert BadKeyProof();
        }
        uint256 len = uint8(d[p++]);
        if (len >= 128) {
            uint256 count = len - 128;
            if (count == 0 || count > 2 || p + count > d.length || d[p] == 0x00) {
                revert BadKeyProof();
            }
            len = 0;
            for (uint256 i; i < count; ++i) {
                len = (len << 8) | uint8(d[p++]);
            }
            if (len < 128 || (count == 2 && len < 256)) {
                revert BadKeyProof();
            }
        }
        start = p;
        end = p + len;
        if (end > d.length || len == 0) {
            revert BadKeyProof();
        }
    }
}
