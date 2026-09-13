// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {B} from "./Bytes.sol";

/// @notice Bounded, immutable literal templates with {YYYY-MM} followed by a USD amount.
/// Template changes require a new feed; an uploader cannot choose the parser or metric.
contract RentParser {
    struct Template {
        bytes beforeMonth;
        bytes beforePrice;
        bytes afterPrice;
    }
    error UnsupportedMIME();
    error NoRecord();
    error AmbiguousRecord();
    error InvalidRecord();

    /// @notice Shared bounded MIME decoding; this does not authenticate a message.
    function textParts(bytes memory body, bytes memory contentType, bytes memory encoding)
        external
        pure
        returns (bytes[] memory parts)
    {
        require(body.length <= 65536 && contentType.length <= 1024 && encoding.length <= 64, "MIME bounds");
        parts = new bytes[](8);
        uint256 count = mime(body, contentType, encoding, parts, 0, 0);
        assembly ("memory-safe") { mstore(parts, count) }
    }

    function parse(bytes memory body, bytes memory contentType, bytes memory encoding, Template memory t)
        external
        pure
        returns (uint32 month, uint64 cents)
    {
        bytes[] memory parts = new bytes[](8);
        uint256 count = mime(body, contentType, encoding, parts, 0, 0);
        for (uint256 i; i < count; ++i) {
            (uint32 m, uint64 v) = record(parts[i], t);
            if (m == 0) {
                continue;
            }
            if (month != 0 && (month != m || cents != v)) {
                revert AmbiguousRecord();
            }
            month = m;
            cents = v;
        }
        if (month == 0) {
            revert NoRecord();
        }
    }

    function record(bytes memory text, Template memory t) public pure returns (uint32 month, uint64 cents) {
        uint256 start = B.find(text, t.beforeMonth, 0);
        if (start == type(uint256).max) {
            return (0, 0);
        }
        if (B.find(text, t.beforeMonth, start + 1) != type(uint256).max) {
            revert AmbiguousRecord();
        }
        uint256 p = start + t.beforeMonth.length;
        if (p + 7 > text.length || text[p + 4] != 0x2d) {
            revert InvalidRecord();
        }
        uint256 y = B.uintDec(B.slice(text, p, 4));
        uint256 m = B.uintDec(B.slice(text, p + 5, 2));
        if (y < 2020 || y > 2099 || m == 0 || m > 12) {
            revert InvalidRecord();
        }
        month = uint32(y * 100 + m);
        p += 7;
        if (!B.at(text, t.beforePrice, p)) {
            revert InvalidRecord();
        }
        p += t.beforePrice.length;
        uint256 end = B.find(text, t.afterPrice, p);
        if (end == type(uint256).max || end - p > 12 || end == p) {
            revert InvalidRecord();
        }
        bytes memory amount = B.slice(text, p, end - p);
        uint256 dollars;
        uint256 digits;
        uint256 groups;
        uint256 dot = amount.length;
        for (uint256 i; i < amount.length; ++i) {
            bytes1 c = amount[i];
            if (c == 0x2e) {
                dot = i;
                break;
            }
            if (c == 0x2c) {
                if (digits == 0 || digits > 3 || (groups > 0 && digits != 3)) {
                    revert InvalidRecord();
                }
                ++groups;
                digits = 0;
                continue;
            }
            if (c < 0x30 || c > 0x39) {
                revert InvalidRecord();
            }
            dollars = dollars * 10 + uint8(c) - 48;
            ++digits;
        }
        if (digits == 0 || (groups > 0 && digits != 3) || (amount.length > 1 && amount[0] == 0x30)) {
            revert InvalidRecord();
        }
        uint256 fractional;
        if (dot < amount.length) {
            if (dot + 3 != amount.length) {
                revert InvalidRecord();
            }
            fractional = B.uintDec(B.slice(amount, dot + 1, 2));
        }
        uint256 value = dollars * 100 + fractional;
        if (value < 10000 || value > 10000000) {
            revert InvalidRecord();
        }
        cents = uint64(value);
    }

    function mime(
        bytes memory body,
        bytes memory typ,
        bytes memory enc,
        bytes[] memory parts,
        uint256 count,
        uint256 depth
    ) private pure returns (uint256) {
        if (depth > 2) {
            revert UnsupportedMIME();
        }
        bytes memory low = B.lower(bytes.concat(typ));
        bytes memory e = B.lower(B.trim(enc));
        uint256 semi = B.find(low, ";", 0);
        bytes memory media = semi == type(uint256).max ? B.trim(low) : B.trim(B.slice(low, 0, semi));
        if (B.eq(media, "multipart/alternative") || B.eq(media, "multipart/mixed")) {
            if (!B.eq(e, "7bit") && !B.eq(e, "8bit")) {
                revert UnsupportedMIME();
            }
            uint256 bi = B.find(low, "boundary=", 0);
            if (bi == type(uint256).max) {
                revert UnsupportedMIME();
            }
            bi += 9;
            bytes1 quote = typ[bi];
            bool quoted = quote == 0x22;
            if (quoted) {
                ++bi;
            }
            uint256 be = bi;
            while (be < typ.length && (quoted ? typ[be] != 0x22 : (typ[be] != 0x3b && typ[be] != 0x20))) {
                ++be;
            }
            if (be - bi == 0 || be - bi > 70 || (quoted && be == typ.length)) {
                revert UnsupportedMIME();
            }
            bytes memory boundary = bytes.concat("--", B.slice(typ, bi, be - bi));
            uint256 p = B.find(body, boundary, 0);
            uint256 visited;
            while (p != type(uint256).max) {
                if (++visited > 12) {
                    revert UnsupportedMIME();
                }
                if (p != 0 && !B.at(body, "\r\n", p - 2)) {
                    revert UnsupportedMIME();
                }
                p += boundary.length;
                if (B.at(body, "--", p)) {
                    break;
                }
                if (!B.at(body, "\r\n", p)) {
                    revert UnsupportedMIME();
                }
                p += 2;
                uint256 split = B.find(body, "\r\n\r\n", p);
                if (split == type(uint256).max) {
                    revert UnsupportedMIME();
                }
                uint256 next = B.find(body, bytes.concat("\r\n", boundary), split + 4);
                if (next == type(uint256).max) {
                    revert UnsupportedMIME();
                }
                bytes memory head = B.slice(body, p, split - p);
                bytes memory ct = field(head, "content-type");
                bytes memory ce = field(head, "content-transfer-encoding");
                bytes memory cd = B.lower(field(head, "content-disposition"));
                if (!B.at(cd, "attachment", 0)) {
                    if (ce.length == 0) {
                        ce = "7bit";
                    }
                    if (ct.length == 0) {
                        ct = "text/plain";
                    }
                    count = mime(B.slice(body, split + 4, next - split - 4), ct, ce, parts, count, depth + 1);
                }
                p = next + 2;
            }
            return count;
        }
        if (!B.eq(media, "text/plain") && !B.eq(media, "text/html")) {
            return count;
        }
        bytes memory decoded;
        if (B.eq(e, "quoted-printable")) {
            decoded = qp(body);
        } else if (B.eq(e, "base64")) {
            decoded = B.b64(body);
        } else if (B.eq(e, "7bit") || B.eq(e, "8bit")) {
            decoded = body;
        } else {
            revert UnsupportedMIME();
        }
        if (count == parts.length) {
            revert UnsupportedMIME();
        }
        parts[count++] = normalize(decoded, B.eq(media, "text/html"));
        return count;
    }

    function field(bytes memory data, bytes memory name) private pure returns (bytes memory value) {
        uint256 p;
        bool found;
        while (p < data.length) {
            uint256 end = B.find(data, "\r\n", p);
            if (end == type(uint256).max) {
                end = data.length;
            }
            bytes memory line = B.slice(data, p, end - p);
            uint256 colon = B.find(line, ":", 0);
            if (colon == type(uint256).max) {
                revert UnsupportedMIME();
            }
            if (B.eq(B.lower(B.trim(B.slice(line, 0, colon))), name)) {
                if (found) {
                    revert UnsupportedMIME();
                }
                found = true;
                value = B.trim(B.slice(line, colon + 1, line.length - colon - 1));
            }
            p = end + 2;
        }
    }

    function hexDigit(bytes1 c) private pure returns (uint8) {
        if (c >= 0x30 && c <= 0x39) {
            return uint8(c) - 48;
        }
        if (c >= 0x41 && c <= 0x46) {
            return uint8(c) - 55;
        }
        if (c >= 0x61 && c <= 0x66) {
            return uint8(c) - 87;
        }
        revert UnsupportedMIME();
    }

    function qp(bytes memory a) private pure returns (bytes memory out) {
        out = new bytes(a.length);
        uint256 n;
        for (uint256 i; i < a.length; ++i) {
            if (a[i] != 0x3d) {
                out[n++] = a[i];
                continue;
            }
            if (i + 2 >= a.length) {
                revert UnsupportedMIME();
            }
            if (a[i + 1] == 0x0d && a[i + 2] == 0x0a) {
                i += 2;
                continue;
            }
            out[n++] = bytes1(hexDigit(a[i + 1]) * 16 + hexDigit(a[i + 2]));
            i += 2;
        }
        assembly ("memory-safe") { mstore(out, n) }
    }

    function normalize(bytes memory a, bool html) private pure returns (bytes memory out) {
        out = new bytes(a.length);
        uint256 n;
        bool space;
        for (uint256 i; i < a.length; ++i) {
            bytes1 c = a[i];
            if (html && c == 0x3c) {
                if (B.at(a, "<!--", i)) {
                    uint256 close = B.find(a, "-->", i + 4);
                    if (close == type(uint256).max) {
                        revert UnsupportedMIME();
                    }
                    i = close + 2;
                    space = true;
                    continue;
                }
                uint256 end = B.find(a, ">", i + 1);
                if (end == type(uint256).max) {
                    revert UnsupportedMIME();
                }
                bytes memory tag = B.lower(B.trim(B.slice(a, i + 1, end - i - 1)));
                bytes memory closing;
                if (B.eq(tag, "script") || B.at(tag, "script ", 0)) {
                    closing = "</script>";
                } else if (B.eq(tag, "style") || B.at(tag, "style ", 0)) {
                    closing = "</style>";
                } else if (B.eq(tag, "head") || B.at(tag, "head ", 0)) {
                    closing = "</head>";
                }
                if (closing.length > 0) {
                    bytes memory lowered = B.lower(bytes.concat(a));
                    uint256 close = B.find(lowered, closing, end + 1);
                    if (close == type(uint256).max) {
                        revert UnsupportedMIME();
                    }
                    end = close + closing.length - 1;
                }
                i = end;
                space = true;
                continue;
            }
            if (html && c == 0x26) {
                uint256 end = B.find(a, ";", i + 1);
                if (end == type(uint256).max || end - i > 12) {
                    revert UnsupportedMIME();
                }
                bytes memory ent = B.slice(a, i + 1, end - i - 1);
                i = end;
                if (B.eq(ent, "nbsp") || B.eq(ent, "#160")) {
                    c = 0x20;
                } else if (B.eq(ent, "amp")) {
                    c = 0x26;
                } else if (B.eq(ent, "quot")) {
                    c = 0x22;
                } else if (B.eq(ent, "apos") || B.eq(ent, "#39")) {
                    c = 0x27;
                } else if (B.eq(ent, "lt")) {
                    c = 0x3c;
                } else if (B.eq(ent, "gt")) {
                    c = 0x3e;
                } else if (ent.length > 1 && ent[0] == 0x23) {
                    uint256 v = B.uintDec(B.slice(ent, 1, ent.length - 1));
                    if (v < 32 || v > 126) {
                        revert UnsupportedMIME();
                    }
                    c = bytes1(uint8(v));
                } else {
                    revert UnsupportedMIME();
                }
            }
            if (c == 0x20 || c == 0x09 || c == 0x0a || c == 0x0d) {
                space = true;
                continue;
            }
            if (c == 0x00) {
                revert UnsupportedMIME();
            }
            if (space && n > 0) {
                out[n++] = 0x20;
            }
            space = false;
            out[n++] = c;
        }
        assembly ("memory-safe") { mstore(out, n) }
    }
}
