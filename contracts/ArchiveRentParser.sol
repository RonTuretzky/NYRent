// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {B} from "./Bytes.sol";
import {RentParser} from "./RentParser.sol";

/// @notice Version 1 grammars derived from public newsletter archive excerpts.
/// Only Manhattan, all-apartment, publisher-reported MEDIAN monthly USD rent.
/// Raw publisher MIME and DKIM have not yet been validated. No caller-supplied grammar.
contract ArchiveRentParser {
    RentParser public immutable decoder;
    uint256 private constant NONE = type(uint256).max;
    bytes32 public constant SERIES = keccak256("manhattan:median:all:publisher-reported:USD/month:v1");
    bytes32 public constant VERSION = keccak256("archive-grammar-v1");
    // 0 Pinpointe, 1 Bigger Apple, 2 Hemlane, 3 CRE Daily NY, 4 Finding Space.
    error UnsupportedPublication();
    error NoMatchingMedian();
    error AmbiguousObservation();
    error InvalidAmount();
    error InvalidPeriod();
    error StaleSection();

    constructor(RentParser d) {
        decoder = d;
    }

    /// @dev issuedAt MUST come from authenticated DKIM t= in a consuming feed.
    /// Direct calls are parsing demonstrations only and authenticate nothing.
    function parse(
        uint8 publication,
        bytes memory body,
        bytes memory contentType,
        bytes memory encoding,
        uint256 issuedAt
    ) external view returns (uint32 month, uint64 cents, uint8 rule) {
        if (publication > 4) {
            revert UnsupportedPublication();
        }
        uint32 issue = monthAt(issuedAt);
        bytes[] memory parts = decoder.textParts(body, contentType, encoding);
        for (uint256 i; i < parts.length; ++i) {
            (uint32 m, uint64 v, uint8 r) = record(publication, B.lower(parts[i]), issue);
            if (m == 0) {
                continue;
            }
            if (month != 0 && (month != m || cents != v)) {
                revert AmbiguousObservation();
            }
            month = m;
            cents = v;
            rule = r;
        }
        if (month == 0) {
            revert NoMatchingMedian();
        }
        uint256 end = monthEnd(month);
        if (issuedAt < end || issuedAt > end + 90 days) {
            revert InvalidPeriod();
        }
    }

    function record(uint8 pub, bytes memory text, uint32 issue)
        private
        pure
        returns (uint32 month, uint64 cents, uint8 rule)
    {
        if (pub == 0) {
            return pinpointe(text, issue);
        }
        bytes memory prefix;
        bytes memory suffix;
        if (pub == 1) {
            prefix = "the median rent in manhattan was $";
            suffix = " last month.";
            rule = 5;
        } else if (pub == 2) {
            prefix = "median rent price in manhattan hitting a record of $";
            suffix = " in ";
            rule = 6;
        } else if (pub == 3) {
            prefix = "median manhattan rent reached $";
            suffix = " in ";
            rule = 7;
        } else {
            // The month precedes the amount in Finding Space's observed sentence.
            bytes memory mid = ", renters in manhattan met record-highs with a median rent of $";
            uint256 p = B.find(text, mid, 0);
            if (p == NONE) {
                return (0, 0, 0);
            }
            if (B.find(text, mid, p + 1) != NONE) {
                revert AmbiguousObservation();
            }
            uint256 start = p > 20 ? p - 20 : 0;
            uint256 lastIn = NONE;
            for (uint256 j = start; j < p; ++j) {
                if (B.at(text, "in ", j) && boundary(text, j)) {
                    lastIn = j;
                }
            }
            if (lastIn == NONE) {
                revert InvalidPeriod();
            }
            (uint8 named, uint256 end) = monthName(text, lastIn + 3);
            if (end != p) {
                revert InvalidPeriod();
            }
            month = namedPeriod(named, issue);
            uint256 stop;
            (cents, stop) = amount(text, p + mid.length);
            amountEnd(text, stop);
            return (month, cents, 8);
        }
        uint256 at = unique(text, prefix);
        if (at == NONE) {
            return (0, 0, 0);
        }
        uint256 endAmount;
        (cents, endAmount) = amount(text, at + prefix.length);
        if (!B.at(text, suffix, endAmount)) {
            revert InvalidAmount();
        }
        if (pub == 1) {
            month = previous(issue);
        } else {
            (uint8 named, uint256 end) = monthName(text, endAmount + suffix.length);
            periodEnd(text, end);
            month = namedPeriod(named, issue);
        }
    }

    function pinpointe(bytes memory text, uint32 issue) private pure returns (uint32 month, uint64 cents, uint8 rule) {
        bytes memory headline = "manhattan hits all-time rental high: $";
        uint256 news = unique(text, headline);
        uint256 section = unique(text, "market pulse: ");
        uint32 sectionMonth;
        if (section != NONE) {
            (uint8 named, uint256 end) = monthName(text, section + 14);
            if (end + 5 > text.length || text[end] != 0x20) {
                revert InvalidPeriod();
            }
            uint256 year = B.uintDec(B.slice(text, end + 1, 4));
            if (year < 2020 || year > 2099) {
                revert InvalidPeriod();
            }
            periodEnd(text, end + 5);
            sectionMonth = uint32(year * 100 + named);
            // Monthly Market Pulse is expected to report the previous completed month.
            // This rejects the July 2025 issue's stale April heading without a date blacklist.
            if (sectionMonth != previous(issue)) {
                revert StaleSection();
            }
            uint256 rundown = B.find(text, "rental rundown", end + 5);
            if (rundown != NONE && rundown - section < 600) {
                uint256 finish = B.find(text, "sales snapshot", rundown + 14);
                if (finish == NONE) {
                    finish = text.length;
                }
                if (finish - rundown > 2500) {
                    revert AmbiguousObservation();
                }
                bytes memory rental = B.slice(text, rundown, finish - rundown);
                bytes[3] memory patterns = [
                    bytes("manhattan: median rent hit $"),
                    bytes("manhattan rents climbed to a median of $"),
                    bytes("manhattan median rent hit $")
                ];
                for (uint8 k; k < patterns.length; ++k) {
                    uint256 p = unique(rental, patterns[k]);
                    if (p == NONE) {
                        continue;
                    }
                    if (month != 0) {
                        revert AmbiguousObservation();
                    }
                    uint256 stop;
                    (cents, stop) = amount(rental, p + patterns[k].length);
                    amountEnd(rental, stop);
                    month = sectionMonth;
                    rule = k + 1;
                }
            }
        }
        if (news != NONE) {
            uint256 stop;
            uint64 value;
            (value, stop) = amount(text, news + headline.length);
            if (!B.at(text, " median in ", stop)) {
                revert InvalidAmount();
            }
            (uint8 named, uint256 end) = monthName(text, stop + 11);
            periodEnd(text, end);
            uint32 m = namedPeriod(named, issue);
            if (m != previous(issue)) {
                revert StaleSection();
            }
            if (month != 0 && (m != month || cents != value)) {
                revert AmbiguousObservation();
            }
            month = m;
            cents = value;
            rule = 4;
        }
    }

    function unique(bytes memory text, bytes memory needle) private pure returns (uint256 p) {
        p = B.find(text, needle, 0);
        if (p == NONE) {
            return p;
        }
        if (!boundary(text, p) || B.find(text, needle, p + 1) != NONE) {
            revert AmbiguousObservation();
        }
    }

    function boundary(bytes memory text, uint256 p) private pure returns (bool) {
        return p == 0 || text[p - 1] == 0x20 || text[p - 1] == 0x2e || text[p - 1] == 0x3a;
    }

    function digit(bytes1 c) private pure returns (bool) {
        return c >= 0x30 && c <= 0x39;
    }

    function amount(bytes memory text, uint256 p) private pure returns (uint64 cents, uint256 end) {
        uint256 start = p;
        uint256 dollars;
        uint256 digits;
        uint256 groups;
        while (p < text.length) {
            bytes1 c = text[p];
            if (digit(c)) {
                dollars = dollars * 10 + uint8(c) - 48;
                ++digits;
                ++p;
            } else if (c == 0x2c && p + 1 < text.length && digit(text[p + 1])) {
                if (digits == 0 || digits > 3 || (groups > 0 && digits != 3)) {
                    revert InvalidAmount();
                }
                ++groups;
                digits = 0;
                ++p;
            } else {
                break;
            }
            if (p - start > 10) {
                revert InvalidAmount();
            }
        }
        if (digits == 0 || (groups > 0 && digits != 3) || text[start] == 0x30) {
            revert InvalidAmount();
        }
        uint256 fraction;
        if (p + 1 < text.length && text[p] == 0x2e && digit(text[p + 1])) {
            if (p + 2 >= text.length || !digit(text[p + 2])) {
                revert InvalidAmount();
            }
            fraction = (uint256(uint8(text[p + 1])) - 48) * 10 + uint8(text[p + 2]) - 48;
            p += 3;
        }
        uint256 value = dollars * 100 + fraction;
        if (value < 10000 || value > 10000000) {
            revert InvalidAmount();
        }
        return (uint64(value), p);
    }

    function amountEnd(bytes memory text, uint256 p) private pure {
        if (p == text.length) {
            return;
        }
        if (B.at(text, "/month", p)) {
            periodEnd(text, p + 6);
            return;
        }
        bytes1 c = text[p];
        if (c != 0x20 && c != 0x2e && c != 0x2c) {
            revert InvalidAmount();
        }
        if ((c == 0x2e || c == 0x2c) && p + 1 < text.length && digit(text[p + 1])) {
            revert InvalidAmount();
        }
        // The observed prose continues with punctuation. Never accept a magnitude
        // suffix or a new unit ("million", "per year", "per square foot").
        if (
            c == 0x20 && p + 1 < text.length && text[p + 1] != 0x2d && !B.at(text, hex"e28094", p + 1)
                && !B.at(text, hex"e28093", p + 1)
        ) {
            revert InvalidAmount();
        }
    }

    function periodEnd(bytes memory text, uint256 p) private pure {
        if (p == text.length) {
            return;
        }
        bytes1 c = text[p];
        if (c != 0x20 && c != 0x2e && c != 0x2c && c != 0x3a && c != 0x21) {
            revert InvalidPeriod();
        }
        // Do not silently reinterpret an explicit year as an implicit recent month.
        if (c == 0x20 && p + 1 < text.length && digit(text[p + 1])) {
            revert InvalidPeriod();
        }
    }

    function monthName(bytes memory text, uint256 p) private pure returns (uint8 month, uint256 end) {
        bytes[12] memory names = [
            bytes("january"),
            bytes("february"),
            bytes("march"),
            bytes("april"),
            bytes("may"),
            bytes("june"),
            bytes("july"),
            bytes("august"),
            bytes("september"),
            bytes("october"),
            bytes("november"),
            bytes("december")
        ];
        for (uint8 i; i < 12; ++i) {
            if (B.at(text, names[i], p)) {
                return (i + 1, p + names[i].length);
            }
        }
        revert InvalidPeriod();
    }

    function namedPeriod(uint8 month, uint32 issue) private pure returns (uint32) {
        uint32 year = issue / 100;
        if (month >= issue % 100) {
            --year;
        }
        return year * 100 + month;
    }

    function previous(uint32 issue) public pure returns (uint32) {
        return issue % 100 == 1 ? (issue / 100 - 1) * 100 + 12 : issue - 1;
    }

    function leap(uint256 year) private pure returns (bool) {
        return year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    }

    function daysIn(uint256 year, uint256 month) private pure returns (uint256) {
        return month == 2 ? (leap(year) ? 29 : 28) : (month == 4 || month == 6 || month == 9 || month == 11 ? 30 : 31);
    }

    function monthAt(uint256 timestamp) public pure returns (uint32) {
        require(timestamp >= 1577836800 && timestamp < 4102444800, "timestamp bounds");
        uint256 daysLeft = timestamp / 1 days;
        uint256 year = 1970;
        while (daysLeft >= (leap(year) ? 366 : 365)) {
            daysLeft -= leap(year) ? 366 : 365;
            ++year;
        }
        uint256 month = 1;
        while (daysLeft >= daysIn(year, month)) {
            daysLeft -= daysIn(year, month);
            ++month;
        }
        return uint32(year * 100 + month);
    }

    function monthEnd(uint32 month) public pure returns (uint256) {
        uint256 year = month / 100;
        uint256 m = month % 100;
        if (year < 2020 || year > 2099 || m == 0 || m > 12) {
            revert InvalidPeriod();
        }
        uint256 daysTotal;
        for (uint256 y = 1970; y < year; ++y) {
            daysTotal += leap(y) ? 366 : 365;
        }
        for (uint256 i = 1; i <= m; ++i) {
            daysTotal += daysIn(year, i);
        }
        return daysTotal * 1 days;
    }
}
