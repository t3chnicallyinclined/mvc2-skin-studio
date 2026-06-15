#!/usr/bin/env python3
"""GFX1 LZSS codec — the MVC2 part compressor + decompressor.

The decoder is the byte-exact port of loc_8c0354c0 (== decodeA in
extract_gfx1_atlas.py): an 8-bit MSB-first flag byte; per bit, CLEAR=literal
(copy 1 src byte), SET=back-ref (1 byte b: dist=b>>4 [0..15], count=(b&0x0F)+2
[2..17], copied from dest-(dist+1)). The output buffer IS the window
(self-contained per part), so overlapping copies act as RLE.

encodeA() is the inverse: a greedy matcher over the 16-byte window producing a
stream the game's decoder accepts. Verified by round-trip against decodeA.
"""

# ---- decoder (byte-exact port of loc_8c0354c0 / extract_gfx1_atlas.decodeA) ----
def decodeA(src, dest_len):
    out = bytearray()
    sp = 0; bc = 0; flags = 0; n = len(src)
    while len(out) < dest_len and sp < n:
        if bc == 0:
            flags = src[sp]; sp += 1; bc = 0x80
            if sp >= n:
                break
        if (flags & bc) == 0:                       # literal
            out.append(src[sp]); sp += 1
        else:                                       # back-ref
            b = src[sp]; sp += 1
            srcpos = len(out) - (b >> 4) - 1
            for _ in range((b & 0x0F) + 2):
                out.append(out[srcpos] if 0 <= srcpos < len(out) else 0)
                srcpos += 1
        bc >>= 1
    if len(out) < dest_len:
        out.extend(b"\x00" * (dest_len - len(out)))
    return bytes(out[:dest_len])


# ---- encoder (greedy LZSS, window=16, match len 2..17) ----
def encodeA(data):
    out = bytearray()
    i = 0; n = len(data)
    while i < n:
        flag_pos = len(out)
        out.append(0)                               # placeholder flag byte
        flags = 0
        for bit in range(8):
            if i >= n:
                break
            bc = 0x80 >> bit
            best_len = 0; best_start = 0
            # candidate lookback distances: (dist+1) in 1..16  ->  start = i-(dist+1)
            # Iterate LARGEST distance first (start=lo upward) and keep the longest match,
            # so among equal-length matches we pick the FARTHEST. The real decoder
            # (loc_8c0354c0) mishandles repeated dist=0 RLE runs that a "nearest match"
            # greedy emits — the ROM only uses dist=0 to bootstrap, then dist=15. Matching
            # that strategy keeps our stream in the token distribution the ROM produces.
            lo = max(0, i - 16)
            for start in range(lo, i):
                period = i - start                  # = dist+1, in 1..16
                l = 0
                while l < 17 and i + l < n and data[i + l] == data[start + (l % period)]:
                    l += 1
                if l > best_len:
                    best_len = l; best_start = start
                    if l == 17:
                        break
            if best_len >= 2:                        # back-ref
                flags |= bc
                dist = i - best_start - 1            # 0..15
                out.append((dist << 4) | ((best_len - 2) & 0x0F))
                i += best_len
            else:                                    # literal
                out.append(data[i]); i += 1
        out[flag_pos] = flags
    return bytes(out)


# ---- self-test: round-trip encode->decode == identity ----
if __name__ == "__main__":
    import os, sys, random
    rng = random.Random(1234)
    cases = []
    # random buffers across sizes + alphabets (stresses literals, matches, RLE)
    for _ in range(400):
        size = rng.randint(0, 600)
        alpha = rng.choice([2, 4, 16, 256])
        cases.append(bytes(rng.randrange(alpha) for _ in range(size)))
    # pathological: all-same (max RLE), ramps, the empty buffer
    cases += [b"", b"\x00" * 512, bytes(range(256)) * 2,
              b"\xAB\xCD" * 200, bytes([7]) * 17, bytes([7]) * 18]
    ok = 0; worst = 0.0
    for d in cases:
        enc = encodeA(d)
        dec = decodeA(enc, len(d))
        assert dec == d, "ROUND-TRIP MISMATCH len=%d" % len(d)
        if d:
            worst = max(worst, len(enc) / len(d))
        ok += 1
    print("round-trip OK: %d/%d cases" % (ok, len(cases)))
    print("worst expansion ratio: %.4fx (all-literal bound = 1.1250x)" % worst)

    # optional: round-trip a real part blob from a decoded-length argument
    # usage: gfx1_lzss.py <blob_file> <dest_len>
    if len(sys.argv) == 3 and os.path.exists(sys.argv[1]):
        blob = open(sys.argv[1], "rb").read()
        dlen = int(sys.argv[2])
        pixels = decodeA(blob, dlen)
        re_enc = encodeA(pixels)
        re_dec = decodeA(re_enc, dlen)
        print("real part: orig blob=%d, decoded=%d, re-encoded=%d, re-decode matches=%s"
              % (len(blob), dlen, len(re_enc), re_dec == pixels))
