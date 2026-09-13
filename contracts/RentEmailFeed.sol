// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {DNSSEC} from "@ensdomains/ens-contracts/contracts/dnssec-oracle/DNSSEC.sol";
import {KeyProof} from "./KeyProof.sol";
import {DkimVerifier} from "./DkimVerifier.sol";
import {RentParser} from "./RentParser.sol";
import {B} from "./Bytes.sol";

/// @notice Permissionless submissions, immutable publisher identities/templates, exact agreement.
/// No owner, reporter key, price setter, upgrade, discretionary override, or HTTPS read.
contract RentEmailFeed {
    struct Source {
        string name;
        bytes domain;
        bytes from;
        bytes listId;
        RentParser.Template template;
    }

    struct Envelope {
        bytes headers;
        bytes body;
        bytes signature;
        DNSSEC.RRSetWithSignature[][] keyProof;
    }

    struct Month {
        uint64 candidateCents;
        uint16 sources;
        bool conflict;
        bool finalized;
        uint64 finalCents;
    }
    KeyProof public immutable keys;
    DkimVerifier public immutable dkim;
    RentParser public immutable parser;
    bytes32 public immutable seriesId;
    bytes32 public immutable policyHash;
    uint16 public immutable quorum;
    uint32 public immutable submissionWindow;
    bool public immutable testDeployment;
    Source[] private _sources;
    mapping(uint32 => Month) public months;
    mapping(uint32 => mapping(uint16 => uint64)) public votes;
    mapping(uint32 => mapping(uint16 => bytes32)) public evidence;
    uint32 public latestMonth;
    error UnknownSource();
    error IdentityMismatch();
    error OutsideWindow();
    error AlreadySubmitted();
    error InsufficientAgreement();
    error MonthClosed();
    error NoFinalRate();
    error StaleRate();
    event EmailAccepted(uint32 indexed month, uint16 indexed source, uint64 cents, bytes32 evidenceHash);
    event Disagreement(uint32 indexed month, uint16 indexed source, uint64 previousCents, uint64 newCents);
    event MonthFinalized(uint32 indexed month, uint64 cents, uint16 sourceCount);

    constructor(
        KeyProof k,
        DkimVerifier d,
        RentParser p,
        bytes32 series,
        Source[] memory sourceConfig,
        uint16 q,
        uint32 window,
        bool isTest
    ) {
        require(
            sourceConfig.length >= 2 && sourceConfig.length <= 8 && q >= 2 && q <= sourceConfig.length, "source policy"
        );
        require(window >= 7 days && window <= 90 days && series != bytes32(0), "window/series");
        keys = k;
        dkim = d;
        parser = p;
        seriesId = series;
        quorum = q;
        submissionWindow = window;
        testDeployment = isTest;
        for (uint256 i; i < sourceConfig.length; ++i) {
            Source memory s = sourceConfig[i];
            require(s.domain.length > 0 && s.from.length > 0, "identity");
            B.dns(s.domain);
            require(
                s.template.beforeMonth.length >= 20 && s.template.beforeMonth.length <= 512
                    && s.template.beforePrice.length >= 2 && s.template.beforePrice.length <= 512
                    && s.template.afterPrice.length >= 3 && s.template.afterPrice.length <= 256,
                "template"
            );
            for (uint256 j; j < i; ++j) {
                require(
                    keccak256(abi.encode(s.domain, s.from, s.listId))
                        != keccak256(abi.encode(sourceConfig[j].domain, sourceConfig[j].from, sourceConfig[j].listId)),
                    "duplicate identity"
                );
            }
            _sources.push(s);
        }
        policyHash =
            keccak256(
            abi.encode(series, sourceConfig, q, window, k.anchorHash(), isTest, address(k), address(d), address(p))
        );
    }

    function sourceCount() external view returns (uint256) {
        return _sources.length;
    }

    function source(uint256 i) external view returns (Source memory) {
        return _sources[i];
    }

    function preview(uint16 sourceId, Envelope calldata mail)
        public
        view
        returns (uint32 month, uint64 cents, bytes32 commitment)
    {
        if (sourceId >= _sources.length) {
            revert UnknownSource();
        }
        Source storage s = _sources[sourceId];
        DkimVerifier.Identity memory info = dkim.inspect(mail.headers, mail.body);
        if (!B.eq(info.domain, s.domain) || !B.eq(info.from, s.from) || !B.eq(info.listId, s.listId)) {
            revert IdentityMismatch();
        }
        bytes memory n = keys.modulus(info.domain, info.selector, mail.keyProof);
        dkim.verifySignature(mail.headers, mail.signature, n);
        (month, cents) = parser.parse(mail.body, info.contentType, info.encoding, s.template);
        uint256 end = monthEnd(month);
        uint256 close = end + submissionWindow;
        if (block.timestamp < end || block.timestamp > close || info.signedAt < end || info.signedAt > close) {
            revert OutsideWindow();
        }
        commitment = keccak256(abi.encode(sha256(mail.headers), sha256(mail.body), mail.signature));
    }

    function submit(uint16 sourceId, Envelope calldata mail) external {
        (uint32 month, uint64 cents, bytes32 commitment) = preview(sourceId, mail);
        Month storage m = months[month];
        if (m.finalized) {
            revert MonthClosed();
        }
        uint64 old = votes[month][sourceId];
        if (old != 0) {
            if (old == cents) {
                revert AlreadySubmitted();
            }
            m.conflict = true;
            emit Disagreement(month, sourceId, old, cents);
            return;
        }
        votes[month][sourceId] = cents;
        evidence[month][sourceId] = commitment;
        ++m.sources;
        if (m.candidateCents == 0) {
            m.candidateCents = cents;
        } else if (m.candidateCents != cents) {
            m.conflict = true;
            emit Disagreement(month, sourceId, m.candidateCents, cents);
        }
        emit EmailAccepted(month, sourceId, cents, commitment);
    }

    function finalize(uint32 month) external {
        if (block.timestamp <= monthEnd(month) + submissionWindow) {
            revert OutsideWindow();
        }
        Month storage m = months[month];
        if (m.finalized) {
            revert MonthClosed();
        }
        if (m.sources < quorum || m.conflict) {
            revert InsufficientAgreement();
        }
        m.finalized = true;
        m.finalCents = m.candidateCents;
        if (month > latestMonth) {
            latestMonth = month;
        }
        emit MonthFinalized(month, m.finalCents, m.sources);
    }

    function rate(uint32 month) public view returns (uint64) {
        if (!months[month].finalized) {
            revert NoFinalRate();
        }
        return months[month].finalCents;
    }

    function latest(uint256 maxAge) external view returns (uint32 month, uint64 cents) {
        month = latestMonth;
        cents = rate(month);
        if (block.timestamp > monthEnd(month) + maxAge) {
            revert StaleRate();
        }
    }

    function monthEnd(uint32 month) public pure returns (uint256) {
        uint256 y = month / 100;
        uint256 m = month % 100;
        require(y >= 2020 && y <= 2099 && m >= 1 && m <= 12, "invalid month");
        uint256 daysSinceEpoch;
        for (uint256 a = 1970; a < y; ++a) {
            daysSinceEpoch += leap(a) ? 366 : 365;
        }
        for (uint256 a = 1; a <= m; ++a) {
            if (a == 2) {
                daysSinceEpoch += leap(y) ? 29 : 28;
            } else if (a == 4 || a == 6 || a == 9 || a == 11) {
                daysSinceEpoch += 30;
            } else {
                daysSinceEpoch += 31;
            }
        }
        return daysSinceEpoch * 1 days;
    }

    function leap(uint256 y) private pure returns (bool) {
        return y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    }
}
