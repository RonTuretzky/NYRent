// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {B} from "./Bytes.sol";
import {DkimVerifier} from "./DkimVerifier.sol";
import {ArchiveRentParser} from "./ArchiveRentParser.sol";

/// @notice Fixed publisher identities, RSA keys and archive-derived parser profiles.
/// No DNSSEC input, key setter, reporter authorization, upgrade or price override.
/// The initial key-to-publisher binding is a deployment assumption.
contract PinnedRentFeed {
    struct Source {
        bytes domain;
        bytes from;
        bytes listId;
        bytes selector;
        bytes modulus;
        uint8 publication;
    }

    struct Email {
        bytes headers;
        bytes body;
        bytes signature;
    }

    struct Month {
        uint64 cents;
        uint16 sources;
        bool conflict;
        bool finalized;
    }
    DkimVerifier public immutable dkim;
    ArchiveRentParser public immutable parser;
    uint16 public immutable quorum;
    bool public immutable testDeployment;
    bytes32 public immutable policyHash;
    uint256 public constant WINDOW = 90 days;
    Source[] private sources;
    mapping(uint32 => Month) public months;
    mapping(uint32 => mapping(uint16 => uint64)) public votes;
    uint32 public latestMonth;
    error IdentityMismatch();
    error OutsideWindow();
    error DuplicatePublication();
    error CannotFinalize();
    error NoFinalRate();
    error StaleRate();
    event Accepted(uint32 indexed month, uint16 indexed source, uint64 cents, bytes32 commitment);
    event Conflict(uint32 indexed month, uint16 indexed source, uint64 previous, uint64 received);
    event Finalized(uint32 indexed month, uint64 cents, uint16 sourceCount);

    constructor(DkimVerifier d, ArchiveRentParser p, Source[] memory config, uint16 q, bool testOnly) {
        require(config.length >= 2 && config.length <= 8 && q >= 2 && q <= config.length, "source policy");
        dkim = d;
        parser = p;
        quorum = q;
        testDeployment = testOnly;
        for (uint256 i; i < config.length; ++i) {
            Source memory s = config[i];
            require(
                s.from.length > 0 && s.from.length <= 512 && s.listId.length <= 512 && s.publication <= 4, "profile"
            );
            B.dns(s.domain);
            B.dns(s.selector);
            require(s.domain.length > 0 && s.selector.length > 0, "identity");
            require(s.modulus.length == 256 || s.modulus.length == 384 || s.modulus.length == 512, "RSA size");
            require(uint8(s.modulus[0]) >= 128 && uint8(s.modulus[s.modulus.length - 1]) % 2 == 1, "RSA modulus");
            for (uint256 j; j < i; ++j) {
                require(
                    keccak256(abi.encode(s.domain, s.from, s.listId))
                        != keccak256(abi.encode(config[j].domain, config[j].from, config[j].listId)),
                    "duplicate identity"
                );
            }
            sources.push(s);
        }
        policyHash = keccak256(abi.encode(address(d), address(p), p.SERIES(), p.VERSION(), config, q, WINDOW, testOnly));
    }

    function sourceCount() external view returns (uint256) {
        return sources.length;
    }

    function source(uint256 i) external view returns (Source memory) {
        return sources[i];
    }

    function preview(uint16 sourceId, Email calldata mail)
        public
        view
        returns (uint32 month, uint64 cents, uint8 rule, bytes32 commitment)
    {
        if (sourceId >= sources.length) {
            revert IdentityMismatch();
        }
        Source storage s = sources[sourceId];
        DkimVerifier.Identity memory who = dkim.inspect(mail.headers, mail.body);
        if (
            !B.eq(s.domain, who.domain) || !B.eq(s.from, who.from) || !B.eq(s.listId, who.listId)
                || !B.eq(s.selector, who.selector)
        ) {
            revert IdentityMismatch();
        }
        dkim.verifySignature(mail.headers, mail.signature, s.modulus);
        (month, cents, rule) = parser.parse(s.publication, mail.body, who.contentType, who.encoding, who.signedAt);
        uint256 end = parser.monthEnd(month);
        if (block.timestamp < end || block.timestamp > end + WINDOW) {
            revert OutsideWindow();
        }
        commitment = keccak256(abi.encode(sha256(mail.headers), sha256(mail.body), mail.signature));
    }

    function submit(uint16 sourceId, Email calldata mail) external {
        (uint32 month, uint64 cents,, bytes32 commitment) = preview(sourceId, mail);
        Month storage m = months[month];
        if (m.finalized) {
            revert OutsideWindow();
        }
        uint64 old = votes[month][sourceId];
        if (old != 0) {
            if (old == cents) {
                revert DuplicatePublication();
            }
            m.conflict = true;
            emit Conflict(month, sourceId, old, cents);
            return;
        }
        votes[month][sourceId] = cents;
        ++m.sources;
        if (m.cents == 0) {
            m.cents = cents;
        } else if (m.cents != cents) {
            m.conflict = true;
            emit Conflict(month, sourceId, m.cents, cents);
        }
        emit Accepted(month, sourceId, cents, commitment);
    }

    function finalize(uint32 month) external {
        Month storage m = months[month];
        if (block.timestamp <= parser.monthEnd(month) + WINDOW || m.finalized || m.conflict || m.sources < quorum) {
            revert CannotFinalize();
        }
        m.finalized = true;
        if (month > latestMonth) {
            latestMonth = month;
        }
        emit Finalized(month, m.cents, m.sources);
    }

    function rate(uint32 month) public view returns (uint64) {
        if (!months[month].finalized) {
            revert NoFinalRate();
        }
        return months[month].cents;
    }

    function latest(uint256 maxAge) external view returns (uint32 month, uint64 cents) {
        month = latestMonth;
        cents = rate(month);
        if (block.timestamp > parser.monthEnd(month) + maxAge) {
            revert StaleRate();
        }
    }
}
