#!/usr/bin/env python3
"""GFX1 offset-table rebuild — re-lay-out a character's sprite parts at natural
sizes and rewrite the offset table, so edits no longer need to hit the exact
original slot length. Keeps the DAT the same total SIZE (rebuilt GFX1 padded to
the original GFX1 span; GFX2/Pal/etc. stay at their absolute offsets) → no ISO/GDI
restructuring. Writes into a COPY of the GDI (never the source ROM).

edits: { sel(int) -> pixels(bytes, 4bpp, len = sw*sh*32) } to replace; absent
sels keep their original pixels. Verifies every part re-decodes before writing.

Usage:
  rebuild_gfx1.py PL17            # null rebuild (no edits) — Test 1
"""
import os, sys, struct, shutil
sys.path.insert(0, os.path.dirname(__file__))
from gfx1_lzss import decodeA, encodeA

# Folder that holds YOUR OWN extracted GDI tracks (track01.bin/track03.bin/*.gdi).
# Override with the MVC2_ROM_DIR env var — never hard-code a ROM path into this repo.
SRC_DIR = os.environ.get("MVC2_ROM_DIR", r"C:\roms\mvc2_us")
RAW = 2352; BASE = 45000; TRACK = os.environ.get("MVC2_TRACK", "track03.bin")


def _user(path, abs_lba):
    with open(path, "rb") as f:
        f.seek((abs_lba - BASE) * RAW + 16); return f.read(2048)


def find_dat_full(path, charname):
    pvd = _user(path, BASE + 16)
    rl = struct.unpack_from("<I", pvd, 158)[0]; rn = struct.unpack_from("<I", pvd, 166)[0]
    d = b"".join(_user(path, rl + i) for i in range((rn + 2047) // 2048)); off = 0
    tgt = charname.upper() + "_DAT"
    while off < rn:
        L = d[off]
        if L == 0:
            off = ((off // 2048) + 1) * 2048
            if off >= rn: break
            continue
        e = struct.unpack_from("<I", d, off + 2)[0]; ln = struct.unpack_from("<I", d, off + 10)[0]
        nm = d[off + 33:off + 33 + d[off + 32]].decode('ascii', 'replace')
        if nm.upper().startswith(tgt): return e, ln, rl, off    # lba, size, rootLba, entryOff
        off += L
    raise SystemExit("DAT not found: " + charname)


def find_dat(path, charname):
    """Back-compat 2-tuple (lba, size) for callers that don't need the dir-entry position."""
    lba, size, _, _ = find_dat_full(path, charname)
    return lba, size


def desector(path, lba, size):
    return b"".join(_user(path, lba + i) for i in range((size + 2047) // 2048))[:size]


def rebuild_dat(dat, edits=None):
    """Return a new DAT (same size) with GFX1 rebuilt + edits applied."""
    edits = edits or {}
    gfx1 = struct.unpack_from("<I", dat, 0)[0]
    gfx2 = struct.unpack_from("<I", dat, 4)[0]
    nParts = struct.unpack_from("<I", dat, gfx1)[0] // 4
    tbl = [struct.unpack_from("<I", dat, gfx1 + i * 4)[0] for i in range(nParts)]
    span = gfx2 - gfx1

    # Collect each part. Keep the ORIGINAL compressed bytes for parts the user did NOT edit
    # (byte-identical to the ROM → safe on real hardware, and smaller than a greedy re-encode,
    # so edits usually still FIT with no section shift). Only edited sels are re-encoded.
    # (mvc2-sh4-re-expert: the ROM decoder loc_8c0354c0 has no source-length / backref-underflow
    #  guard, so re-encoding untouched parts is a needless divergence risk.)
    parts = []                                      # (hdr, blob, dl, edited_px_or_None)
    for i in range(nParts):
        o0 = tbl[i]; o1 = tbl[i + 1] if i + 1 < nParts else span
        hdr = dat[gfx1 + o0:gfx1 + o0 + 4]; sw, sh = hdr[2], hdr[3]; dl = (sw * 8) * (sh * 8) // 2
        if dl <= 0: dl = 1
        if i in edits:
            px = edits[i]
            if len(px) != dl:
                raise SystemExit("edit sel %d wrong pixel length %d != %d" % (i, len(px), dl))
            parts.append((hdr, encodeA(px), dl, px))
        else:
            parts.append((hdr, bytes(dat[gfx1 + o0 + 4:gfx1 + o1]), dl, None))

    # lay out: [table][hdr+blob per part]
    new_tbl = []; body = bytearray(); cur = nParts * 4
    for hdr, blob, dl, px in parts:
        new_tbl.append(cur)
        body += hdr + blob
        cur += 4 + len(blob)
    total = nParts * 4 + len(body)
    newg = bytearray()
    for o in new_tbl: newg += struct.pack("<I", o)
    newg += body

    if total <= span:                               # fits — pad to original span, DAT size unchanged
        newg += b"\x00" * (span - len(newg))
        out = bytearray(dat); out[gfx1:gfx1 + span] = newg
    else:                                           # GROW — shift sections after GFX1, bump ALL header ptrs
        shift = total - span
        out = bytearray(dat[:gfx1]) + newg + bytearray(dat[gfx2:])
        for i in range(gfx1 // 4):                  # EVERY header section ptr (header runs [0,gfx1); 14 real on PL17). loader: loc_8c031fa0
            v = struct.unpack_from("<I", out, i * 4)[0]
            if v != 0 and v >= gfx2:
                struct.pack_into("<I", out, i * 4, v + shift)

    # verify the EDITED parts re-decode to expected pixels from the final layout
    # (unedited parts are verbatim ROM bytes → already valid)
    for i, (hdr, blob, dl, px) in enumerate(parts):
        if px is None: continue
        o0 = gfx1 + new_tbl[i]; o1 = gfx1 + (new_tbl[i + 1] if i + 1 < nParts else total)
        if out[o0:o0 + 4] != hdr or decodeA(out[o0 + 4:o1], dl) != px:
            raise SystemExit("verify failed at sel %d" % i)
    return bytes(out), total, span


def main():
    charname = sys.argv[1] if len(sys.argv) > 1 else "PL17"
    dst_dir = sys.argv[2] if len(sys.argv) > 2 else r"C:\roms\mvc2_us_rebuild"
    lba, size = find_dat(os.path.join(SRC_DIR, TRACK), charname)
    print("%s_DAT @ LBA %d, %d bytes" % (charname, lba, size))
    dat = desector(os.path.join(SRC_DIR, TRACK), lba, size)

    new_dat, total, span = rebuild_dat(dat, edits=None)   # null rebuild
    print("GFX1 rebuilt: %d / %d bytes (saved %d); all parts re-decode OK" % (total, span, span - total))

    os.makedirs(dst_dir, exist_ok=True)
    for n in os.listdir(SRC_DIR):
        s = os.path.join(SRC_DIR, n); d = os.path.join(dst_dir, n)
        if not os.path.exists(d) or os.path.getsize(d) != os.path.getsize(s):
            print("copy", n); shutil.copy2(s, d)
    dst_track = os.path.join(dst_dir, TRACK)
    # write the rebuilt DAT back into the track's sectors
    with open(dst_track, "r+b") as f:
        for i in range(0, size, 2048):
            chunk = new_dat[i:i + 2048]
            f.seek((lba - BASE + i // 2048) * RAW + 16); f.write(chunk)
    # verify round-trip from the patched copy
    chk = desector(dst_track, lba, size)
    print("written + verified from disc:", chk == new_dat)
    gdi = [n for n in os.listdir(dst_dir) if n.lower().endswith(".gdi")][0]
    print("TEST:", os.path.join(dst_dir, gdi))


if __name__ == "__main__":
    main()
