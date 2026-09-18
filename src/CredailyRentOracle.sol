// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Dkim} from "./lib/Dkim.sol";

/// @title CredailyRentOracle
/// @notice Permissionless, ownerless registry of CRE Daily "Market Snapshot" observations
///         (Manhattan Office Rent, Avg Effective $/SF), each proven by an on-chain DKIM
///         (RFC 6376) verification of the newsletter email: relaxed-canonicalized body +
///         signed-header block + RSA-2048/SHA-256 signature against the pinned SendGrid
///         key for `b37._domainkey.newyork.credaily.com`.
/// @dev    Anyone may submit any authentic snapshot email; recording is append-only.
///         See docs/PROTOCOL.md for the settlement statement and trust assumptions.
contract CredailyRentOracle {
    using Dkim for bytes;

    // ─────────────────────────────────────────────────────────────────────────
    // Types / events / errors
    // ─────────────────────────────────────────────────────────────────────────

    struct Observation {
        uint64 t; // DKIM signature timestamp (t= tag)
        uint32 cents; // Avg Effective rent, USD cents per SF
        bytes32 emailId; // sha256 of the canonical body (== the body hash bh)
    }

    event ObservationRecorded(uint256 indexed index, uint64 t, uint32 cents, bytes32 emailId, address submitter);

    error BadModulus();
    error AlreadyRecorded();
    error MissingFrom();
    error MissingDkimLine();
    error BadTagPolicy(string tag);
    error BadBodyHash();
    error BadTimestamp();
    error BadSignature();
    error AnchorNotUnique(uint256 count);
    error SnapshotNotFound();

    // ─────────────────────────────────────────────────────────────────────────
    // Pinned key + policy constants
    // ─────────────────────────────────────────────────────────────────────────

    string public constant DOMAIN = "newyork.credaily.com";
    string public constant SELECTOR = "b37";

    /// @notice The exact `from:` address; the signed from line must END with this
    ///         (canonical form puts the addr-spec in angle brackets last), so a
    ///         display-name containing the needle can never satisfy the check.
    bytes internal constant FROM_NEEDLE = "<mail@newyork.credaily.com>";

    /// @notice keccak256 of the pinned 256-byte RSA modulus.
    bytes32 public immutable MODULUS_HASH;

    /// @dev Pinned RSA-2048 modulus (256 bytes, big-endian), set once at deployment.
    bytes internal _modulus;

    // ─────────────────────────────────────────────────────────────────────────
    // Storage
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Append-only observation log; public getter `observations(uint256)`.
    Observation[] public observations;

    /// @dev emailId (body hash) → recorded, for replay protection.
    mapping(bytes32 emailId => bool) public recorded;

    constructor(bytes memory modulus_) {
        if (modulus_.length != 256) revert BadModulus();
        _modulus = modulus_;
        MODULUS_HASH = keccak256(modulus_);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────────

    function observationCount() external view returns (uint256) {
        return observations.length;
    }

    function modulus() external view returns (bytes memory) {
        return _modulus;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Submission
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Verifies a CRE Daily snapshot email and appends its observation.
    /// @param signedHeaders Relaxed-canonicalized signed header block, RFC 6376 h=
    ///        consumption order, terminated by the canonical `dkim-signature:` line
    ///        with the b= value emptied, no trailing CRLF.
    /// @param canonBody Relaxed-canonicalized body.
    /// @param sig 256-byte RSA signature (the original b= value, base64-decoded).
    function submitObservation(bytes calldata signedHeaders, bytes calldata canonBody, bytes calldata sig) external {
        // 1. Body hash doubles as the replay id.
        bytes32 bh32 = sha256(canonBody);
        bytes32 emailId = bh32;
        if (recorded[emailId]) revert AlreadyRecorded();

        // 2. Header-block policy.
        if (!_hasCredailyFromLine(signedHeaders)) revert MissingFrom();
        bytes calldata dkimLine = _trailingDkimLine(signedHeaders);
        Dkim.DkimTags memory tags = Dkim.parseDkimTags(dkimLine);
        if (keccak256(bytes(tags.v)) != keccak256("1")) revert BadTagPolicy("v");
        if (keccak256(bytes(tags.a)) != keccak256("rsa-sha256")) revert BadTagPolicy("a");
        if (keccak256(bytes(tags.c)) != keccak256("relaxed/relaxed")) revert BadTagPolicy("c");
        if (keccak256(bytes(tags.d)) != keccak256(bytes(DOMAIN))) revert BadTagPolicy("d");
        if (keccak256(bytes(tags.s)) != keccak256(bytes(SELECTOR))) revert BadTagPolicy("s");
        if (tags.hasL) revert BadTagPolicy("l");
        if (!tags.bEmpty) revert BadTagPolicy("b");
        if (keccak256(bytes(tags.bhB64)) != keccak256(bytes(Dkim.base64Encode32(bh32)))) revert BadBodyHash();
        if (tags.t == 0) revert BadTimestamp(); // t= absent or zero
        if (tags.t > block.timestamp + 1 days) revert BadTimestamp();

        // 3. RSA-2048 PKCS#1 v1.5 signature over the signed header block.
        if (!Dkim.rsaVerify(sig, sha256(signedHeaders), _modulus)) revert BadSignature();

        // 4. Value extraction from the (QP-encoded) body.
        (uint256 cents, uint256 anchors) = Dkim.extractSnapshot(canonBody);
        if (anchors != 1) revert AnchorNotUnique(anchors);
        if (cents == 0) revert SnapshotNotFound();

        // 5. Record.
        observations.push(Observation({t: tags.t, cents: uint32(cents), emailId: emailId}));
        recorded[emailId] = true;
        emit ObservationRecorded(observations.length - 1, tags.t, uint32(cents), emailId, msg.sender);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internal header scanning
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev True iff `signedHeaders` contains, at a line boundary (offset 0 or right
    ///      after CRLF), a line starting `from:` that ENDS with the FROM_NEEDLE
    ///      address. Header names are lowercase after relaxed canonicalization, so
    ///      the match is exact-case. (SPEC 2.2 froze a "contains" rule; tightened to
    ///      suffix after review — a display name containing the needle before a
    ///      different real sender must not pass.)
    function _hasCredailyFromLine(bytes calldata signedHeaders) internal pure returns (bool) {
        bytes memory needle = FROM_NEEDLE;
        uint256 len = signedHeaders.length;
        uint256 lineStart = 0;
        while (lineStart < len) {
            // find end of line
            uint256 lineEnd = lineStart;
            while (lineEnd + 1 < len && !(signedHeaders[lineEnd] == 0x0d && signedHeaders[lineEnd + 1] == 0x0a)) {
                ++lineEnd;
            }
            if (lineEnd + 1 >= len) lineEnd = len; // last line, no CRLF

            if (_startsWith(signedHeaders, lineStart, "from:") && _endsWith(signedHeaders, lineStart, lineEnd, needle))
            {
                return true;
            }
            if (lineEnd == len) break;
            lineStart = lineEnd + 2; // skip CRLF
        }
        return false;
    }

    /// @dev Returns the trailing line of `signedHeaders` (after the last CRLF; the whole
    ///      buffer when it has none) and requires it to start with `dkim-signature:`.
    ///      A trailing CRLF would make the trailing line empty and revert here, which
    ///      enforces the "no trailing CRLF" rule.
    function _trailingDkimLine(bytes calldata signedHeaders) internal pure returns (bytes calldata) {
        uint256 len = signedHeaders.length;
        uint256 start = 0;
        for (uint256 i = len; i >= 2; --i) {
            if (signedHeaders[i - 2] == 0x0d && signedHeaders[i - 1] == 0x0a) {
                start = i;
                break;
            }
        }
        if (!_startsWith(signedHeaders, start, "dkim-signature:")) revert MissingDkimLine();
        return signedHeaders[start:];
    }

    function _startsWith(bytes calldata data, uint256 offset, bytes memory prefix) private pure returns (bool) {
        if (offset + prefix.length > data.length) return false;
        for (uint256 i = 0; i < prefix.length; ++i) {
            if (data[offset + i] != prefix[i]) return false;
        }
        return true;
    }

    /// @dev True iff data[start:stop) ends with `needle` (and is long enough to).
    function _endsWith(bytes calldata data, uint256 start, uint256 stop, bytes memory needle)
        private
        pure
        returns (bool)
    {
        uint256 n = needle.length;
        if (stop > data.length || n == 0 || start + n > stop) return false;
        uint256 from = stop - n;
        for (uint256 j = 0; j < n; ++j) {
            if (data[from + j] != needle[j]) return false;
        }
        return true;
    }
}
