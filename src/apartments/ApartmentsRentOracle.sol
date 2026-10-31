// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Dkim} from "../lib/Dkim.sol";
import {GoogleAlertParser} from "./GoogleAlertParser.sol";
import {YearMonth} from "./YearMonth.sol";

/// @title ApartmentsRentOracle
/// @notice Permissionless, ownerless log of Apartments.com headline rents, each proven
///         by on-chain DKIM verification of a Google Alerts email against the pinned
///         `20251104._domainkey.google.com` key.
/// @dev    For every (page, month) only the EARLIEST-signed qualifying value is kept,
///         with the lower emailId breaking a same-second tie, so a later email can
///         never replace it and the value does not depend on submission order. Google's signature attests that Google relayed
///         a snippet, not that the publisher's figure is true. Key rotation needs a
///         new deployment; until then no new email verifies and policies void.
contract ApartmentsRentOracle {
    struct Observation {
        uint64 t; // DKIM signature timestamp
        uint32 cents; // headline rent, USD cents per month
        bytes32 emailId; // sha256 of the canonical body
    }

    event ObservationRecorded(
        bytes32 indexed slugHash,
        uint32 indexed yyyymm,
        bytes32 indexed emailId,
        string slug,
        uint64 t,
        uint32 cents,
        bool earliest,
        address submitter
    );

    error BadModulus();
    error AlreadyRecorded();
    error MissingFrom();
    error MissingDkimLine();
    error BadTagPolicy(string tag);
    error BadBodyHash();
    error BadTimestamp();
    error BadSignature();
    error NoQualifyingResult();

    string public constant DOMAIN = "google.com";
    string public constant SELECTOR = "20251104";
    bytes internal constant FROM_NEEDLE = "<googlealerts-noreply@google.com>";

    bytes32 public immutable MODULUS_HASH;
    bytes internal _modulus;

    /// @dev keccak256(slugHash, yyyymm) → earliest signed observation.
    mapping(bytes32 key => Observation) internal _earliest;

    /// @notice emailId (body hash) → recorded, for replay protection.
    mapping(bytes32 emailId => bool) public recorded;

    constructor(bytes memory modulus_) {
        if (modulus_.length != 256) revert BadModulus();
        _modulus = modulus_;
        MODULUS_HASH = keccak256(modulus_);
    }

    function modulus() external view returns (bytes memory) {
        return _modulus;
    }

    /// @notice Earliest signed observation of `slugHash` for `yyyymm`; `t` is zero when
    ///         none exists.
    function earliest(bytes32 slugHash, uint32 yyyymm) external view returns (uint64 t, uint32 cents, bytes32 emailId) {
        Observation storage o = _earliest[keccak256(abi.encode(slugHash, yyyymm))];
        return (o.t, o.cents, o.emailId);
    }

    /// @notice Verifies a Google Alerts email and logs every qualifying result whose
    ///         signature time falls inside the month the sentence names.
    /// @param signedHeaders Relaxed-canonical signed header block ending in the
    ///        `dkim-signature:` line with b= emptied, no trailing CRLF.
    /// @param canonBody Relaxed-canonicalized body.
    /// @param sig 256-byte RSA signature.
    function submitObservation(bytes calldata signedHeaders, bytes calldata canonBody, bytes calldata sig) external {
        bytes32 emailId = sha256(canonBody);
        if (recorded[emailId]) revert AlreadyRecorded();

        if (!_hasFromLine(signedHeaders)) revert MissingFrom();
        Dkim.DkimTags memory tags = Dkim.parseDkimTags(_trailingDkimLine(signedHeaders));
        if (keccak256(bytes(tags.v)) != keccak256("1")) revert BadTagPolicy("v");
        if (keccak256(bytes(tags.a)) != keccak256("rsa-sha256")) revert BadTagPolicy("a");
        if (keccak256(bytes(tags.c)) != keccak256("relaxed/relaxed")) revert BadTagPolicy("c");
        if (keccak256(bytes(tags.d)) != keccak256(bytes(DOMAIN))) revert BadTagPolicy("d");
        if (keccak256(bytes(tags.s)) != keccak256(bytes(SELECTOR))) revert BadTagPolicy("s");
        if (tags.hasL) revert BadTagPolicy("l");
        if (!tags.bEmpty) revert BadTagPolicy("b");
        if (keccak256(bytes(tags.bhB64)) != keccak256(bytes(Dkim.base64Encode32(emailId)))) revert BadBodyHash();
        if (tags.t == 0 || tags.t > block.timestamp + 1 days) revert BadTimestamp();

        if (!Dkim.rsaVerify(sig, sha256(signedHeaders), _modulus)) revert BadSignature();

        GoogleAlertParser.Result[] memory results = GoogleAlertParser.parse(signedHeaders, canonBody);
        bool any;
        for (uint256 i = 0; i < results.length; ++i) {
            GoogleAlertParser.Result memory r = results[i];
            if (!YearMonth.isValid(r.yyyymm)) continue;
            (uint64 start, uint64 end) = YearMonth.bounds(r.yyyymm);
            if (tags.t < start || tags.t > end) continue;

            bytes32 slugHash = keccak256(r.slug);
            Observation storage o = _earliest[keccak256(abi.encode(slugHash, r.yyyymm))];
            bool isEarliest = o.t == 0 || tags.t < o.t || (tags.t == o.t && emailId < o.emailId);
            if (isEarliest) {
                o.t = tags.t;
                o.cents = r.cents;
                o.emailId = emailId;
            }
            any = true;
            emit ObservationRecorded(
                slugHash, r.yyyymm, emailId, string(r.slug), tags.t, r.cents, isEarliest, msg.sender
            );
        }
        if (!any) revert NoQualifyingResult();
        recorded[emailId] = true;
    }

    /// @dev True iff a signed line starts `from:` and ends with the exact address.
    function _hasFromLine(bytes calldata signedHeaders) internal pure returns (bool) {
        bytes memory needle = FROM_NEEDLE;
        uint256 len = signedHeaders.length;
        uint256 lineStart = 0;
        while (lineStart < len) {
            uint256 lineEnd = lineStart;
            while (lineEnd + 1 < len && !(signedHeaders[lineEnd] == 0x0d && signedHeaders[lineEnd + 1] == 0x0a)) {
                ++lineEnd;
            }
            if (lineEnd + 1 >= len) lineEnd = len;
            if (
                lineEnd >= lineStart + 5 + needle.length
                    && keccak256(signedHeaders[lineStart:lineStart + 5]) == keccak256("from:")
                    && keccak256(signedHeaders[lineEnd - needle.length:lineEnd]) == keccak256(needle)
            ) return true;
            if (lineEnd == len) break;
            lineStart = lineEnd + 2;
        }
        return false;
    }

    /// @dev The trailing line must be the dkim-signature line; a trailing CRLF makes it
    ///      empty and reverts.
    function _trailingDkimLine(bytes calldata signedHeaders) internal pure returns (bytes calldata) {
        uint256 len = signedHeaders.length;
        uint256 start = 0;
        for (uint256 i = len; i >= 2; --i) {
            if (signedHeaders[i - 2] == 0x0d && signedHeaders[i - 1] == 0x0a) {
                start = i;
                break;
            }
        }
        bytes memory prefix = "dkim-signature:";
        if (
            start + prefix.length > len
                || keccak256(signedHeaders[start:start + prefix.length]) != keccak256(prefix)
        ) revert MissingDkimLine();
        return signedHeaders[start:];
    }
}
