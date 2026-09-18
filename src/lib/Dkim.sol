// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title Dkim
/// @notice Pure helpers for on-chain DKIM (RFC 6376) verification of the CRE Daily
///         "Market Snapshot" email: strict RSA PKCS#1 v1.5 signature checking,
///         canonical dkim-signature tag parsing, base64 body-hash encoding, and the
///         quoted-printable snapshot value extractor.
/// @dev    Everything operates on the RELAXED-canonicalized bytes produced off-chain
///         (see docs/PROTOCOL.md); nothing here re-canonicalizes.
library Dkim {
    // ─────────────────────────────────────────────────────────────────────────
    // Errors
    // ─────────────────────────────────────────────────────────────────────────

    error BadLength(string what);
    error DuplicateTag(string tag);
    error MalformedTag();
    error BadTimestampTag();
    error ValueOverflow();

    // ─────────────────────────────────────────────────────────────────────────
    // RSA PKCS#1 v1.5 verification (2048-bit, SHA-256, e = 65537)
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev SHA-256 DigestInfo prefix (19 bytes): SEQUENCE { AlgorithmIdentifier
    ///      { sha256, NULL }, OCTET STRING (32) }.
    bytes internal constant SHA256_DIGEST_INFO = hex"3031300d060960864801650304020105000420";

    /// @dev EM = 0x00 || 0x01 || PS || 0x00 || DigestInfo || digest, |EM| = 256.
    ///      PS is 256 - 3 - 19 - 32 = 202 bytes of 0xFF.
    ///      (The build spec's "FF×205" is an arithmetic slip: 2 + 205 + 1 + 19 + 32 = 259
    ///      would not fit a 2048-bit modulus; 202 is the RFC 8017 value and is what the
    ///      verified fixture signature decodes to.)
    uint256 internal constant PS_LEN = 202;

    /// @notice Strict PKCS#1 v1.5 signature check for a 2048-bit modulus, e = 65537.
    /// @dev Runs sig^65537 mod n through the modexp precompile (0x05) and compares the
    ///      full 256-byte result against the expected encoding — any deviation
    ///      (wrong padding length, missing NULL, non-FF padding bytes…) fails.
    /// @param sig256 256-byte big-endian signature.
    /// @param digest sha256 of the signed data (the canonical signed-header block).
    /// @param modulus256 256-byte big-endian RSA modulus.
    function rsaVerify(bytes calldata sig256, bytes32 digest, bytes memory modulus256) internal view returns (bool) {
        if (sig256.length != 256) revert BadLength("sig");
        if (modulus256.length != 256) revert BadLength("modulus");

        // RFC 8017 RSAVP1 step 1: the signature representative must be < n. Without
        // this, any s' = s + k*n that still fits 256 bytes verifies too (modexp
        // reduces mod n) — harmless for replay (keyed on the body hash) but it makes
        // valid calldata malleable. Big-endian word compare, most significant first.
        {
            bool sigLtMod;
            for (uint256 k = 0; k < 256; k += 32) {
                uint256 sw = uint256(bytes32(sig256[k:k + 32]));
                uint256 mw;
                assembly ("memory-safe") {
                    mw := mload(add(modulus256, add(0x20, k)))
                }
                if (sw < mw) {
                    sigLtMod = true;
                    break;
                }
                if (sw > mw) return false;
            }
            if (!sigLtMod) return false; // s == n
        }

        // modexp precompile input: |base| |exp| |mod| base exp mod.
        bytes memory input = abi.encodePacked(uint256(256), uint256(3), uint256(256), sig256, hex"010001", modulus256);
        (bool ok, bytes memory em) = address(0x05).staticcall(input);
        if (!ok || em.length != 256) return false;

        // Expected encoding, built once and compared byte-for-byte over all 256 bytes.
        bytes memory expected = new bytes(256);
        expected[0] = 0x00;
        expected[1] = 0x01;
        for (uint256 i = 2; i < 2 + PS_LEN; ++i) {
            expected[i] = 0xff;
        }
        expected[2 + PS_LEN] = 0x00;
        uint256 off = 3 + PS_LEN;
        for (uint256 i = 0; i < 19; ++i) {
            expected[off + i] = SHA256_DIGEST_INFO[i];
        }
        off += 19;
        for (uint256 i = 0; i < 32; ++i) {
            expected[off + i] = digest[i];
        }
        return keccak256(em) == keccak256(expected);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // dkim-signature tag parsing
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Parsed tags of a canonical `dkim-signature:` line.
    struct DkimTags {
        string d; // signing domain
        string s; // selector
        string a; // algorithm
        string c; // canonicalization
        string v; // version
        string bhB64; // body hash, base64 (padded, 44 chars for SHA-256)
        uint64 t; // signature timestamp; 0 when the t= tag is absent
        bool hasL; // l= body-length tag present (always rejected by policy)
        bool bEmpty; // b= tag present with an EMPTY value (required by policy)
    }

    /// @notice Parses the relaxed-canonical `dkim-signature:` line (lowercase name,
    ///         single-spaced) into its tags.
    /// @dev Tags split on ';', names/values trimmed of SP/HTAB; unknown tags are
    ///      ignored; a duplicate of any policy-relevant tag reverts. Values keep their
    ///      internal bytes verbatim (h= values legitimately contain spaces from header
    ///      folding — the caller never inspects h=).
    /// @param dkimLine Full line including the `dkim-signature:` prefix, no CRLF.
    function parseDkimTags(bytes calldata dkimLine) internal pure returns (DkimTags memory tags) {
        bytes memory prefix = "dkim-signature:";
        if (dkimLine.length < prefix.length) revert MalformedTag();
        for (uint256 i = 0; i < prefix.length; ++i) {
            if (dkimLine[i] != prefix[i]) revert MalformedTag();
        }

        // seen bitmap: v a c d s t bh l b  →  bits 0..8
        uint256 seen;
        uint256 pos = prefix.length;
        uint256 len = dkimLine.length;
        while (pos <= len) {
            // find next ';' (or end)
            uint256 semi = pos;
            while (semi < len && dkimLine[semi] != ";") {
                ++semi;
            }
            (uint256 ns, uint256 ne, uint256 vs, uint256 ve) = _splitTag(dkimLine, pos, semi);
            if (ns != ne) {
                // non-empty tag name
                seen = _recordTag(tags, dkimLine, ns, ne, vs, ve, seen);
            } else if (vs != ve) {
                revert MalformedTag(); // value without a name, e.g. ";garbage;"
            }
            pos = semi + 1;
        }
    }

    /// @dev Splits dkimLine[start:stop) into trimmed name/value ranges around '='.
    ///      A tag without '=' is malformed unless entirely whitespace/empty.
    function _splitTag(bytes calldata dkimLine, uint256 start, uint256 stop)
        private
        pure
        returns (uint256 ns, uint256 ne, uint256 vs, uint256 ve)
    {
        // trim outer whitespace
        while (start < stop && _isWsp(dkimLine[start])) ++start;
        while (stop > start && _isWsp(dkimLine[stop - 1])) --stop;
        if (start == stop) return (start, start, start, start); // empty segment

        uint256 eq = start;
        while (eq < stop && dkimLine[eq] != "=") ++eq;
        if (eq == stop) revert MalformedTag(); // no '=' in a non-empty segment

        ns = start;
        ne = eq;
        while (ne > ns && _isWsp(dkimLine[ne - 1])) --ne;
        vs = eq + 1;
        ve = stop;
        while (vs < ve && _isWsp(dkimLine[vs])) ++vs;
    }

    /// @dev Assigns a parsed tag into `tags`, reverting on duplicates of known tags.
    function _recordTag(
        DkimTags memory tags,
        bytes calldata dkimLine,
        uint256 ns,
        uint256 ne,
        uint256 vs,
        uint256 ve,
        uint256 seen
    ) private pure returns (uint256) {
        bytes32 nameHash = keccak256(dkimLine[ns:ne]);
        if (nameHash == keccak256("v")) {
            seen = _mark(seen, 0, "v");
            tags.v = string(dkimLine[vs:ve]);
        } else if (nameHash == keccak256("a")) {
            seen = _mark(seen, 1, "a");
            tags.a = string(dkimLine[vs:ve]);
        } else if (nameHash == keccak256("c")) {
            seen = _mark(seen, 2, "c");
            tags.c = string(dkimLine[vs:ve]);
        } else if (nameHash == keccak256("d")) {
            seen = _mark(seen, 3, "d");
            tags.d = string(dkimLine[vs:ve]);
        } else if (nameHash == keccak256("s")) {
            seen = _mark(seen, 4, "s");
            tags.s = string(dkimLine[vs:ve]);
        } else if (nameHash == keccak256("t")) {
            seen = _mark(seen, 5, "t");
            tags.t = _parseUint64(dkimLine, vs, ve);
        } else if (nameHash == keccak256("bh")) {
            seen = _mark(seen, 6, "bh");
            tags.bhB64 = string(dkimLine[vs:ve]);
        } else if (nameHash == keccak256("l")) {
            seen = _mark(seen, 7, "l");
            tags.hasL = true;
        } else if (nameHash == keccak256("b")) {
            seen = _mark(seen, 8, "b");
            tags.bEmpty = vs == ve;
        }
        // unknown tags: ignored
        return seen;
    }

    function _mark(uint256 seen, uint256 bit, string memory tag) private pure returns (uint256) {
        if (seen & (1 << bit) != 0) revert DuplicateTag(tag);
        return seen | (1 << bit);
    }

    function _isWsp(bytes1 b) private pure returns (bool) {
        return b == 0x20 || b == 0x09;
    }

    /// @dev Strict decimal parse of dkimLine[vs:ve); reverts on empty/non-digit/overflow.
    function _parseUint64(bytes calldata dkimLine, uint256 vs, uint256 ve) private pure returns (uint64) {
        if (vs == ve) revert BadTimestampTag();
        uint256 acc;
        for (uint256 i = vs; i < ve; ++i) {
            uint8 c = uint8(dkimLine[i]);
            if (c < 0x30 || c > 0x39) revert BadTimestampTag();
            acc = acc * 10 + (c - 0x30);
            if (acc > type(uint64).max) revert BadTimestampTag();
        }
        return uint64(acc);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // base64
    // ─────────────────────────────────────────────────────────────────────────

    bytes internal constant B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    /// @notice Standard base64 of a 32-byte value: 44 chars including one '=' pad,
    ///         matching the bh= tag format for SHA-256.
    function base64Encode32(bytes32 value) internal pure returns (string memory) {
        bytes memory out = new bytes(44);
        uint256 o;
        // 30 bytes → 10 full 3-byte groups
        for (uint256 i = 0; i + 3 <= 32; i += 3) {
            uint256 chunk =
                (uint256(uint8(value[i])) << 16) | (uint256(uint8(value[i + 1])) << 8) | uint256(uint8(value[i + 2]));
            out[o++] = B64_ALPHABET[(chunk >> 18) & 0x3f];
            out[o++] = B64_ALPHABET[(chunk >> 12) & 0x3f];
            out[o++] = B64_ALPHABET[(chunk >> 6) & 0x3f];
            out[o++] = B64_ALPHABET[chunk & 0x3f];
        }
        // trailing 2 bytes → 3 chars + '='
        uint256 rest = (uint256(uint8(value[30])) << 16) | (uint256(uint8(value[31])) << 8);
        out[o++] = B64_ALPHABET[(rest >> 18) & 0x3f];
        out[o++] = B64_ALPHABET[(rest >> 12) & 0x3f];
        out[o++] = B64_ALPHABET[(rest >> 6) & 0x3f];
        out[o] = "=";
        return string(out);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Snapshot extraction (quoted-printable state machine)
    // ─────────────────────────────────────────────────────────────────────────

    bytes internal constant ANCHOR = "Manhattan Office Rent";
    bytes internal constant LABEL = "Avg Effective";
    bytes internal constant SUFFIX = "/ SF";
    uint256 internal constant WINDOW = 600; // max decoded bytes between tokens

    /// @dev Extraction stages for the value machine (the anchor counter always runs).
    uint256 private constant ST_WAIT_ANCHOR = 0; // before the first anchor completes
    uint256 private constant ST_WANT_LABEL = 1; // matching "Avg Effective" within WINDOW
    uint256 private constant ST_WANT_DOLLAR = 2; // scanning for '$' within WINDOW
    uint256 private constant ST_SP_BEFORE_NUM = 3; // optional spaces after '$'
    uint256 private constant ST_DOLLARS = 4; // integer digits
    uint256 private constant ST_CENT_1 = 5; // first cent digit
    uint256 private constant ST_CENT_2 = 6; // second cent digit
    uint256 private constant ST_SP_AFTER_NUM = 7; // optional spaces, then SUFFIX
    uint256 private constant ST_SUFFIX = 8; // inside "/ SF"
    uint256 private constant ST_DONE = 9; // value fully parsed
    uint256 private constant ST_FAILED = 10; // pattern broken / window exceeded

    /// @notice Single left-to-right pass over the RAW relaxed-canonical body, decoding
    ///         quoted-printable on the fly and running two matchers on the DECODED
    ///         stream: a global counter of `Manhattan Office Rent` occurrences and a
    ///         value machine that, after the FIRST occurrence, expects `Avg Effective`
    ///         within ≤600 decoded bytes, then `$<digits>.<dd>` within ≤600 more,
    ///         then `/ SF`.
    /// @dev QP decoding: `=\r\n` is a soft break (emits nothing), `=HH` emits the byte,
    ///      anything else after '=' (incl. a trailing lone '=') is a literal '='.
    ///      Both token matchers use naive restart (on mismatch, j := current byte ==
    ///      pattern[0] ? 1 : 0), which equals KMP because neither pattern repeats its
    ///      first byte ('M' / 'A') anywhere else. Window accounting: a token must
    ///      COMPLETE (its last byte emitted) within WINDOW decoded bytes counted from
    ///      the byte after the previous token's last byte.
    ///      A broken pattern or exceeded window parks the machine in ST_FAILED
    ///      (cents = 0 → the oracle rejects); anchor counting continues to the end of
    ///      the body either way so anchorCount is the TOTAL.
    /// @dev Mutable state of the value machine, kept in one memory struct so the hot
    ///      outer loop stays within stack limits.
    struct ValueMachine {
        uint256 stage; // ST_* above
        uint256 budget; // decoded bytes left in the current window
        uint256 lj; // label / suffix match progress
        uint256 dollars; // accumulated integer part
        uint256 cents; // final value once ST_DONE
    }

    /// @return cents Extracted value in cents (0 if not found); always < 2^31.
    /// @return anchorCount Total occurrences of the anchor in the decoded body.
    function extractSnapshot(bytes calldata body) internal pure returns (uint256 cents, uint256 anchorCount) {
        uint256 i; // raw index
        uint256 aj; // anchor match progress
        ValueMachine memory m; // stage = ST_WAIT_ANCHOR

        // Cache pattern bytes once; reading a `bytes constant` re-allocates memory on
        // every access, which would dominate gas in a 100 KB pass.
        bytes memory anchor = ANCHOR;
        bytes memory label = LABEL;
        bytes memory suffix = SUFFIX;

        unchecked {
            uint256 len = body.length;
            while (i < len) {
                // -- fast path: while nothing is being matched (no anchor prefix in
                //    progress, value machine not armed) the only bytes that can matter
                //    are literal 'M' (anchor start) and '=' (QP escapes, incl. =4D).
                //    _skipIdle advances past everything else in assembly; measured on
                //    the 102 KB real fixture this cuts the pass from ~50M gas (plain
                //    solc per-byte calldata indexing) to well under the 3M target. --
                if (aj == 0 && (m.stage == ST_WAIT_ANCHOR || m.stage >= ST_DONE)) {
                    i = _skipIdle(body, i);
                    if (i >= len) break;
                }

                // -- QP decode: produce one decoded byte `b`, or skip a soft break --
                bytes1 b = body[i];
                if (b == "=") {
                    if (i + 2 < len && body[i + 1] == "\r" && body[i + 2] == "\n") {
                        i += 3; // soft line break: no decoded byte
                        continue;
                    }
                    (bool isHex, uint8 decoded) = _tryHexPair(body, i, len);
                    if (isHex) {
                        b = bytes1(decoded);
                        i += 3;
                    } else {
                        // literal '=' (malformed escape or trailing '=')
                        i += 1;
                    }
                } else {
                    i += 1;
                }

                // -- anchor counter (always on) --
                if (b == anchor[aj]) {
                    if (++aj == anchor.length) {
                        ++anchorCount;
                        aj = 0;
                        if (m.stage == ST_WAIT_ANCHOR) {
                            m.stage = ST_WANT_LABEL;
                            m.budget = WINDOW;
                            continue; // this byte finished the anchor; matching resumes next byte
                        }
                    }
                } else {
                    aj = b == anchor[0] ? 1 : 0;
                }

                // -- value machine (only while armed; a finished/failed machine costs
                //    one comparison per byte and the loop keeps running for anchorCount) --
                if (m.stage != ST_WAIT_ANCHOR && m.stage < ST_DONE) {
                    _feedValueMachine(m, b, label, suffix);
                }
            }
        }
        if (m.stage == ST_DONE) cents = m.cents;
    }

    /// @dev Advances the value machine by one DECODED byte. See {extractSnapshot} for
    ///      the grammar; the window budget refreshes each time a token completes.
    function _feedValueMachine(ValueMachine memory m, bytes1 b, bytes memory label, bytes memory suffix) private pure {
        unchecked {
            if (m.budget == 0) {
                m.stage = ST_FAILED;
                return;
            }
            --m.budget;

            uint256 stage = m.stage;
            if (stage == ST_WANT_LABEL) {
                if (b == label[m.lj]) {
                    if (++m.lj == label.length) {
                        m.stage = ST_WANT_DOLLAR;
                        m.budget = WINDOW;
                    }
                } else {
                    m.lj = b == label[0] ? 1 : 0;
                }
            } else if (stage == ST_WANT_DOLLAR) {
                if (b == "$") {
                    m.stage = ST_SP_BEFORE_NUM;
                    m.budget = WINDOW; // the number + suffix get a fresh window after '$'
                }
            } else if (stage == ST_SP_BEFORE_NUM) {
                if (b == " ") return;
                if (b >= "0" && b <= "9") {
                    m.dollars = uint8(b) - 0x30;
                    m.stage = ST_DOLLARS;
                } else {
                    m.stage = ST_FAILED;
                }
            } else if (stage == ST_DOLLARS) {
                if (b >= "0" && b <= "9") {
                    m.dollars = m.dollars * 10 + (uint8(b) - 0x30);
                    // keep cents = dollars*100 + dd < 2^31: floor((2^31-1-99)/100)
                    if (m.dollars > 21_474_835) revert ValueOverflow();
                } else if (b == ".") {
                    m.stage = ST_CENT_1;
                } else {
                    m.stage = ST_FAILED;
                }
            } else if (stage == ST_CENT_1) {
                if (b >= "0" && b <= "9") {
                    m.cents = m.dollars * 100 + (uint8(b) - 0x30) * 10;
                    m.stage = ST_CENT_2;
                } else {
                    m.stage = ST_FAILED;
                }
            } else if (stage == ST_CENT_2) {
                if (b >= "0" && b <= "9") {
                    m.cents += uint8(b) - 0x30;
                    m.stage = ST_SP_AFTER_NUM;
                } else {
                    m.stage = ST_FAILED;
                }
            } else if (stage == ST_SP_AFTER_NUM) {
                if (b == " ") return;
                if (b == suffix[0]) {
                    m.lj = 1;
                    m.stage = ST_SUFFIX;
                } else {
                    m.stage = ST_FAILED;
                }
            } else {
                // ST_SUFFIX: literal "/ SF" -- exactly one internal space (the
                // relaxed-canonical body has collapsed whitespace).
                if (b == suffix[m.lj]) {
                    if (++m.lj == suffix.length) m.stage = ST_DONE;
                } else {
                    m.stage = ST_FAILED;
                }
            }
            if (m.stage == ST_FAILED) m.cents = 0;
        }
    }

    /// @dev Assembly fast path for the IDLE machine state (no anchor prefix in
    ///      progress, value machine unarmed). Advances `i` to the next raw position
    ///      where the reference decoder would produce a decoded 'M' (0x4D — the only
    ///      byte that can start the anchor): either a literal 0x4D or the escape
    ///      `=4D`/`=4d`; or to the end of the body. Returns WITHOUT consuming that
    ///      unit so the Solidity loop re-decodes it. Soundness rests on QP structure:
    ///      0x4D and 0x3D are neither hex digits nor CR/LF, so neither can ever be
    ///      consumed as the interior of an escape — a raw 'M' is always a decoded
    ///      'M', a raw '=' always starts a (possibly invalid) escape, and skipping
    ///      other bytes one at a time cannot desynchronize decoding. Accelerations,
    ///      measured on the 102 KB real fixture (solc's bounds-checked per-byte
    ///      indexing costs 100+ gas/byte — the reason this loop demonstrably needs
    ///      assembly; see docs/TESTING.md gas notes):
    ///        1. whole 32-byte words containing neither 0x3D nor 0x4D are skipped
    ///           with one calldataload + two exact zero-byte-detection masks;
    ///        2. within a flagged word, an MSB binary search jumps straight to the
    ///           first interesting byte;
    ///        3. non-'M' escapes and soft breaks are stepped over without decoding.
    function _skipIdle(bytes calldata body, uint256 i) private pure returns (uint256) {
        assembly ("memory-safe") {
            let off := body.offset
            let len := body.length
            // detection masks (the classic sub/and-not "hasZero" bit trick, 8- and
            // 16-bit granularity). The trick may raise FALSE flags at positions
            // earlier than a true match (borrow propagation), but the FIRST true
            // match is always flagged — and a false stop is harmless: the byte
            // handler below just steps over anything that is not 'M'/'=4D'.
            let ones := 0x0101010101010101010101010101010101010101010101010101010101010101
            let highs := 0x8080808080808080808080808080808080808080808080808080808080808080
            let mPat := 0x4D4D4D4D4D4D4D4D4D4D4D4D4D4D4D4D4D4D4D4D4D4D4D4D4D4D4D4D4D4D4D4D
            let ones16 := 0x0001000100010001000100010001000100010001000100010001000100010001
            let highs16 := 0x8000800080008000800080008000800080008000800080008000800080008000
            let pairPat := 0x3D343D343D343D343D343D343D343D343D343D343D343D343D343D343D343D34

            for {} lt(i, len) {} {
                // Word inspection: the ONLY things that matter in idle state are a
                // literal 'M' (0x4D) and the escape prefix "=4" (0x3D 0x34, the start
                // of =4D/=4d which decodes to 'M'). Soft breaks and all other escapes
                // never stop the scan.
                if lt(add(i, 32), len) {
                    let w := calldataload(add(off, i))
                    // (1) literal 'M' anywhere in the word
                    let x := xor(w, mPat)
                    let mask := and(sub(x, ones), and(not(x), highs))
                    // (2) "=4" at even 16-bit alignment: flag lands on the '=' byte
                    x := xor(w, pairPat)
                    mask := or(mask, and(sub(x, ones16), and(not(x), highs16)))
                    // (3) "=4" at odd alignment: shift the word one byte left and
                    //     detect again; shr(8) maps each flag back to its '=' byte
                    x := xor(shl(8, w), pairPat)
                    mask := or(mask, shr(8, and(sub(x, ones16), and(not(x), highs16))))
                    if iszero(mask) {
                        // no 'M', no "=4" starting in bytes 0..30 → skip 31 bytes
                        // (a pair may START at byte 31 and span into the next word,
                        // so the last byte is re-examined as the next word's byte 0)
                        i := add(i, 31)
                        continue
                    }
                    // Branchless jump to the FIRST (most significant, i.e. lowest
                    // raw offset) flagged byte: 5-step binary search for the most
                    // significant nonzero byte of `mask`.
                    let c := iszero(shr(128, mask))
                    let idx := shl(4, c)
                    mask := shl(shl(7, c), mask)
                    c := iszero(shr(192, mask))
                    idx := add(idx, shl(3, c))
                    mask := shl(shl(6, c), mask)
                    c := iszero(shr(224, mask))
                    idx := add(idx, shl(2, c))
                    mask := shl(shl(5, c), mask)
                    c := iszero(shr(240, mask))
                    idx := add(idx, shl(1, c))
                    mask := shl(shl(4, c), mask)
                    idx := add(idx, iszero(shr(248, mask)))
                    i := add(i, idx)
                }

                let b := byte(0, calldataload(add(off, i)))
                // literal 'M': hand back to the Solidity matcher without consuming.
                // 0x4D can never sit INSIDE an escape ('M' is not a hex digit, not
                // CR/LF), so a raw 0x4D is always a decoded 'M'.
                if eq(b, 0x4D) { break }
                if eq(b, 0x3D) {
                    // In idle state only `=4D` / `=4d` (a QP-encoded 'M') matters.
                    // Every other escape / soft break decodes to a non-'M' byte, and
                    // its constituent bytes (hex digits, CR, LF) can never be 0x4D
                    // themselves — so escape ALIGNMENT is irrelevant here and the
                    // scan may step a single byte instead of decoding.
                    if lt(add(i, 2), len) {
                        if eq(byte(0, calldataload(add(off, add(i, 1)))), 0x34) {
                            let c2 := byte(0, calldataload(add(off, add(i, 2))))
                            // hand `=4D` back unconsumed; the Solidity loop decodes it
                            if or(eq(c2, 0x44), eq(c2, 0x64)) { break }
                        }
                    }
                    i := add(i, 1)
                    continue
                }
                i := add(i, 1)
            }
        }
        return i;
    }

    /// @dev Tries to read `=HH` at raw offset i (i points at '='). Uppercase per RFC 2045;
    ///      lowercase hex accepted too (robustness — the generator emits uppercase).
    function _tryHexPair(bytes calldata body, uint256 i, uint256 len) private pure returns (bool, uint8) {
        unchecked {
            if (i + 2 >= len) return (false, 0);
            (bool ok1, uint8 hi) = _hexVal(uint8(body[i + 1]));
            if (!ok1) return (false, 0);
            (bool ok2, uint8 lo) = _hexVal(uint8(body[i + 2]));
            if (!ok2) return (false, 0);
            return (true, (hi << 4) | lo);
        }
    }

    function _hexVal(uint8 c) private pure returns (bool, uint8) {
        unchecked {
            if (c >= 0x30 && c <= 0x39) return (true, c - 0x30);
            if (c >= 0x41 && c <= 0x46) return (true, c - 0x41 + 10);
            if (c >= 0x61 && c <= 0x66) return (true, c - 0x61 + 10);
            return (false, 0);
        }
    }
}
