// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title GoogleAlertParser
/// @notice Strict extraction of Apartments.com headline rents from a Google Alerts
///         email. Reads ONLY the inbox-markup JSON at the head of the text/html part
///         and accepts a value only when one LINK widget carries both the exact
///         publisher URL and the exact sentence
///         `As of <Month> <YYYY>, the average rent in <Name> was $<n>/mo.`
/// @dev    Operates on the RELAXED-canonicalized body. The alert query is reflected
///         in the subject, the text/plain part and the JSON title fields, so nothing
///         outside a widget is read. Inside the JSON a reflected `"` is always `\"`,
///         which is why a structural token such as `"widgets":` cannot be forged by a
///         query. The text/plain part is skipped with the MIME boundary from the
///         signed Content-Type header. Widgets that do not match are skipped, never
///         joined to another widget. See docs/APARTMENTS.md for the threat model.
library GoogleAlertParser {
    struct Result {
        bytes slug; // rent-market-trends path segment, e.g. east-harlem-new-york-ny
        uint32 yyyymm; // explicit as-of month in the sentence, e.g. 202610
        uint32 cents; // headline rent in USD cents per month
    }

    error MissingBoundary();
    error BadMimeLayout();
    error BadQuotedPrintable();
    error MissingMarkup();
    error MalformedJson();

    uint256 internal constant MAX_JSON_BYTES = 32 * 1024;
    uint256 internal constant MAX_SLUG_BYTES = 96;
    uint256 internal constant MAX_WIDGETS = 32;

    bytes internal constant CONTENT_TYPE = 'content-type:multipart/alternative; boundary="';
    bytes internal constant HTML_PART_HEADERS =
        'Content-Type: text/html; charset="UTF-8"\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n';
    bytes internal constant SCRIPT_OPEN = '<script data-scope="inboxmarkup" type="application/json">';
    bytes internal constant SCRIPT_CLOSE = "</script>";
    bytes internal constant WIDGETS_KEY = '"widgets":';
    bytes internal constant URL_PREFIX =
        "https://www.google.com/url?rct=j\\u0026sa=t\\u0026url=https://www.apartments.com/rent-market-trends/";
    bytes internal constant URL_SUFFIX = "/\\u0026ct=ga\\u0026";
    bytes internal constant TEXT_AS_OF = "As of ";
    bytes internal constant TEXT_RENT_IN = ", the average rent in ";
    bytes internal constant TEXT_WAS = " was $";
    bytes internal constant TEXT_PER_MONTH = "/mo.";

    // ─────────────────────────────────────────────────────────────────────────
    // Entry point
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Every qualifying result in the email, in widget order.
    function parse(bytes calldata signedHeaders, bytes calldata canonBody) internal pure returns (Result[] memory) {
        bytes memory boundary = boundaryOf(signedHeaders);
        bytes memory json = inboxMarkup(canonBody, boundary);
        return widgets(json);
    }

    /// @notice Boundary from the signed top-level Content-Type line.
    function boundaryOf(bytes calldata signedHeaders) internal pure returns (bytes memory) {
        bytes memory prefix = CONTENT_TYPE;
        uint256 len = signedHeaders.length;
        uint256 start;
        while (start < len) {
            uint256 stop = start;
            while (stop + 1 < len && !(signedHeaders[stop] == 0x0d && signedHeaders[stop + 1] == 0x0a)) ++stop;
            if (stop + 1 >= len) stop = len;
            if (_calldataHasAt(signedHeaders, start, prefix)) {
                uint256 valueStart = start + prefix.length;
                if (stop <= valueStart + 1 || signedHeaders[stop - 1] != '"') revert MissingBoundary();
                bytes memory boundary = signedHeaders[valueStart:stop - 1];
                for (uint256 i = 0; i < boundary.length; ++i) {
                    if (boundary[i] == '"') revert MissingBoundary();
                }
                return boundary;
            }
            start = stop + 2;
        }
        revert MissingBoundary();
    }

    /// @notice QP-decodes the html part up to the closing script tag and returns the
    ///         JSON between the inbox-markup script tags.
    function inboxMarkup(bytes calldata body, bytes memory boundary) internal pure returns (bytes memory) {
        uint256 at = _htmlStart(body, boundary);
        bytes memory out = new bytes(MAX_JSON_BYTES);
        uint256 o;
        uint256 jsonStart;
        while (at < body.length) {
            bytes1 c;
            (c, at) = _nextDecoded(body, at);
            if (c == 0) continue;
            if (o == MAX_JSON_BYTES) revert MissingMarkup();
            out[o++] = c;
            if (c != ">") continue;
            if (jsonStart == 0) {
                if (o >= SCRIPT_OPEN.length && _hasAt(out, o - SCRIPT_OPEN.length, SCRIPT_OPEN)) jsonStart = o;
            } else if (o >= jsonStart + SCRIPT_CLOSE.length && _hasAt(out, o - SCRIPT_CLOSE.length, SCRIPT_CLOSE)) {
                return _slice(out, jsonStart, o - SCRIPT_CLOSE.length);
            }
        }
        revert MissingMarkup();
    }

    /// @dev Offset of the first byte after the html part's headers.
    function _htmlStart(bytes calldata body, bytes memory boundary) private pure returns (uint256 at) {
        bytes memory first = abi.encodePacked("--", boundary, "\r\n");
        if (!_calldataHasAt(body, 0, first)) revert BadMimeLayout();

        bytes memory next = abi.encodePacked("\r\n--", boundary, "\r\n");
        at = first.length;
        uint256 last = body.length < next.length ? 0 : body.length - next.length;
        while (at <= last && (body[at] != 0x0d || !_calldataHasAt(body, at, next))) ++at;
        if (at > last || body.length < next.length) revert BadMimeLayout();
        at += next.length;

        if (!_calldataHasAt(body, at, HTML_PART_HEADERS)) revert BadMimeLayout();
        at += HTML_PART_HEADERS.length;
    }

    /// @dev One quoted-printable step. A soft line break yields byte 0; so does a
    ///      literal `=00`, which never occurs in the markup and is simply dropped.
    function _nextDecoded(bytes calldata body, uint256 at) private pure returns (bytes1 c, uint256 next) {
        c = body[at];
        if (c != "=") return (c, at + 1);
        if (at + 2 >= body.length) revert BadQuotedPrintable();
        if (body[at + 1] == 0x0d && body[at + 2] == 0x0a) return (0, at + 3);
        return (bytes1(_hex(body[at + 1]) * 16 + _hex(body[at + 2])), at + 3);
    }

    /// @notice Walks the first card's widget array, reading at most {MAX_WIDGETS}.
    function widgets(bytes memory json) internal pure returns (Result[] memory) {
        uint256 p = _findWidgets(json);
        p = _ws(json, p);
        if (_at(json, p) != "[") revert MalformedJson();
        p = _ws(json, p + 1);

        Result[] memory found = new Result[](MAX_WIDGETS);
        uint256 count;
        for (uint256 n = 0; n < MAX_WIDGETS; ++n) {
            (bytes memory url, bytes memory description, bool isLink, uint256 afterObject) = _object(json, p);
            (bool ok, Result memory result) = isLink ? _result(url, description) : (false, found[0]);
            if (ok) found[count++] = result;
            p = _ws(json, afterObject);
            bytes1 c = _at(json, p);
            if (c == "]") break;
            if (c != ",") revert MalformedJson();
            p = _ws(json, p + 1);
        }
        assembly ("memory-safe") {
            mstore(found, count)
        }
        return found;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // JSON
    // ─────────────────────────────────────────────────────────────────────────

    function _findWidgets(bytes memory json) private pure returns (uint256) {
        bytes memory key = WIDGETS_KEY;
        for (uint256 i = 0; i + key.length <= json.length; ++i) {
            if (json[i] != '"' || (i != 0 && json[i - 1] == "\\")) continue;
            if (_hasAt(json, i, key)) return i + key.length;
        }
        revert MalformedJson();
    }

    /// @dev One flat object of string values. Duplicate keys of interest are rejected
    ///      so two readers can never disagree about which value counts.
    function _object(bytes memory json, uint256 p)
        private
        pure
        returns (bytes memory url, bytes memory description, bool isLink, uint256 next)
    {
        if (_at(json, p) != "{") revert MalformedJson();
        p = _ws(json, p + 1);
        bool hasType;
        while (true) {
            (uint256 ks, uint256 ke) = _string(json, p);
            p = _ws(json, ke + 1);
            if (_at(json, p) != ":") revert MalformedJson();
            p = _ws(json, p + 1);
            (uint256 vs, uint256 ve) = _string(json, p);
            bytes memory key = _slice(json, ks, ke);
            bytes32 keyHash = keccak256(key);
            if (keyHash == keccak256("type")) {
                if (hasType) revert MalformedJson();
                hasType = true;
                isLink = keccak256(_slice(json, vs, ve)) == keccak256("LINK");
            } else if (keyHash == keccak256("url")) {
                if (url.length != 0) revert MalformedJson();
                url = _slice(json, vs, ve);
            } else if (keyHash == keccak256("description")) {
                if (description.length != 0) revert MalformedJson();
                description = _slice(json, vs, ve);
            }
            p = _ws(json, ve + 1);
            bytes1 c = _at(json, p);
            if (c == "}") return (url, description, isLink, p + 1);
            if (c != ",") revert MalformedJson();
            p = _ws(json, p + 1);
        }
    }

    /// @return start First byte of the raw string content.
    /// @return end Offset of the closing quote.
    function _string(bytes memory json, uint256 p) private pure returns (uint256 start, uint256 end) {
        if (_at(json, p) != '"') revert MalformedJson();
        start = p + 1;
        end = start;
        while (true) {
            bytes1 c = _at(json, end);
            if (c == '"') return (start, end);
            end += c == "\\" ? 2 : 1;
        }
    }

    function _ws(bytes memory json, uint256 p) private pure returns (uint256) {
        while (p < json.length) {
            bytes1 c = json[p];
            if (c != 0x20 && c != 0x0d && c != 0x0a && c != 0x09) break;
            ++p;
        }
        return p;
    }

    function _at(bytes memory json, uint256 p) private pure returns (bytes1) {
        if (p >= json.length) revert MalformedJson();
        return json[p];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // URL + sentence grammar
    // ─────────────────────────────────────────────────────────────────────────

    function _result(bytes memory url, bytes memory text) private pure returns (bool, Result memory r) {
        bytes memory slug = _slug(url);
        if (slug.length == 0) return (false, r);

        bytes memory asOf = TEXT_AS_OF;
        if (!_hasAt(text, 0, asOf)) return (false, r);
        uint256 p = asOf.length;

        uint32 month;
        (month, p) = _month(text, p);
        if (month == 0 || p + 5 > text.length || text[p] != " ") return (false, r);
        uint32 year;
        for (uint256 i = 1; i <= 4; ++i) {
            bytes1 c = text[p + i];
            if (c < "0" || c > "9") return (false, r);
            year = year * 10 + (uint8(c) - 0x30);
        }
        p += 5;

        bytes memory rentIn = TEXT_RENT_IN;
        if (!_hasAt(text, p, rentIn)) return (false, r);
        p += rentIn.length;

        uint256 nameStart = p;
        bytes memory was = TEXT_WAS;
        while (p < text.length && !_hasAt(text, p, was)) ++p;
        if (p == text.length || !_nameMatchesSlug(text, nameStart, p, slug)) return (false, r);
        p += was.length;

        uint256 dollars;
        bool valid;
        (dollars, p, valid) = _dollars(text, p);
        if (!valid || !_hasAt(text, p, TEXT_PER_MONTH)) return (false, r);

        uint256 cents = dollars * 100;
        if (cents == 0 || cents > type(uint32).max) return (false, r);
        return (true, Result({slug: slug, yyyymm: year * 100 + month, cents: uint32(cents)}));
    }

    function _slug(bytes memory url) private pure returns (bytes memory) {
        bytes memory prefix = URL_PREFIX;
        bytes memory suffix = URL_SUFFIX;
        if (!_hasAt(url, 0, prefix)) return "";
        uint256 p = prefix.length;
        while (p < url.length && isSlugByte(url[p])) ++p;
        uint256 slugLen = p - prefix.length;
        if (slugLen == 0 || slugLen > MAX_SLUG_BYTES || !_hasAt(url, p, suffix)) return "";
        return _slice(url, prefix.length, p);
    }

    function isSlugByte(bytes1 c) internal pure returns (bool) {
        return (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c == "-";
    }

    /// @dev "East Harlem" must be the leading label of east-harlem-new-york-ny, so a
    ///      sentence quoting a neighbouring area on another area's page never counts.
    function _nameMatchesSlug(bytes memory text, uint256 start, uint256 stop, bytes memory slug)
        private
        pure
        returns (bool)
    {
        uint256 n = stop - start;
        if (n == 0 || n >= slug.length || slug[n] != "-") return false;
        for (uint256 i = 0; i < n; ++i) {
            bytes1 c = text[start + i];
            if (c == " ") c = "-";
            else if (c >= "A" && c <= "Z") c = bytes1(uint8(c) + 32);
            else if (!(c >= "a" && c <= "z") && c != "-") return false;
            if (c != slug[i]) return false;
        }
        return true;
    }

    /// @dev `1,234`, `12,345` or `999`. Anything else, such as a 2,34 group, fails.
    function _dollars(bytes memory text, uint256 p) private pure returns (uint256 value, uint256 next, bool valid) {
        uint256 lead;
        while (p < text.length && text[p] >= "0" && text[p] <= "9" && lead < 4) {
            value = value * 10 + (uint8(text[p]) - 0x30);
            ++p;
            ++lead;
        }
        if (lead == 0 || lead > 3 || text[p - lead] == "0") return (0, p, false);
        while (p < text.length && text[p] == ",") {
            if (p + 3 >= text.length) return (0, p, false);
            for (uint256 i = 1; i <= 3; ++i) {
                bytes1 c = text[p + i];
                if (c < "0" || c > "9") return (0, p, false);
                value = value * 10 + (uint8(c) - 0x30);
            }
            p += 4;
            if (value > 1e7) return (0, p, false);
        }
        return (value, p, true);
    }

    function _month(bytes memory text, uint256 p) private pure returns (uint32, uint256) {
        bytes9[12] memory names = [
            bytes9("January"),
            "February",
            "March",
            "April",
            "May",
            "June",
            "July",
            "August",
            "September",
            "October",
            "November",
            "December"
        ];
        uint256 stop = p;
        while (stop < text.length && text[stop] != " ") ++stop;
        uint256 n = stop - p;
        if (n == 0 || n > 9) return (0, p);
        bytes9 word = bytes9(_slice(text, p, stop));
        for (uint256 i = 0; i < 12; ++i) {
            if (names[i] == word) return (uint32(i + 1), stop);
        }
        return (0, p);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Bytes
    // ─────────────────────────────────────────────────────────────────────────

    function _hex(bytes1 b) private pure returns (uint8) {
        uint8 c = uint8(b);
        if (c >= 0x30 && c <= 0x39) return c - 0x30;
        if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
        revert BadQuotedPrintable();
    }

    function _hasAt(bytes memory data, uint256 offset, bytes memory needle) private pure returns (bool) {
        if (offset + needle.length > data.length) return false;
        for (uint256 i = 0; i < needle.length; ++i) {
            if (data[offset + i] != needle[i]) return false;
        }
        return true;
    }

    function _calldataHasAt(bytes calldata data, uint256 offset, bytes memory needle) private pure returns (bool) {
        if (offset + needle.length > data.length) return false;
        for (uint256 i = 0; i < needle.length; ++i) {
            if (data[offset + i] != needle[i]) return false;
        }
        return true;
    }

    function _slice(bytes memory data, uint256 start, uint256 stop) private pure returns (bytes memory out) {
        out = new bytes(stop - start);
        assembly ("memory-safe") {
            mcopy(add(out, 0x20), add(add(data, 0x20), start), mload(out))
        }
    }
}
