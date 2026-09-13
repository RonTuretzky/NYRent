// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

library B {
    struct TagSet {
        bytes32[] keys;
        bytes[] values;
        uint256 count;
    }
    error InvalidBytes();

    function eq(bytes memory a, bytes memory b) internal pure returns (bool) {
        return keccak256(a) == keccak256(b);
    }

    function slice(bytes memory a, uint256 s, uint256 n) internal pure returns (bytes memory r) {
        if (s + n > a.length) {
            revert InvalidBytes();
        }
        r = new bytes(n);
        for (uint256 i; i < n; ++i) {
            r[i] = a[s + i];
        }
    }

    function at(bytes memory a, bytes memory b, uint256 i) internal pure returns (bool) {
        if (i + b.length > a.length) {
            return false;
        }
        for (uint256 j; j < b.length; ++j) {
            if (a[i + j] != b[j]) {
                return false;
            }
        }
        return true;
    }

    function find(bytes memory a, bytes memory b, uint256 start) internal pure returns (uint256) {
        for (uint256 i = start; i + b.length <= a.length; ++i) {
            if (at(a, b, i)) {
                return i;
            }
        }
        return type(uint256).max;
    }

    function trim(bytes memory a) internal pure returns (bytes memory) {
        uint256 s;
        uint256 e = a.length;
        while (s < e && (a[s] == 0x20 || a[s] == 0x09)) {
            ++s;
        }
        while (e > s && (a[e - 1] == 0x20 || a[e - 1] == 0x09)) {
            --e;
        }
        return slice(a, s, e - s);
    }

    function lower(bytes memory a) internal pure returns (bytes memory) {
        for (uint256 i; i < a.length; ++i) {
            if (a[i] >= 0x41 && a[i] <= 0x5a) {
                a[i] = bytes1(uint8(a[i]) + 32);
            }
        }
        return a;
    }

    function uintDec(bytes memory a) internal pure returns (uint256 n) {
        if (a.length == 0 || a.length > 12) {
            revert InvalidBytes();
        }
        for (uint256 i; i < a.length; ++i) {
            if (a[i] < 0x30 || a[i] > 0x39) {
                revert InvalidBytes();
            }
            n = n * 10 + uint8(a[i]) - 48;
        }
    }

    function parseTags(bytes memory value) internal pure returns (TagSet memory set) {
        set.keys = new bytes32[](32);
        set.values = new bytes[](32);
        uint256 p;
        while (p < value.length) {
            uint256 end = find(value, ";", p);
            if (end == type(uint256).max) {
                end = value.length;
            }
            bytes memory part = trim(slice(value, p, end - p));
            p = end + 1;
            if (part.length == 0) {
                continue;
            }
            uint256 sep = find(part, "=", 0);
            if (sep == type(uint256).max) {
                revert InvalidBytes();
            }
            bytes memory key = trim(slice(part, 0, sep));
            if (key.length == 0) {
                revert InvalidBytes();
            }
            for (uint256 j; j < key.length; ++j) {
                if (!((key[j] >= 0x61 && key[j] <= 0x7a) || (key[j] >= 0x30 && key[j] <= 0x39) || key[j] == 0x5f)) {
                    revert InvalidBytes();
                }
            }
            bytes32 h = keccak256(key);
            for (uint256 j; j < set.count; ++j) {
                if (set.keys[j] == h) {
                    revert InvalidBytes();
                }
            }
            if (set.count == 32) {
                revert InvalidBytes();
            }
            set.keys[set.count] = h;
            set.values[set.count++] = trim(slice(part, sep + 1, part.length - sep - 1));
        }
    }

    function get(TagSet memory set, bytes memory key) internal pure returns (bytes memory result, bool present) {
        bytes32 h = keccak256(key);
        for (uint256 i; i < set.count; ++i) {
            if (set.keys[i] == h) {
                return (set.values[i], true);
            }
        }
    }

    function must(TagSet memory set, bytes memory key) internal pure returns (bytes memory r) {
        bool has;
        (r, has) = get(set, key);
        if (!has) {
            revert InvalidBytes();
        }
    }

    function tags(bytes memory value, bytes memory wanted) internal pure returns (bytes memory result, bool present) {
        return get(parseTags(value), wanted);
    }

    function tag(bytes memory a, bytes memory name) internal pure returns (bytes memory r) {
        bool yes;
        (r, yes) = tags(a, name);
        if (!yes) {
            revert InvalidBytes();
        }
    }

    function b64(bytes memory a) internal pure returns (bytes memory out) {
        bytes memory clean = new bytes(a.length);
        uint256 n;
        for (uint256 i; i < a.length; ++i) {
            if (a[i] != 0x20 && a[i] != 0x09 && a[i] != 0x0d && a[i] != 0x0a) {
                clean[n++] = a[i];
            }
        }
        if (n == 0 || n % 4 != 0) {
            revert InvalidBytes();
        }
        uint256 padding = clean[n - 1] == 0x3d ? 1 : 0;
        if (clean[n - 2] == 0x3d) {
            ++padding;
        }
        out = new bytes(n / 4 * 3 - padding);
        uint256 k;
        for (uint256 i; i < n; i += 4) {
            uint256 x;
            for (uint256 j; j < 4; ++j) {
                bytes1 c = clean[i + j];
                uint256 v;
                if (c >= 0x41 && c <= 0x5a) {
                    v = uint8(c) - 65;
                } else if (c >= 0x61 && c <= 0x7a) {
                    v = uint8(c) - 71;
                } else if (c >= 0x30 && c <= 0x39) {
                    v = uint8(c) + 4;
                } else if (c == 0x2b) {
                    v = 62;
                } else if (c == 0x2f) {
                    v = 63;
                } else if (c == 0x3d && i + j >= n - padding) {
                    v = 0;
                } else {
                    revert InvalidBytes();
                }
                x = (x << 6) | v;
            }
            if (i + 4 == n && ((padding == 1 && x & 0xff != 0) || (padding == 2 && x & 0xffff != 0))) {
                revert InvalidBytes();
            }
            if (k < out.length) {
                out[k++] = bytes1(uint8(x >> 16));
            }
            if (k < out.length) {
                out[k++] = bytes1(uint8(x >> 8));
            }
            if (k < out.length) {
                out[k++] = bytes1(uint8(x));
            }
        }
    }

    function dns(bytes memory a) internal pure returns (bytes memory out) {
        if (a.length == 0 || a.length > 253) {
            revert InvalidBytes();
        }
        out = new bytes(a.length + 2);
        uint256 start;
        uint256 pos;
        for (uint256 i; i <= a.length; ++i) {
            if (i == a.length || a[i] == 0x2e) {
                uint256 len = i - start;
                if (len == 0 || len > 63) {
                    revert InvalidBytes();
                }
                out[pos++] = bytes1(uint8(len));
                for (uint256 j = start; j < i; ++j) {
                    bytes1 c = a[j];
                    if (!((c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c == 0x2d || c == 0x5f)) {
                        revert InvalidBytes();
                    }
                    out[pos++] = c;
                }
                start = i + 1;
            }
        }
        out[pos] = 0x00;
    }
}
